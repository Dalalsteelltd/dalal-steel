// api/cron/reconcile-painting-loading.js — Periodic safety net.
//
// Inline mirror in /api/painting is best-effort: if Airtable hiccups during
// the secondary Loading_Batches insert, the painting row exists but no
// Pending loading row is ever created. This endpoint sweeps every Completed
// painting batch and creates the mirror row if missing. The shared
// idempotency key (`paint-auto:<paintBatchId>`) means re-running the sweep is
// a no-op when nothing's out of sync.
//
// Triggered by Vercel Cron — schedule lives in vercel.json. Also supports a
// manual sweep from an authenticated manager-dashboard session for debugging.

const {
  fetchAirtableAll,
  verifyDashboardCookie
} = require('../../lib/dashboard-helpers');
const { ensurePendingLoadingForPainting } = require('../../lib/painting-loading-mirror');

module.exports = async function handler(req, res) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET> when CRON_SECRET
  // is set in project env vars. A manager-dashboard cookie also unlocks the
  // endpoint so an operator can trigger a sweep on demand.
  const auth = (req.headers && req.headers.authorization) || '';
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && auth === `Bearer ${cronSecret}`;
  if (!isCron && !verifyDashboardCookie(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Airtable credentials are not configured on the server.' });
  }

  const startedAt = Date.now();
  let scanned = 0, created = 0, alreadyOk = 0;
  const errors = [];

  try {
    // Only Completed coatings produce a Pending Loading row. Filtering at
    // Airtable keeps the response small even as the painting table grows.
    const completed = await fetchAirtableAll('Painting_Batches', {
      fields: [
        'Paint Batch ID', 'Project', 'Beam UIDs', 'Parsed UIDs',
        'Total Quantity', 'Completion Date', 'Notes', 'Coating Status'
      ],
      filterByFormula: "{Coating Status} = 'Completed'"
    });

    for (const rec of completed) {
      scanned++;
      const f = rec.fields || {};
      const paintBatchId = String(f['Paint Batch ID'] || '').trim();
      if (!paintBatchId) {
        errors.push({ recordId: rec.id, message: 'Missing Paint Batch ID' });
        continue;
      }
      try {
        const result = await ensurePendingLoadingForPainting({
          paintBatchId,
          project: f['Project'] || '',
          beamUidsRaw: f['Beam UIDs'] || '',
          parsedSerialised: f['Parsed UIDs'] || '',
          totalQty: Number(f['Total Quantity']) || 0,
          completionDate: f['Completion Date'] || '',
          notes: f['Notes'] || '',
          AIRTABLE_API_KEY,
          AIRTABLE_BASE_ID
        });
        if (result && result.deduplicated) alreadyOk++;
        else created++;
      } catch (err) {
        errors.push({ paintBatchId, message: err.message });
      }
    }

    return res.status(200).json({
      ok: true,
      scanned,
      created,
      alreadyOk,
      errorCount: errors.length,
      errors,
      durationMs: Date.now() - startedAt
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      scanned,
      created,
      alreadyOk,
      errorCount: errors.length,
      errors,
      durationMs: Date.now() - startedAt
    });
  }
};
