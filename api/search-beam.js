// api/search-beam.js — Master tracker beam search.
// Cookie-protected by dsi_mgr. Given a UID (and optional project),
// returns matching rows from QC tables + Loading_Batches + Painting_Batches.

const { PROJECT_TABLES, verifyDashboardCookie, fetchAirtable } = require('../lib/dashboard-helpers');

function escapeFormulaString(s) {
  return String(s).replace(/'/g, "\\'");
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!verifyDashboardCookie(req)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const uidRaw = (req.query && req.query.uid) || '';
  const projectFilter = (req.query && req.query.project) || '';
  const uid = String(uidRaw).trim().toUpperCase();
  if (!uid) return res.status(400).json({ error: 'uid query parameter is required' });
  if (uid.length > 64) return res.status(400).json({ error: 'uid too long' });

  const safeUid = escapeFormulaString(uid);

  try {
    // ── QC: search each project table by exact Beam UID match.
    const projectsToSearch = projectFilter && PROJECT_TABLES[projectFilter]
      ? [[projectFilter, PROJECT_TABLES[projectFilter]]]
      : Object.entries(PROJECT_TABLES);

    const qcPromises = projectsToSearch.map(async ([project, table]) => {
      try {
        const records = await fetchAirtable(table, {
          filterByFormula: `UPPER({Beam UID}) = '${safeUid}'`,
          pageSize: 25
        });
        return { project, table, records };
      } catch (e) {
        return { project, table, records: [], error: e.message };
      }
    });

    // ── Loading: Beam UID appears inside the "Parsed UIDs" text. Anchor the
    // match so RF1 doesn't match RF10.
    const loadingFormula = `REGEX_MATCH({Parsed UIDs}, '(^|\\n)${safeUid} x ')`;
    const paintingFormula = `REGEX_MATCH({Parsed UIDs}, '(^|\\n)${safeUid} x ')`;

    const loadingPromise = fetchAirtable('Loading_Batches', {
      filterByFormula: loadingFormula,
      pageSize: 50,
      'sort[0][field]': 'Loading Date',
      'sort[0][direction]': 'desc'
    }).catch(() => []);

    const paintingPromise = fetchAirtable('Painting_Batches', {
      filterByFormula: paintingFormula,
      pageSize: 50,
      'sort[0][field]': 'Completion Date',
      'sort[0][direction]': 'desc'
    }).catch(() => []);

    const [qcResults, loadingRecords, paintingRecords] = await Promise.all([
      Promise.all(qcPromises),
      loadingPromise,
      paintingPromise
    ]);

    // Flatten QC matches.
    const qcMatches = [];
    qcResults.forEach(({ project, records }) => {
      records.forEach(rec => {
        const f = rec.fields || {};
        qcMatches.push({
          id: rec.id,
          project,
          beamUid: f['Beam UID'] || '',
          inspectionId: f['Inspection ID'] || '',
          worktype: f['Worktype'] || f['Work Type'] || '',
          result: f['Operation Inspection Result'] || f['Operation Inspection Results'] || f['Status'] || '',
          nonConformance: f['Non-Conformance'] || f['Non- Conformance and Corrective Action (NCR/CAPA)'] || '',
          createdTime: f['Created Time'] || rec.createdTime || ''
        });
      });
    });
    qcMatches.sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));

    const loadingMatches = loadingRecords.map(rec => {
      const f = rec.fields || {};
      // Extract the qty for this exact UID from "Parsed UIDs"
      let qty = 0;
      const parsed = String(f['Parsed UIDs'] || '');
      const re = new RegExp('^' + escapeRegex(uid) + ' x (\\d+)', 'm');
      const m = parsed.match(re);
      if (m) qty = parseInt(m[1], 10);
      return {
        id: rec.id,
        batchId: f['Batch ID'] || '',
        project: f['Project'] || '',
        qty,
        vehicle: f['Vehicle Number'] || '',
        destination: f['Destination'] || '',
        status: f['Loading Status'] || '',
        loadedBy: f['Loaded By'] || '',
        loadingDate: f['Loading Date'] || ''
      };
    });

    const paintingMatches = paintingRecords.map(rec => {
      const f = rec.fields || {};
      let qty = 0;
      const parsed = String(f['Parsed UIDs'] || '');
      const re = new RegExp('^' + escapeRegex(uid) + ' x (\\d+)', 'm');
      const m = parsed.match(re);
      if (m) qty = parseInt(m[1], 10);
      return {
        id: rec.id,
        batchId: f['Paint Batch ID'] || '',
        project: f['Project'] || '',
        qty,
        paintSystem: f['Paint System'] || '',
        surfacePrepStatus: f['Surface Prep Status'] || '',
        coatingStatus: f['Coating Status'] || '',
        finishedBy: f['Finished By'] || '',
        completionDate: f['Completion Date'] || ''
      };
    });

    // ── Compute the current location/status heuristically.
    let currentDept = qcMatches.length ? 'QC' : 'Unknown';
    let currentStatus = qcMatches[0] ? qcMatches[0].result : '';
    if (paintingMatches.length) {
      currentDept = 'Painting';
      currentStatus = paintingMatches[0].coatingStatus;
    }
    if (loadingMatches.length) {
      const latest = loadingMatches[0];
      currentDept = latest.status === 'Delivered' ? 'Delivered' : 'Loading';
      currentStatus = latest.status;
    }

    return res.status(200).json({
      uid,
      projectFilter: projectFilter || null,
      summary: {
        qcCount: qcMatches.length,
        loadingCount: loadingMatches.length,
        paintingCount: paintingMatches.length,
        currentDept,
        currentStatus
      },
      qc: qcMatches,
      loading: loadingMatches,
      painting: paintingMatches
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
