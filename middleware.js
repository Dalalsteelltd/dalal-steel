export const config = {
  matcher: ['/dashboard', '/dashboard.html'],
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readCookie(headerValue, name) {
  if (!headerValue) return null;
  for (const part of headerValue.split(';')) {
    const trimmed = part.trim();
    const idx = trimmed.indexOf('=');
    if (idx > 0 && trimmed.slice(0, idx) === name) {
      return decodeURIComponent(trimmed.slice(idx + 1));
    }
  }
  return null;
}

async function verifyToken(token, secret) {
  if (!token || !secret) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let payload;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(payloadB64)));
  } catch {
    return false;
  }
  if (!payload || typeof payload.e !== 'number' || payload.e < Date.now()) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  try {
    return await crypto.subtle.verify('HMAC', key, b64urlDecode(sigB64), enc.encode(payloadB64));
  } catch {
    return false;
  }
}

export default async function middleware(request) {
  const cookieHeader = request.headers.get('cookie');
  const token = readCookie(cookieHeader, 'dsi_mgr');
  const ok = await verifyToken(token, process.env.DASHBOARD_SECRET);
  if (ok) return;
  return Response.redirect(new URL('/dashboard/login', request.url), 302);
}
