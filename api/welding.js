// api/welding.js — Robotic Welding batch submission endpoint.
// Posts a single batch row to the Airtable `Welding_Batches` table.
// Many Beam UIDs may be covered by one row (same cell / joint / parameters).

const TABLE = 'Welding_Batches';

const ALLOWED_PROJECTS = new Set([
  'SPN004','SPN062','SPN003','NG008','NG014','SBN025',
  'SBN005','SBN002','SBN022','ST300','SBN013','SPN023'
]);

const ALLOWED_CELLS = new Set(['Cell 1','Cell 2','Cell 3','Cell 4']);
const ALLOWED_WELD_TYPES = new Set(['Fillet','Butt','Groove','Plug','Slot']);
const ALLOWED_JOINTS = new Set(['T-Joint','Lap Joint','Corner Joint','Butt Joint','Edge Joint']);
const ALLOWED_GRADES = new Set(['A (Excellent)','B (Good)','C (Fair)','D (Reject)']);
const ALLOWED_RESULTS = new Set(['Accepted','Rejected','Reworked']);

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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

  const weldBatchId = trim(body.weldBatchId, 64);
  const project = trim(body.project, 32);
  const beamUidsRaw = trim(body.beamUidsRaw, 5000);
  const cell = trim(body.cell, 32);
  const weldType = trim(body.weldType, 32);
  const joint = trim(body.joint, 32);
  const wire = trim(body.wire, 120);
  const gas = trim(body.gas, 120);
  const grade = trim(body.grade, 32);
  const result = trim(body.result, 32);
  const operator = trim(body.operator, 120);
  const weldDate = trim(body.weldDate, 32);
  const notes = trim(body.notes, 2000);
  const imageUrl = trim(body.imageUrl, 500);

  const amperage = num(body.amperage);
  const voltage = num(body.voltage);
  const travelSpeed = num(body.travelSpeed);
  const wireFeed = num(body.wireFeed);
  const weldLength = num(body.weldLength);
  const passes = num(body.passes);

  if (!weldBatchId) return res.status(400).json({ error: 'Weld Batch ID is required.' });
  if (!ALLOWED_PROJECTS.has(project)) return res.status(400).json({ error: 'Invalid project number.' });
  if (!beamUidsRaw) return res.status(400).json({ error: 'At least one Beam UID is required.' });
  if (!ALLOWED_CELLS.has(cell)) return res.status(400).json({ error: 'Invalid robot cell.' });
  if (!ALLOWED_WELD_TYPES.has(weldType)) return res.status(400).json({ error: 'Invalid weld type.' });
  if (!ALLOWED_JOINTS.has(joint)) return res.status(400).json({ error: 'Invalid joint configuration.' });
  if (!wire) return res.status(400).json({ error: 'Wire / Consumable is required.' });
  if (!gas) return res.status(400).json({ error: 'Gas Mix is required.' });
  if (amperage == null || amperage < 0) return res.status(400).json({ error: 'Valid Amperage is required.' });
  if (voltage == null || voltage < 0) return res.status(400).json({ error: 'Valid Voltage is required.' });
  if (travelSpeed == null || travelSpeed < 0) return res.status(400).json({ error: 'Valid Travel Speed is required.' });
  if (wireFeed == null || wireFeed < 0) return res.status(400).json({ error: 'Valid Wire Feed Speed is required.' });
  if (weldLength == null || weldLength < 0) return res.status(400).json({ error: 'Valid Weld Length is required.' });
  if (passes == null || passes < 1) return res.status(400).json({ error: 'Number of passes must be at least 1.' });
  if (!ALLOWED_GRADES.has(grade)) return res.status(400).json({ error: 'Invalid weld quality grade.' });
  if (!ALLOWED_RESULTS.has(result)) return res.status(400).json({ error: 'Invalid inspection result.' });
  if (!operator) return res.status(400).json({ error: 'Operator name is required.' });
  if (!weldDate) return res.status(400).json({ error: 'Weld Date is required.' });

  const { items, totalQty } = parseBatch(beamUidsRaw);
  if (!items.length) return res.status(400).json({ error: 'No valid Beam UIDs detected in the batch entry.' });

  const parsedSerialised = items.map(it => `${it.uid} x ${it.qty}`).join('\n');

  const fields = {
    'Weld Batch ID': weldBatchId,
    'Project': project,
    'Beam UIDs': beamUidsRaw,
    'Parsed UIDs': parsedSerialised,
    'Total Quantity': totalQty,
    'Robot Cell': cell,
    'Weld Type': weldType,
    'Joint Configuration': joint,
    'Wire / Consumable': wire,
    'Gas Mix': gas,
    'Amperage': amperage,
    'Voltage': voltage,
    'Travel Speed': travelSpeed,
    'Wire Feed Speed': wireFeed,
    'Weld Length': weldLength,
    'Number of Passes': passes,
    'Weld Quality Grade': grade,
    'Inspection Result': result,
    'Operator': operator,
    'Weld Date': weldDate,
    'Notes': notes
  };
  if (imageUrl) fields['Image'] = [{ url: imageUrl }];

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
      weldBatchId,
      itemCount: items.length,
      totalQty
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
