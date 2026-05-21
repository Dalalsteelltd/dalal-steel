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
    const qcPromises = Object.entries(PROJECT_TABLES).map(async ([project, table]) => {
      try {
        const records = await fetchAirtableAll(table, {
          fields: [
            'Operation Inspection Result',
            'Operation Inspection Results',
            'Status',
            'Created Time',
            'Date'
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

    // ── Funnel: total units at each stage. "Welded" counts every welded unit
    // regardless of inspection result (rework / rejects are still welding
    // work that happened — quality is shown separately in the QC trend).
    // "Painted" sums Quantity Completed across all batches, so partial work
    // is counted instead of waiting for the whole batch to be Completed.
    // Loading distinguishes "loaded" (left the facility) from "delivered".
    let weldedTotal = 0, paintedTotal = 0, loadedTotal = 0, deliveredTotal = 0;
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
      if (status === 'Loaded' || status === 'Delivered') loadedTotal += qty;
      if (status === 'Delivered') deliveredTotal += qty;
    });

    // ── 7-day throughput: per-day welded / painted / loaded units. Same
    // counting rules as the funnel so the daily series sums to the totals.
    const empty7 = () => days.map(d => ({ date: d, value: 0 }));
    const weldedSeries = empty7();
    const paintedSeries = empty7();
    const loadedSeries = empty7();
    const dayIdx = Object.create(null);
    days.forEach((d, i) => { dayIdx[d] = i; });

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
      if (status !== 'Loaded' && status !== 'Delivered') return;
      const k = dayKey(f['Loading Date']);
      if (k in dayIdx) loadedSeries[dayIdx[k]].value += Number(f['Total Quantity']) || 0;
    });

    // ── Active projects (last 7 days): rank by total units the project
    // touched in the window. No status filter — "active" means activity, not
    // necessarily completed work. A project with five In-Progress paint
    // batches and a Pending loading batch should still show as active.
    const activity = Object.create(null);
    Object.keys(PROJECT_TABLES).forEach(p => {
      activity[p] = { project: p, welded: 0, painted: 0, loaded: 0 };
    });
    const windowEnd = days[days.length - 1];
    const inWindow = k => k && k >= windowStart && k <= windowEnd;
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
      .map(p => ({ ...p, total: p.welded + p.painted + p.loaded }))
      .filter(p => p.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);

    // ── Quality trend: per-day QC pass rate, derived from records whose
    // Created Time (or Date) falls in the 7-day window.
    const qualityByDay = days.map(d => ({ date: d, total: 0, passed: 0 }));
    qcResults.forEach(({ records }) => {
      records.forEach(rec => {
        const f = rec.fields || {};
        const k = dayKey(f['Created Time'] || f['Date'] || rec.createdTime);
        if (!(k in dayIdx)) return;
        const status = f['Operation Inspection Result']
                    || f['Operation Inspection Results']
                    || f['Status']
                    || '';
        // Only counted records (pass or fail) contribute. Blank/in-progress
        // skip so the rate isn't dragged toward 0 by yet-to-be-judged work.
        if (QC_PASS.has(status)) {
          qualityByDay[dayIdx[k]].total++;
          qualityByDay[dayIdx[k]].passed++;
        } else if (QC_FAIL.has(status)) {
          qualityByDay[dayIdx[k]].total++;
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

    const payload = {
      generatedAt: new Date().toISOString(),
      window: { start: windowStart, end: days[days.length - 1], days },
      funnel: {
        welded: weldedTotal,
        painted: paintedTotal,
        loaded: loadedTotal,
        delivered: deliveredTotal
      },
      throughput: {
        welded: weldedSeries,
        painted: paintedSeries,
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
