// api/dashboard-data.js — Aggregated KPIs for the manager dashboard.
// Cookie-protected by dsi_mgr (issued by /api/dashboard-login).
// Reads QC tables per-project + Loading_Batches + Painting_Batches + Welding_Batches.

const { PROJECT_TABLES, verifyDashboardCookie, fetchAirtable } = require('../lib/dashboard-helpers');

const QC_PASS = new Set(['Accepted', 'Passed']);
const QC_FAIL = new Set(['Rejected', 'Failed']);

// Pull a single attachment URL out of an Airtable attachments field.
function firstAttachmentUrl(value) {
  if (!Array.isArray(value) || !value.length) return '';
  const a = value[0];
  return (a && (a.url || (a.thumbnails && a.thumbnails.large && a.thumbnails.large.url))) || '';
}

// Normalise a QC record across the various per-project schemas so the dashboard
// can show a single "Recent QC" feed regardless of which table it came from.
function normaliseQcRecord(rec, project) {
  const f = rec.fields || {};
  const result = f['Operation Inspection Result']
              || f['Operation Inspection Results']
              || f['Status']
              || '';
  return {
    id: rec.id,
    project,
    // The "Created Time" formula field is missing on a few legacy QC tables
    // (test / spn001 / spn015). Fall back to the user-set Date, then to the
    // record-level createdTime metadata that Airtable always supplies.
    createdTime: f['Created Time'] || f['Date'] || rec.createdTime || '',
    inspectionId: f['Inspection ID'] || f['INSPECTION ID'] || '',
    beamUid: f['Beam UID'] || f['BEAM UID'] || '',
    worktype: f['Worktype'] || f['Work Type'] || '',
    result,
    inspector: f['Inspector Name'] || f['Submitted By'] || '',
    nonConformance: f['Non-Conformance']
                 || f['Non- Conformance and Corrective Action (NCR/CAPA)']
                 || f['Notes']
                 || '',
    imageUrl: firstAttachmentUrl(f['Image']) || firstAttachmentUrl(f['Photo'])
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!verifyDashboardCookie(req)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // ── QC: fetch up to 100 most recent rows per project table in parallel.
    const qcPromises = Object.entries(PROJECT_TABLES).map(async ([project, table]) => {
      try {
        const records = await fetchAirtable(table, {
          pageSize: 100,
          'sort[0][field]': 'Created Time',
          'sort[0][direction]': 'desc'
        });
        return { project, table, records };
      } catch (e) {
        // Some QC tables (e.g. older ones) may not have a 'Created Time' field.
        try {
          const records = await fetchAirtable(table, { pageSize: 100 });
          return { project, table, records };
        } catch (e2) {
          return { project, table, records: [], error: e2.message };
        }
      }
    });

    // ── Batches: most recent 100 of each.
    const loadingPromise = fetchAirtable('Loading_Batches', {
      pageSize: 100,
      'sort[0][field]': 'Loading Date',
      'sort[0][direction]': 'desc'
    });
    const paintingPromise = fetchAirtable('Painting_Batches', {
      pageSize: 100,
      'sort[0][field]': 'Completion Date',
      'sort[0][direction]': 'desc'
    });
    const weldingPromise = fetchAirtable('Welding_Batches', {
      pageSize: 100,
      'sort[0][field]': 'Weld Date',
      'sort[0][direction]': 'desc'
    });

    const [qcResults, loadingRecords, paintingRecords, weldingRecords] = await Promise.all([
      Promise.all(qcPromises),
      loadingPromise.catch(() => []),
      paintingPromise.catch(() => []),
      weldingPromise.catch(() => [])
    ]);

    // ── Aggregate QC + build cross-project recent feed.
    let qcTotal = 0, qcAccepted = 0, qcRejected = 0, qcReworked = 0;
    const allQcNormalised = [];
    const perProject = qcResults.map(({ project, records }) => {
      let a = 0, r = 0, w = 0;
      records.forEach(rec => {
        const f = rec.fields || {};
        const status = f['Operation Inspection Result'] || f['Operation Inspection Results'] || f['Status'] || '';
        if (QC_PASS.has(status)) a++;
        else if (QC_FAIL.has(status)) r++;
        else if (status) w++;
        allQcNormalised.push(normaliseQcRecord(rec, project));
      });
      qcTotal += records.length;
      qcAccepted += a;
      qcRejected += r;
      qcReworked += w;
      return { project, qcCount: records.length, accepted: a, rejected: r, reworked: w };
    });

    // ── Aggregate Loading.
    let loadedUnits = 0, deliveredUnits = 0;
    const loadingByStatus = { Pending: 0, Loaded: 0, Returned: 0, Delivered: 0 };
    loadingRecords.forEach(rec => {
      const f = rec.fields || {};
      const qty = Number(f['Total Quantity']) || 0;
      const status = f['Loading Status'] || '';
      if (loadingByStatus[status] !== undefined) loadingByStatus[status]++;
      if (status === 'Loaded' || status === 'Delivered') loadedUnits += qty;
      if (status === 'Delivered') deliveredUnits += qty;
    });

    // ── Aggregate Painting.
    let paintedUnits = 0, reworkUnits = 0;
    const paintingByCoating = { 'Not Started': 0, 'In Progress': 0, Completed: 0, Rework: 0 };
    paintingRecords.forEach(rec => {
      const f = rec.fields || {};
      const qty = Number(f['Quantity Completed']) || 0;
      const coating = f['Coating Status'] || '';
      if (paintingByCoating[coating] !== undefined) paintingByCoating[coating]++;
      if (coating === 'Completed') paintedUnits += qty;
      if (coating === 'Rework') reworkUnits += (Number(f['Total Quantity']) || 0);
    });

    // ── Aggregate Welding.
    let weldedAcceptedUnits = 0, weldedRejectedUnits = 0;
    const weldingByResult = { Accepted: 0, Rejected: 0, Reworked: 0 };
    weldingRecords.forEach(rec => {
      const f = rec.fields || {};
      const qty = Number(f['Total Quantity']) || 0;
      const result = f['Inspection Result'] || '';
      if (weldingByResult[result] !== undefined) weldingByResult[result]++;
      if (result === 'Accepted') weldedAcceptedUnits += qty;
      if (result === 'Rejected') weldedRejectedUnits += qty;
    });

    // ── Cross-module pending = QC tables with no Loading/Painting yet (cheap heuristic).
    const pendingComponents = Math.max(qcAccepted - loadedUnits, 0);

    // ── Per-project rollup adding loading + painting + welding totals.
    const perProjectIdx = Object.create(null);
    perProject.forEach(p => {
      perProjectIdx[p.project] = p;
      p.loaded = 0; p.painted = 0; p.welded = 0;
      p.loadingBatches = 0; p.paintingBatches = 0; p.weldingBatches = 0;
    });
    loadingRecords.forEach(rec => {
      const f = rec.fields || {};
      const p = f['Project'];
      const qty = Number(f['Total Quantity']) || 0;
      if (perProjectIdx[p]) { perProjectIdx[p].loaded += qty; perProjectIdx[p].loadingBatches++; }
    });
    paintingRecords.forEach(rec => {
      const f = rec.fields || {};
      const p = f['Project'];
      const qty = Number(f['Quantity Completed']) || 0;
      if (perProjectIdx[p]) { perProjectIdx[p].painted += qty; perProjectIdx[p].paintingBatches++; }
    });
    weldingRecords.forEach(rec => {
      const f = rec.fields || {};
      const p = f['Project'];
      const qty = Number(f['Total Quantity']) || 0;
      if (perProjectIdx[p]) { perProjectIdx[p].welded += qty; perProjectIdx[p].weldingBatches++; }
    });

    // ── Recent batch summaries.
    const recentLoading = loadingRecords.slice(0, 12).map(rec => {
      const f = rec.fields || {};
      return {
        id: rec.id,
        batchId: f['Batch ID'] || '',
        project: f['Project'] || '',
        vehicle: f['Vehicle Number'] || '',
        destination: f['Destination'] || '',
        units: Number(f['Total Quantity']) || 0,
        status: f['Loading Status'] || '',
        loadedBy: f['Loaded By'] || '',
        loadingDate: f['Loading Date'] || ''
      };
    });
    const recentPainting = paintingRecords.slice(0, 12).map(rec => {
      const f = rec.fields || {};
      return {
        id: rec.id,
        batchId: f['Paint Batch ID'] || '',
        project: f['Project'] || '',
        paintSystem: f['Paint System'] || '',
        totalQty: Number(f['Total Quantity']) || 0,
        quantityCompleted: Number(f['Quantity Completed']) || 0,
        surfacePrepStatus: f['Surface Prep Status'] || '',
        coatingStatus: f['Coating Status'] || '',
        finishedBy: f['Finished By'] || '',
        completionDate: f['Completion Date'] || ''
      };
    });
    const recentWelding = weldingRecords.slice(0, 12).map(rec => {
      const f = rec.fields || {};
      return {
        id: rec.id,
        weldBatchId: f['Weld Batch ID'] || '',
        project: f['Project'] || '',
        cell: f['Robot Cell'] || '',
        weldType: f['Weld Type'] || '',
        joint: f['Joint Configuration'] || '',
        grade: f['Weld Quality Grade'] || '',
        result: f['Inspection Result'] || '',
        operator: f['Operator'] || '',
        totalQty: Number(f['Total Quantity']) || 0,
        weldDate: f['Weld Date'] || ''
      };
    });

    // Recent QC across ALL project tables — sorted globally by createdTime desc.
    const recentQc = allQcNormalised
      .filter(r => r.createdTime)
      .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)))
      .slice(0, 10);

    const totalBeams = qcTotal;
    const totalLoaded = loadedUnits;
    const totalPainted = paintedUnits;
    const totalWelded = weldedAcceptedUnits;
    const activeBatches = (loadingByStatus.Pending + loadingByStatus.Loaded) +
                          (paintingByCoating['In Progress'] + paintingByCoating['Not Started']);

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      kpis: {
        totalBeams,
        passedQc: qcAccepted,
        failedQc: qcRejected,
        reworkedQc: qcReworked,
        totalLoaded,
        totalDelivered: deliveredUnits,
        totalPainted,
        totalWelded,
        pendingComponents,
        reworkCount: reworkUnits,
        loadingBatches: loadingRecords.length,
        paintingBatches: paintingRecords.length,
        weldingBatches: weldingRecords.length,
        weldedRejectedUnits,
        activeBatches
      },
      loadingByStatus,
      paintingByCoating,
      weldingByResult,
      perProject,
      recent: {
        qc: recentQc,
        loading: recentLoading,
        painting: recentPainting,
        welding: recentWelding
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
