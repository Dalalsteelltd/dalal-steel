// api/loading.js — Loading Team batch submission endpoint.
// Posts a single batch row to the Airtable `Loading_Batches` table.
// Many Beam UIDs may be covered by one row (RF1 x 12, RF2 x 8, …).

const TABLE = 'Loading_Batches';

const ALLOWED_PROJECTS = new Set([
  'SPN004','SPN062','SPN003','NG008','NG014','SBN025',
  'SBN005','SBN002','SBN022','ST300','SBN013','SPN023'
]);

const ALLOWED_STATUS = new Set(['Pending','Loaded','Returned','Delivered']);

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

  const batchId = trim(body.batchId, 64);
  const project = trim(body.project, 32);
  const vehicle = trim(body.vehicle, 64);
  const destination = trim(body.destination, 200);
  const beamUidsRaw = trim(body.beamUidsRaw, 5000);
  const status = trim(body.status, 32);
  const loadedBy = trim(body.loadedBy, 120);
  const loadingDate = trim(body.loadingDate, 32);
  const notes = trim(body.notes, 2000);
  const imageUrl = trim(body.imageUrl, 500);

  if (!batchId) return res.status(400).json({ error: 'Batch ID is required.' });
  if (!ALLOWED_PROJECTS.has(project)) return res.status(400).json({ error: 'Invalid project number.' });
  if (!vehicle) return res.status(400).json({ error: 'Vehicle number is required.' });
  if (!destination) return res.status(400).json({ error: 'Destination is required.' });
  if (!beamUidsRaw) return res.status(400).json({ error: 'At least one Beam UID is required.' });
  if (!ALLOWED_STATUS.has(status)) return res.status(400).json({ error: 'Invalid loading status.' });
  if (!loadedBy) return res.status(400).json({ error: 'Loaded By is required.' });
  if (!loadingDate) return res.status(400).json({ error: 'Loading Date is required.' });

  const { items, totalQty } = parseBatch(beamUidsRaw);
  if (!items.length) return res.status(400).json({ error: 'No valid Beam UIDs detected in the batch entry.' });

  const parsedSerialised = items.map(it => `${it.uid} x ${it.qty}`).join('\n');

  const fields = {
    'Batch ID': batchId,
    'Project': project,
    'Vehicle Number': vehicle,
    'Destination': destination,
    'Beam UIDs': beamUidsRaw,
    'Parsed UIDs': parsedSerialised,
    'Total Quantity': totalQty,
    'Loading Status': status,
    'Loaded By': loadedBy,
    'Loading Date': loadingDate,
    'Notes': notes
  };
  if (imageUrl) fields['Proof Image'] = [{ url: imageUrl }];

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
    return res.status(200).json({
      success: true,
      id: data.id,
      batchId,
      itemCount: items.length,
      totalQty
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
