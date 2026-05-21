// lib/dashboard-helpers.js — Shared helpers for the dashboard endpoints.
// Living outside /api so Vercel does not auto-route it.

const crypto = require('crypto');

// QC project → Airtable table name (mirrors api/submit.js).
const PROJECT_TABLES = {
  SPN004: 'test',
  SPN062: 'spn001',
  SBN003: 'spn015',
  SPN003: 'Spn003',
  NG008:  'NG008',
  NG014:  'NG014',
  SBN025: 'SBN025',
  SBN005: 'SBN005',
  SBN002: 'SBN002',
  SBN022: 'SBN022',
  ST300:  'ST300',
  SBN013: 'SBN013',
  SPN023: 'SPN023'
};

function readCookie(headerValue, name) {
  if (!headerValue) return null;
  for (const part of String(headerValue).split(';')) {
    const trimmed = part.trim();
    const idx = trimmed.indexOf('=');
    if (idx > 0 && trimmed.slice(0, idx) === name) {
      return decodeURIComponent(trimmed.slice(idx + 1));
    }
  }
  return null;
}

// Verify the dsi_mgr cookie that /api/dashboard-login issued. Same shape as
// the edge middleware: base64url(JSON(payload)).base64url(HMAC-SHA-256(payload, secret)).
function verifyDashboardCookie(req) {
  const secret = process.env.DASHBOARD_SECRET;
  if (!secret) return false;
  const token = readCookie(req.headers && req.headers.cookie, 'dsi_mgr');
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let payload;
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    payload = JSON.parse(json);
  } catch (e) { return false; }
  if (!payload || typeof payload.e !== 'number' || payload.e < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  let provided;
  try { provided = Buffer.from(sigB64, 'base64url'); }
  catch (e) { return false; }
  if (provided.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(expected, provided); }
  catch (e) { return false; }
}

// Retry transient Airtable failures: 429 (rate limit), 5xx server errors,
// and network/abort errors. The dashboard fires 13 QC + 3 batch fetches in
// parallel per refresh, which routinely brushes against Airtable's 5 req/s
// rate limit and causes one or two tables to fail intermittently — which
// was showing up to managers as a flickering ⚠ QC: SPN004 badge and a
// 100-record drop in the Total Beams KPI when SPN004 was the unlucky one.
async function fetchAirtableRaw(table, params = {}, attempt = 0) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    throw new Error('Airtable credentials are not configured on the server.');
  }
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(item => qs.append(k, item));
    else if (v != null) qs.append(k, v);
  });
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?${qs.toString()}`;

  const MAX_RETRIES = 4;
  const RETRYABLE = new Set([429, 502, 503, 504]);
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
  } catch (netErr) {
    if (attempt < MAX_RETRIES) {
      await sleep(backoffMs(attempt));
      return fetchAirtableRaw(table, params, attempt + 1);
    }
    throw netErr;
  }

  if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
    // Honour Retry-After when Airtable sets it (sent on 429), else exponential.
    const retryAfter = Number(res.headers.get('Retry-After'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 5000)
      : backoffMs(attempt);
    await sleep(wait);
    return fetchAirtableRaw(table, params, attempt + 1);
  }

  return res;
}

// 250ms, 500ms, 1s, 2s — capped low because rate-limit windows are short
// and Vercel serverless functions have a 10s default timeout.
function backoffMs(attempt) {
  return Math.min(250 * (1 << attempt), 2000);
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAirtable(table, params = {}) {
  const res = await fetchAirtableRaw(table, params);
  const data = await res.json();
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `Airtable error ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data.records || [];
}

// Walk Airtable's offset-based pagination to fetch ALL records from a table.
// Each page uses the same retry/backoff logic as the single-page fetch above.
// A cap of 50 pages = 5000 records is well above any current project size;
// raise if needed.
async function fetchAirtableAll(table, params = {}, maxPages = 50) {
  const out = [];
  let offset;
  for (let i = 0; i < maxPages; i++) {
    const page = { ...params, pageSize: 100 };
    if (offset) page.offset = offset;
    const res = await fetchAirtableRaw(table, page);
    const data = await res.json();
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || `Airtable error ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    if (data.records) out.push(...data.records);
    if (!data.offset) return out;
    offset = data.offset;
  }
  return out;
}

// Look up an existing record in a batch table by its Idempotency Key.
// Returns the record object (with `id` and `fields`) or `null` if none exists.
// On Airtable error (eg the table doesn't have the field yet), returns `null`
// so the caller falls through to a normal insert instead of erroring out.
async function findByIdempotencyKey(table, key) {
  if (!key) return null;
  const safe = String(key).replace(/'/g, "\\'");
  try {
    const records = await fetchAirtable(table, {
      filterByFormula: `{Idempotency Key} = '${safe}'`,
      maxRecords: 1
    });
    return records && records.length ? records[0] : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  PROJECT_TABLES,
  readCookie,
  verifyDashboardCookie,
  fetchAirtable,
  fetchAirtableAll,
  findByIdempotencyKey
};
