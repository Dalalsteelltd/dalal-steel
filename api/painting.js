// api/painting.js — Painting / Finishing batch submission endpoint.
// Posts a single batch row to the Airtable `Painting_Batches` table.
//
// Side effect: when Coating Status is "Completed", the same batch is mirrored
// into Loading_Batches as a Pending row (no vehicle/destination yet) so the
// loading team's queue automatically reflects finished paintwork. The mirror
// row uses a deterministic idempotency key derived from the Paint Batch ID
// so retries / re-submissions of the same paint batch never duplicate it.

const { findByIdempotencyKey } = require('../lib/dashboard-helpers');

const TABLE = 'Painting_Batches';
const LOADING_TABLE = 'Loading_Batches';

const ALLOWED_PROJECTS = new Set([
  'SPN004','SPN062','SPN003','NG008','NG014','SBN025',
  'SBN005','SBN002','SBN022','ST300','SBN013','SPN023'
]);

const ALLOWED_PHASE = new Set(['Not Started','In Progress','Completed','Rework']);

const BATCH_LINE = /^([A-Za-z0-9][A-Za-z0-9_\-./]*)\s*(?:[\(\[]\s*(\d+)\s*[\)\]]|\s*[xX*]\s*(\d+)|\s*[-]\s*(\d+)|\s+(\d+))?$/;

function parseBatch(text) {
  const items = [];
  if (!text || typeof text !== 'string') return { items, totalQty: 0 };
  const lines = text.replace(/[;]/g, ',')
    .split(/[\r\n]+/)
    .flatMap(l => l.split(/,(?![^()]*\))/))
    .map(s => s.trim())
    .filter(Boolean);
  for (const line of lines) {
    const m = line.match(BATCH_LINE);
    if (!m) continue;
    const uid = m[1].toUpperCase();
    const qtyRaw = m[2] || m[3] || m[4] || m[5];
    const qty = qtyRaw ? parseInt(qtyRaw, 10) : 1;
    if (!Number.isFinite(qty) || qty < 1 || qty > 9999) continue;
    items.push({ uid, qty });
  }
  const totalQty = items.reduce((s, it) => s + it.qty, 0);
  return { items, totalQty };
}

function trim(v, max) {
  if (v == null) return '';
  const s = String(v).trim();
  return max ? s.slice(0, max) : s;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Airtable credentials are not configured on the server.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const paintBatchId = trim(body.paintBatchId, 64);
  const project = trim(body.project, 32);
  const beamUidsRaw = trim(body.beamUidsRaw, 5000);
  const surfacePrepStatus = trim(body.surfacePrepStatus, 32);
  const paintSystem = trim(body.paintSystem, 200);
  const coatingStatus = trim(body.coatingStatus, 32);
  const finishedBy = trim(body.finishedBy, 120);
  const completionDate = trim(body.completionDate, 32);
  const notes = trim(body.notes, 2000);
  const imageUrl = trim(body.imageUrl, 500);
  const idempotencyKey = trim(body.idempotencyKey, 80);
  let quantityCompletedRaw = body.quantityCompleted;

  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(TABLE, idempotencyKey);
    if (existing) {
      const f = existing.fields || {};
      return res.status(200).json({
        success: true,
        deduplicated: true,
        id: existing.id,
        paintBatchId: f['Paint Batch ID'] || paintBatchId,
        itemCount: (String(f['Parsed UIDs'] || '').split(/\r?\n/).filter(Boolean)).length,
        totalQty: Number(f['Total Quantity']) || 0,
        quantityCompleted: Number(f['Quantity Completed']) || 0
      });
    }
  }

  if (!paintBatchId) return res.status(400).json({ error: 'Paint Batch ID is required.' });
  if (!ALLOWED_PROJECTS.has(project)) return res.status(400).json({ error: 'Invalid project number.' });
  if (!beamUidsRaw) return res.status(400).json({ error: 'At least one Beam UID is required.' });
  if (!ALLOWED_PHASE.has(surfacePrepStatus)) return res.status(400).json({ error: 'Invalid surface prep status.' });
  if (!ALLOWED_PHASE.has(coatingStatus)) return res.status(400).json({ error: 'Invalid coating status.' });
  if (!paintSystem) return res.status(400).json({ error: 'Paint System is required.' });
  if (!finishedBy) return res.status(400).json({ error: 'Finished By is required.' });
  if (!completionDate) return res.status(400).json({ error: 'Completion Date is required.' });

  const { items, totalQty } = parseBatch(beamUidsRaw);
  if (!items.length) return res.status(400).json({ error: 'No valid Beam UIDs detected in the batch entry.' });

  let quantityCompleted = parseInt(quantityCompletedRaw, 10);
  if (!Number.isFinite(quantityCompleted) || quantityCompleted < 0) {
    // Default: if Coating Status is Completed assume all done, otherwise 0.
    quantityCompleted = coatingStatus === 'Completed' ? totalQty : 0;
  }
  if (quantityCompleted > totalQty) quantityCompleted = totalQty;

  const parsedSerialised = items.map(it => `${it.uid} x ${it.qty}`).join('\n');

  const fields = {
    'Paint Batch ID': paintBatchId,
    'Project': project,
    'Beam UIDs': beamUidsRaw,
    'Parsed UIDs': parsedSerialised,
    'Total Quantity': totalQty,
    'Surface Prep Status': surfacePrepStatus,
    'Paint System': paintSystem,
    'Coating Status': coatingStatus,
    'Quantity Completed': quantityCompleted,
    'Finished By': finishedBy,
    'Completion Date': completionDate,
    'Notes': notes
  };
  if (imageUrl) fields['Image'] = [{ url: imageUrl }];
  if (idempotencyKey) fields['Idempotency Key'] = idempotencyKey;

  try {
    const airtableRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}`,
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
      return res.status(airtableRes.status).json({ error: data.error?.message || 'Airtable error' });
    }
    let autoLoading = null;
    if (coatingStatus === 'Completed') {
      // Best-effort mirror to Loading_Batches. A failure here must not fail
      // the painting submission — the painting record already exists and the
      // loading row can be reconciled later (idempotency key prevents dupes
      // on a subsequent painting retry).
      try {
        autoLoading = await ensurePendingLoadingForPainting({
          paintBatchId,
          project,
          beamUidsRaw,
          parsedSerialised,
          totalQty,
          completionDate,
          notes,
          AIRTABLE_API_KEY,
          AIRTABLE_BASE_ID
        });
      } catch (autoErr) {
        autoLoading = { error: autoErr.message };
      }
    }

    return res.status(200).json({
      success: true,
      id: data.id,
      paintBatchId,
      itemCount: items.length,
      totalQty,
      quantityCompleted,
      autoLoading
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// Insert (or no-op via idempotency lookup) a Pending row in Loading_Batches
// that mirrors a completed painting batch. Vehicle Number and Destination
// are intentionally omitted — the loading team fills those in when they
// assign a truck. The auto-row's Batch ID and Idempotency Key are both
// derived from the source paintBatchId so the mirror is a pure function of
// the painting submission.
async function ensurePendingLoadingForPainting(args) {
  const {
    paintBatchId, project, beamUidsRaw, parsedSerialised, totalQty,
    completionDate, notes, AIRTABLE_API_KEY, AIRTABLE_BASE_ID
  } = args;

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
