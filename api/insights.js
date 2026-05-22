// api/insights.js — Management insights for the manager dashboard.
// Cookie-protected by dsi_mgr (same as /api/dashboard-data).
//
// Returns four datasets, all computed live from Airtable with full pagination:
//   • funnel:      total units at each production stage (welded/painted/
//                  loaded/delivered) so bottlenecks show as drop-offs
//   • throughput:  per-day units processed in each stage over the last 7 days
//   • activeProjects: projects ranked by recent (last 7d) unit activity
//   • quality:     per-day QC pass rate over the last 7 days
//
// No manual data entry anywhere — all metrics derive from existing Airtable
// records. Pagination is unbounded (via fetchAirtableAll) so QC counts and
// per-project totals are no longer truncated at 100 records.

const {
  PROJECT_TABLES,
  verifyDashboardCookie,
  fetchAirtableAll
} = require('../lib/dashboard-helpers');

const QC_PASS = new Set(['Accepted', 'Passed']);
const QC_FAIL = new Set(['Rejected', 'Failed']);

const CACHE_TTL_MS = 30_000;
let CACHE = { payload: null, builtAt: 0 };

// Build the rolling 7-day window of YYYY-MM-DD strings, oldest first, in UTC.
// UTC keeps Vercel (any region) and Airtable's stored dates aligned — using
// local time would shift bucket boundaries each redeploy.
function last7Days() {
  const days = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

// Extract a YYYY-MM-DD prefix from whatever Airtable returns. Forms use
// <input type="datetime-local"> which produces "2026-05-21T14:30" — the
// first 10 chars are the right date. Airtable's own metadata fields use
// "2026-05-21T08:23:00.000Z". Both fall into the fast path. The Date()
// fallback handles any other format (US-style, localized, etc.) defensively.
function dayKey(value) {
  if (!value) return '';
  const s = String(value).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
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
    const days = last7Days();
    const windowStart = days[0];

    // ── QC: scan all 13 project tables in parallel. We need every record so
    // pass-rate trends use the full history, not just the most-recent 100.
    // Worktype is included so the funnel / throughput / active-projects views
    // can break QC activity down into Assembly, Fabrication and CO2 Welding
    // (stored as worktype "Welding" — i.e. the manual CO2 step that precedes
    // robotic welding).
    const qcPromises = Object.entries(PROJECT_TABLES).map(async ([project, table]) => {
      try {
        const records = await fetchAirtableAll(table, {
          fields: [
            'Operation Inspection Result',
            'Operation Inspection Results',
            'Status',
            'Created Time',
            'Date',
            'Worktype',
            'Work Type'
          ]
        });
        return { project, records };
      } catch (e) {
        // Some legacy QC tables lack the requested fields; retry without the
        // fields filter rather than dropping the project entirely.
        try {
          const records = await fetchAirtableAll(table, {});
          return { project, records };
        } catch (e2) {
          return { project, records: [], error: e2.message };
        }
      }
    });

    const [qcResults, welding, painting, loading] = await Promise.all([
      Promise.all(qcPromises),
      fetchAirtableAll('Welding_Batches', {
        fields: ['Project', 'Total Quantity', 'Inspection Result', 'Weld Date']
      }).catch(() => []),
      fetchAirtableAll('Painting_Batches', {
        fields: ['Project', 'Total Quantity', 'Quantity Completed', 'Coating Status', 'Completion Date']
      }).catch(() => []),
      fetchAirtableAll('Loading_Batches', {
        fields: ['Project', 'Total Quantity', 'Loading Status', 'Loading Date']
      }).catch(() => [])
    ]);

    // Shared 7-day window helpers used by every section below.
    const empty7 = () => days.map(d => ({ date: d, value: 0 }));
    const dayIdx = Object.create(null);
    days.forEach((d, i) => { dayIdx[d] = i; });
    const windowEnd = days[days.length - 1];
    const inWindow = k => k && k >= windowStart && k <= windowEnd;

    // Initialise per-project activity buckets up front so QC + production
    // passes can both write into the same structure.
    const activity = Object.create(null);
    Object.keys(PROJECT_TABLES).forEach(p => {
      activity[p] = {
        project: p,
        qcAssembly: 0, qcFabrication: 0, qcWelding: 0,
        welded: 0, painted: 0, loaded: 0
      };
    });

    // ── QC pass: iterate every QC record once and fan out to the four QC-
    // derived datasets (funnel totals, daily throughput series, per-project
    // activity, quality trend). One pass is much cheaper than four since
    // qcResults can be tens of thousands of records across 13 tables.
    let qcAssemblyTotal = 0, qcFabricationTotal = 0, qcWeldingTotal = 0;
    const qcAssemblySeries = empty7();
    const qcFabricationSeries = empty7();
    const qcWeldingSeries = empty7();
    const qualityByDay = days.map(d => ({ date: d, total: 0, passed: 0 }));

    qcResults.forEach(({ project, records }) => {
      records.forEach(rec => {
        const f = rec.fields || {};
        const wt = String(f['Worktype'] || f['Work Type'] || '').trim();

        // Funnel totals are all-time so the manager sees cumulative QC volume
        // alongside cumulative production output.
        if (wt === 'Assembly') qcAssemblyTotal++;
        else if (wt === 'Fabrication') qcFabricationTotal++;
        else if (wt === 'Welding') qcWeldingTotal++; // CO2/manual welding stage

        const k = dayKey(f['Created Time'] || f['Date'] || rec.createdTime);
        if (k in dayIdx) {
          const i = dayIdx[k];
          if (wt === 'Assembly') qcAssemblySeries[i].value++;
          else if (wt === 'Fabrication') qcFabricationSeries[i].value++;
          else if (wt === 'Welding') qcWeldingSeries[i].value++;

          const status = f['Operation Inspection Result']
                      || f['Operation Inspection Results']
                      || f['Status']
                      || '';
          if (QC_PASS.has(status)) { qualityByDay[i].total++; qualityByDay[i].passed++; }
          else if (QC_FAIL.has(status)) { qualityByDay[i].total++; }
        }

        if (inWindow(k) && activity[project]) {
          if (wt === 'Assembly') activity[project].qcAssembly++;
          else if (wt === 'Fabrication') activity[project].qcFabrication++;
          else if (wt === 'Welding') activity[project].qcWelding++;
        }
      });
    });

    const qualitySeries = qualityByDay.map(d => ({
      date: d.date,
      total: d.total,
      passed: d.passed,
      // null when no inspections that day → frontend shows a gap rather than
      // plotting a misleading 0% (no data ≠ everything failed).
      passRate: d.total > 0 ? Math.round((d.passed / d.total) * 1000) / 10 : null
    }));

    // ── Funnel: total units at each production stage. "Welded" counts every
    // welded unit regardless of inspection result (rework / rejects are still
    // welding work that happened — quality is shown separately in the QC
    // trend). "Painted" sums Quantity Completed across all batches, so
    // partial work is counted instead of waiting for batches to be Completed.
    // "Pending Loading" surfaces the queue of finished-paint units staged for
    // dispatch (auto-created when painting completes); Loaded/Delivered cover
    // post-dispatch state.
    let weldedTotal = 0, paintedTotal = 0, pendingLoadingTotal = 0, loadedTotal = 0, deliveredTotal = 0;
    welding.forEach(rec => {
      const f = rec.fields || {};
      weldedTotal += Number(f['Total Quantity']) || 0;
    });
    painting.forEach(rec => {
      const f = rec.fields || {};
      paintedTotal += Number(f['Quantity Completed']) || 0;
    });
    loading.forEach(rec => {
      const f = rec.fields || {};
      const status = f['Loading Status'];
      const qty = Number(f['Total Quantity']) || 0;
      if (status === 'Pending') pendingLoadingTotal += qty;
      if (status === 'Loaded' || status === 'Delivered') loadedTotal += qty;
      if (status === 'Delivered') deliveredTotal += qty;
    });

    // ── 7-day throughput: per-day production units. Same counting rules as
    // the funnel so the daily series sums up to the cumulative totals.
    const weldedSeries = empty7();
    const paintedSeries = empty7();
    const pendingLoadingSeries = empty7();
    const loadedSeries = empty7();

    welding.forEach(rec => {
      const f = rec.fields || {};
      const k = dayKey(f['Weld Date']);
      if (k in dayIdx) weldedSeries[dayIdx[k]].value += Number(f['Total Quantity']) || 0;
    });
    painting.forEach(rec => {
      const f = rec.fields || {};
      const k = dayKey(f['Completion Date']);
      if (k in dayIdx) paintedSeries[dayIdx[k]].value += Number(f['Quantity Completed']) || 0;
    });
    loading.forEach(rec => {
      const f = rec.fields || {};
      const status = f['Loading Status'];
      const k = dayKey(f['Loading Date']);
      if (!(k in dayIdx)) return;
      const qty = Number(f['Total Quantity']) || 0;
      if (status === 'Pending') pendingLoadingSeries[dayIdx[k]].value += qty;
      else if (status === 'Loaded' || status === 'Delivered') loadedSeries[dayIdx[k]].value += qty;
    });

    // ── Active projects (last 7 days): rank by total activity in the window
    // (QC inspections + welded/painted/loaded units). No status filter on
    // production — "active" means activity, not necessarily completed work.
    // A project with five In-Progress paint batches still shows as active.
    const bumpActive = (recs, qtyField, dateField, key) => {
      recs.forEach(rec => {
        const f = rec.fields || {};
        if (!inWindow(dayKey(f[dateField]))) return;
        const p = f['Project'];
        if (!activity[p]) return;
        activity[p][key] += Number(f[qtyField]) || 0;
      });
    };
    bumpActive(welding, 'Total Quantity', 'Weld Date', 'welded');
    bumpActive(painting, 'Quantity Completed', 'Completion Date', 'painted');
    bumpActive(loading, 'Total Quantity', 'Loading Date', 'loaded');

    const activeProjects = Object.values(activity)
      .map(p => ({
        ...p,
        total: p.qcAssembly + p.qcFabrication + p.qcWelding + p.welded + p.painted + p.loaded
      }))
      .filter(p => p.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);

    const payload = {
      generatedAt: new Date().toISOString(),
      window: { start: windowStart, end: windowEnd, days },
      funnel: {
        qcAssembly: qcAssemblyTotal,
        qcFabrication: qcFabricationTotal,
        qcWelding: qcWeldingTotal, // CO2 / manual welding inspections
        welded: weldedTotal,
        painted: paintedTotal,
        pendingLoading: pendingLoadingTotal,
        loaded: loadedTotal,
        delivered: deliveredTotal
      },
      throughput: {
        qcAssembly: qcAssemblySeries,
        qcFabrication: qcFabricationSeries,
        qcWelding: qcWeldingSeries,
        welded: weldedSeries,
        painted: paintedSeries,
        pendingLoading: pendingLoadingSeries,
        loaded: loadedSeries
      },
      activeProjects,
      quality: qualitySeries
    };
    CACHE = { payload, builtAt: Date.now() };
    return res.status(200).json({ ...payload, fromCache: false, cacheAgeMs: 0 });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
