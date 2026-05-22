// lib/painting-loading-mirror.js — Shared painting → loading mirror logic.
// Used by both api/painting.js (inline on submit) and the reconciliation
// cron (api/cron/reconcile-painting-loading.js) so the two paths cannot
// drift in behaviour.

const { findByIdempotencyKey } = require('./dashboard-helpers');

const LOADING_TABLE = 'Loading_Batches';

// Insert (or no-op via idempotency lookup) a Pending row in Loading_Batches
// that mirrors a completed painting batch. Vehicle Number and Destination
// are intentionally omitted — the loading team fills those in when they
// assign a truck. The auto-row's Batch ID and Idempotency Key are both
// derived from the source paintBatchId so the mirror is a pure function of
// the painting submission: calling this twice for the same batch is safe.
async function ensurePendingLoadingForPainting(args) {
  const {
    paintBatchId, project, beamUidsRaw, parsedSerialised, totalQty,
    completionDate, notes, AIRTABLE_API_KEY, AIRTABLE_BASE_ID
  } = args;

  if (!paintBatchId) throw new Error('paintBatchId is required');
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    throw new Error('Airtable credentials are not configured on the server.');
  }

  const autoKey = `paint-auto:${paintBatchId}`;
  const existing = await findByIdempotencyKey(LOADING_TABLE, autoKey);
  if (existing) {
    return { deduplicated: true, id: existing.id };
  }

  const autoBatchId = (`LD-AUTO-${paintBatchId}`).slice(0, 64);
  const fields = {
    'Batch ID': autoBatchId,
    'Project': project,
    'Beam UIDs': beamUidsRaw,
    'Parsed UIDs': parsedSerialised,
    'Total Quantity': totalQty,
    'Loading Status': 'Pending',
    'Loaded By': 'Auto (painting)',
    'Loading Date': completionDate || new Date().toISOString(),
    'Notes': `Auto-created from painting batch ${paintBatchId}` +
             (notes ? `\n\nPainting notes: ${notes}` : ''),
    'Idempotency Key': autoKey
  };

  const airtableRes = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(LOADING_TABLE)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    }
  );
  const data = await airtableRes.json();
  if (!airtableRes.ok) {
    throw new Error((data && data.error && data.error.message) || `Airtable error ${airtableRes.status}`);
  }
  return { id: data.id, batchId: autoBatchId };
}

module.exports = { ensurePendingLoadingForPainting, LOADING_TABLE };
