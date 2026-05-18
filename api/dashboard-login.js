const crypto = require('crypto');

function sign(payload, secret) {
  const json = JSON.stringify(payload);
  const payloadB64 = Buffer.from(json, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function safeEqual(a, b) {
  const ab = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const MAX_AGE_SECONDS = 8 * 60 * 60;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const U = process.env.DASHBOARD_USER;
  const P = process.env.DASHBOARD_PASSWORD;
  const S = process.env.DASHBOARD_SECRET;
  if (!U || !P || !S) {
    return res.status(500).json({ error: 'Authentication not configured on the server.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { username, password } = body || {};

  if (!safeEqual(username, U) || !safeEqual(password, P)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const exp = Date.now() + MAX_AGE_SECONDS * 1000;
  const token = sign({ u: U, e: exp }, S);
  res.setHeader(
    'Set-Cookie',
    `dsi_mgr=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`
  );
  return res.status(200).json({ ok: true });
};
