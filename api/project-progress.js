// api/project-progress.js — Per-project stage % rollup computed live from Airtable.
// Cookie-protected by dsi_mgr (same as /api/dashboard-data).
//
// The previous Airtable-derived rollup in dashboard-data.js was unreliable
// because each table was fetched with a single 100-record page. This endpoint
// uses fetchAirtableAll to walk pagination so the numerators are accurate, and
// divides by a per-project BOM total (totalBeams in public/projects.json) for
// the denominator. Once totals are filled in, the dashboard is fully live with
// zero manual maintenance.

const fs = require('fs');
const path = require('path');
const {
  PROJECT_TABLES,
  verifyDashboardCookie,
  fetchAirtableAll
} = require('../lib/dashboard-helpers');

const QC_PASS = new Set(['Accepted', 'Passed']);

// 30s cache matches /api/dashboard-data so the dashboard's auto-refresh cycle
// doesn't fan out into 13+ Airtable scans per poll.
const CACHE_TTL_MS = 30_000;
let CACHE = { payload: null, builtAt: 0 };

let PROJECT_META = null;
function loadProjectMeta() {
  if (PROJECT_META) return PROJECT_META;
  const file = path.join(process.cwd(), 'public', 'projects.json');
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  PROJECT_META = {};
  (parsed.projects || []).forEach(p => {
    PROJECT_META[p.id] = { name: p.name || p.id, totalBeams: Number(p.totalBeams) || 0 };
  });
  return PROJECT_META;
}

// Compute stage percentage. Returns null (not 0) when totalBeams is unset so
// the dashboard renders an em-dash rather than misleadingly showing 0%.
function pct(numerator, totalBeams) {
  if (!totalBeams || totalBeams <= 0) return null;
  const v = (Number(numerator) || 0) / totalBeams * 100;
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!verifyDashboardCookie(req)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const now = Date.now();
  const force = req.query && (req.query.fresh === '1' || req.query.nocache === '1');
  if (!force && CACHE.payload && now - CACHE.builtAt < CACHE_TTL_MS) {
    return res.status(200).json({
      ...CACHE.payload,
      fromCache: true,
      cacheAgeMs: now - CACHE.builtAt
    });
  }

  try {
    const meta = loadProjectMeta();

    // ── QC: for each project's table, count records that passed QC.
    // We only need the result field, not the whole record, so request just it.
    const qcPromises = Object.entries(PROJECT_TABLES).map(async ([project, table]) => {
      try {
        const records = await fetchAirtableAll(table, {
          fields: ['Operation Inspection Result', 'Operation Inspection Results', 'Status']
        });
        let passed = 0;
        records.forEach(rec => {
          const f = rec.fields || {};
          const status = f['Operation Inspection Result']
                      || f['Operation Inspection Results']
                      || f['Status']
                      || '';
          if (QC_PASS.has(status)) passed++;
        });
        return { project, qcPassed: passed, qcCount: records.length };
      } catch (e) {
        return { project, qcPassed: 0, qcCount: 0, error: e.message };
      }
    });

    // ── Welding / Painting / Loading: pull all batch rows once, bucket by Project.
    const [qcResults, weldingRecords, paintingRecords] = await Promise.all([
      Promise.all(qcPromises),
      fetchAirtableAll('Welding_Batches', {
        fields: ['Project', 'Total Quantity', 'Inspection Result']
      }).catch(() => []),
      fetchAirtableAll('Painting_Batches', {
        fields: ['Project', 'Quantity Completed', 'Coating Status']
      }).catch(() => [])
    ]);

    const byProject = Object.create(null);
    Object.keys(meta).forEach(id => {
      byProject[id] = { welded: 0, painted: 0 };
    });
    weldingRecords.forEach(rec => {
      const f = rec.fields || {};
      const p = f['Project'];
      if (!byProject[p]) return;
      if (f['Inspection Result'] === 'Accepted') {
        byProject[p].welded += Number(f['Total Quantity']) || 0;
      }
    });
    paintingRecords.forEach(rec => {
      const f = rec.fields || {};
      const p = f['Project'];
      if (!byProject[p]) return;
      if (f['Coating Status'] === 'Completed') {
        byProject[p].painted += Number(f['Quantity Completed']) || 0;
      }
    });

    const projects = qcResults.map(({ project, qcPassed }) => {
      const m = meta[project] || { name: project, totalBeams: 0 };
      const total = m.totalBeams;
      const qc = pct(qcPassed, total);
      const welding = pct(byProject[project] ? byProject[project].welded : 0, total);
      const painting = pct(byProject[project] ? byProject[project].painted : 0, total);
      // Overall = simple average of the three stages. Stages without a target
      // (null) are skipped so the average isn't dragged toward 0 by unset BOM.
      const stages = [qc, welding, painting].filter(v => v !== null);
      const overall = stages.length
        ? Math.round((stages.reduce((a, b) => a + b, 0) / stages.length) * 10) / 10
        : null;
      return {
        project,
        name: m.name,
        totalBeams: total,
        qc,
        welding,
        painting,
        overall
      };
    });

    const payload = {
      generatedAt: new Date().toISOString(),
      projects
    };
    CACHE = { payload, builtAt: Date.now() };
    return res.status(200).json({ ...payload, fromCache: false, cacheAgeMs: 0 });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
