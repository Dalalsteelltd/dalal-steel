// api/search-beam.js — Master tracker beam search.
// Cookie-protected by dsi_mgr. Given any substring of a UID (and optional
// project), returns every matching row across QC tables + Loading_Batches +
// Painting_Batches + Welding_Batches. Match is case-insensitive "contains",
// so typing "C10" finds SBN022-C10(1), RF-C10A, etc.

const { PROJECT_TABLES, verifyDashboardCookie, fetchAirtable } = require('../lib/dashboard-helpers');

function escapeFormulaString(s) {
  return String(s).replace(/'/g, "\\'");
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Sum quantities of every line in "Parsed UIDs" whose UID contains the query.
// Lines look like "RF1 x 12" or "SBN022-C10 x 3".
function sumMatchingQty(parsed, queryUpper) {
  const total = { qty: 0, uids: [] };
  if (!parsed) return total;
  const lines = String(parsed).split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^(.+?)\s*x\s*(\d+)\s*$/i);
    if (!m) continue;
    const uid = m[1].trim();
    if (uid.toUpperCase().indexOf(queryUpper) === -1) continue;
    const qty = parseInt(m[2], 10) || 0;
    total.qty += qty;
    total.uids.push(uid + ' x ' + qty);
  }
  return total;
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
  if (uid.length < 2) return res.status(400).json({ error: 'enter at least 2 characters to search' });
  if (uid.length > 64) return res.status(400).json({ error: 'uid too long' });

  const safeUid = escapeFormulaString(uid);

  // Case-insensitive "contains" — works for any field name we plug in.
  const containsFormula = field => `FIND('${safeUid}', UPPER({${field}} & '')) > 0`;

  try {
    // ── QC: contains match on Beam UID in each project table.
    const projectsToSearch = projectFilter && PROJECT_TABLES[projectFilter]
      ? [[projectFilter, PROJECT_TABLES[projectFilter]]]
      : Object.entries(PROJECT_TABLES);

    const qcPromises = projectsToSearch.map(async ([project, table]) => {
      try {
        const records = await fetchAirtable(table, {
          filterByFormula: containsFormula('Beam UID'),
          pageSize: 100
        });
        return { project, table, records };
      } catch (e) {
        return { project, table, records: [], error: e.message };
      }
    });

    // ── Batch tables: contains on the normalised "Parsed UIDs" column.
    const loadingPromise = fetchAirtable('Loading_Batches', {
      filterByFormula: containsFormula('Parsed UIDs'),
      pageSize: 100,
      'sort[0][field]': 'Loading Date',
      'sort[0][direction]': 'desc'
    }).catch(() => []);

    const paintingPromise = fetchAirtable('Painting_Batches', {
      filterByFormula: containsFormula('Parsed UIDs'),
      pageSize: 100,
      'sort[0][field]': 'Completion Date',
      'sort[0][direction]': 'desc'
    }).catch(() => []);

    const weldingPromise = fetchAirtable('Welding_Batches', {
      filterByFormula: containsFormula('Parsed UIDs'),
      pageSize: 100,
      'sort[0][field]': 'Weld Date',
      'sort[0][direction]': 'desc'
    }).catch(() => []);

    const [qcResults, loadingRecords, paintingRecords, weldingRecords] = await Promise.all([
      Promise.all(qcPromises),
      loadingPromise,
      paintingPromise,
      weldingPromise
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
          createdTime: f['Created Time'] || f['Date'] || rec.createdTime || ''
        });
      });
    });
    qcMatches.sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));

    const loadingMatches = loadingRecords.map(rec => {
      const f = rec.fields || {};
      const { qty, uids } = sumMatchingQty(f['Parsed UIDs'], uid);
      return {
        id: rec.id,
        batchId: f['Batch ID'] || '',
        project: f['Project'] || '',
        qty,
        matchedUids: uids,
        vehicle: f['Vehicle Number'] || '',
        destination: f['Destination'] || '',
        status: f['Loading Status'] || '',
        loadedBy: f['Loaded By'] || '',
        loadingDate: f['Loading Date'] || ''
      };
    });

    const paintingMatches = paintingRecords.map(rec => {
      const f = rec.fields || {};
      const { qty, uids } = sumMatchingQty(f['Parsed UIDs'], uid);
      return {
        id: rec.id,
        batchId: f['Paint Batch ID'] || '',
        project: f['Project'] || '',
        qty,
        matchedUids: uids,
        paintSystem: f['Paint System'] || '',
        surfacePrepStatus: f['Surface Prep Status'] || '',
        coatingStatus: f['Coating Status'] || '',
        finishedBy: f['Finished By'] || '',
        completionDate: f['Completion Date'] || ''
      };
    });

    const weldingMatches = weldingRecords.map(rec => {
      const f = rec.fields || {};
      const { qty, uids } = sumMatchingQty(f['Parsed UIDs'], uid);
      return {
        id: rec.id,
        batchId: f['Weld Batch ID'] || '',
        project: f['Project'] || '',
        qty,
        matchedUids: uids,
        cell: f['Robot Cell'] || '',
        weldType: f['Weld Type'] || '',
        joint: f['Joint Configuration'] || '',
        grade: f['Weld Quality Grade'] || '',
        result: f['Inspection Result'] || '',
        operator: f['Operator'] || '',
        weldDate: f['Weld Date'] || ''
      };
    });

    // ── Compute the current location/status heuristically (latest stage wins).
    let currentDept = qcMatches.length ? 'QC' : 'Unknown';
    let currentStatus = qcMatches[0] ? qcMatches[0].result : '';
    if (weldingMatches.length) {
      currentDept = 'Welding';
      currentStatus = weldingMatches[0].result;
    }
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
      matchMode: 'contains',
      summary: {
        qcCount: qcMatches.length,
        loadingCount: loadingMatches.length,
        paintingCount: paintingMatches.length,
        weldingCount: weldingMatches.length,
        currentDept,
        currentStatus
      },
      qc: qcMatches,
      loading: loadingMatches,
      painting: paintingMatches,
      welding: weldingMatches
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
