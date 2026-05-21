// api/project-progress.js — Per-project stage % rollup pulled from Google Sheets.
// Cookie-protected by dsi_mgr (same as /api/dashboard-data).
//
// Reads the PROJECT_PROGRESS tab of the HR-portal Google Sheet (reused via
// GOOGLE_SHEET_ID + GOOGLE_SERVICE_ACCOUNT_KEY env vars). The previous
// Airtable-derived per-project rollup was unreliable because Airtable
// pagination capped each project to 100 records; this endpoint uses
// manager-maintained stage percentages instead, so the numbers match the
// authoritative tracker.

const crypto = require('crypto');
const { verifyDashboardCookie } = require('../lib/dashboard-helpers');

const SHEET_TAB = 'PROJECT_PROGRESS';
const SHEET_RANGE = `${SHEET_TAB}!A1:E200`;
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

// 30s payload cache mirrors api/dashboard-data so dashboard auto-refreshes
// don't fan out to Google on every poll.
const PAYLOAD_TTL_MS = 30_000;
let PAYLOAD_CACHE = { data: null, builtAt: 0 };

// Access tokens are valid for 1 hour. Cache across warm invocations so we
// only mint a fresh JWT once per hour instead of every request.
let TOKEN_CACHE = { token: null, expiresAt: 0 };

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (TOKEN_CACHE.token && TOKEN_CACHE.expiresAt - 60 > now) {
    return TOKEN_CACHE.token;
  }

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not configured');
  let creds;
  try { creds = JSON.parse(raw); }
  catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON'); }
  if (!creds.client_email || !creds.private_key) {
    throw new Error('Service account JSON missing client_email/private_key');
  }

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: creds.client_email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const signingInput = `${header}.${claims}`;
  // Service-account JSON stores the key with literal \n escapes; turn those
  // back into real newlines before handing to crypto.
  const privateKey = creds.private_key.replace(/\\n/g, '\n');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token exchange failed: ${body.error_description || body.error || res.status}`);
  }
  TOKEN_CACHE = {
    token: body.access_token,
    expiresAt: now + (Number(body.expires_in) || 3600)
  };
  return body.access_token;
}

// Accept "65", "65%", " 65 %", "0.65" → 65. Returns null for blank/invalid so
// the dashboard can show a placeholder instead of a misleading 0.
function parsePct(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/%/g, '').trim();
  const n = Number(s);
  if (!isFinite(n)) return null;
  // Treat 0 < n <= 1 as a fractional percentage (0.65 → 65). 1.0 stays as 1
  // since "1%" is more plausible than "100%" expressed as the integer 1.
  if (n > 0 && n < 1) return Math.round(n * 1000) / 10;
  // Clamp to [0,100] and round to 1 decimal place.
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

async function fetchProgressRows() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID is not configured');
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(SHEET_RANGE)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Sheets API error ${res.status}: ${(data.error && data.error.message) || 'unknown'}`);
  }
  return data.values || [];
}

// Header row may be in any order — match by name so columns can be reordered
// in the sheet without breaking the dashboard.
function buildHeaderIndex(headers) {
  const norm = h => String(h || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const idx = Object.create(null);
  headers.forEach((h, i) => { idx[norm(h)] = i; });
  const pick = (...names) => {
    for (const n of names) {
      const i = idx[norm(n)];
      if (i !== undefined) return i;
    }
    return -1;
  };
  return {
    project: pick('project', 'project code', 'code'),
    overall: pick('overall %', 'overall', 'overall percent', 'overall progress'),
    qc: pick('qc %', 'qc', 'qc percent'),
    welding: pick('welding %', 'welding', 'welding percent'),
    painting: pick('painting %', 'painting', 'painting percent')
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

  const now = Date.now();
  const force = req.query && (req.query.fresh === '1' || req.query.nocache === '1');
  if (!force && PAYLOAD_CACHE.data && now - PAYLOAD_CACHE.builtAt < PAYLOAD_TTL_MS) {
    return res.status(200).json({
      ...PAYLOAD_CACHE.data,
      fromCache: true,
      cacheAgeMs: now - PAYLOAD_CACHE.builtAt
    });
  }

  try {
    const rows = await fetchProgressRows();
    if (!rows.length) {
      const empty = { generatedAt: new Date().toISOString(), projects: [], warning: 'Sheet is empty' };
      return res.status(200).json({ ...empty, fromCache: false, cacheAgeMs: 0 });
    }
    const headers = rows[0];
    const cols = buildHeaderIndex(headers);
    if (cols.project < 0) {
      return res.status(500).json({ error: `Could not find "Project" column. Headers seen: ${headers.join(', ')}` });
    }

    const projects = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const project = String(row[cols.project] || '').trim();
      if (!project) continue;
      projects.push({
        project,
        overall: cols.overall >= 0 ? parsePct(row[cols.overall]) : null,
        qc: cols.qc >= 0 ? parsePct(row[cols.qc]) : null,
        welding: cols.welding >= 0 ? parsePct(row[cols.welding]) : null,
        painting: cols.painting >= 0 ? parsePct(row[cols.painting]) : null
      });
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      projects
    };
    PAYLOAD_CACHE = { data: payload, builtAt: Date.now() };
    return res.status(200).json({ ...payload, fromCache: false, cacheAgeMs: 0 });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
