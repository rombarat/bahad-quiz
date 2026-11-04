// Sign-in with Google and the session cookie.
// The session is an HMAC-signed token in an HttpOnly cookie, so it is sent with every /api call
// and, on iPhone, copied into the installed home-screen app together with Safari's other cookies.
import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'bq_sess';
const MAX_AGE = 180 * 24 * 3600; // seconds

const b64u = buf => Buffer.from(buf).toString('base64url');
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET missing');
  return s;
}
const sign = data => createHmac('sha256', secret()).update(data).digest('base64url');

export function makeSession(userId) {
  const body = b64u(JSON.stringify({ uid: userId, exp: Date.now() + MAX_AGE * 1000 }));
  return `${body}.${sign(body)}`;
}

export function readSession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  let expected;
  try { expected = sign(body); } catch { return null; }
  const a = Buffer.from(sig || ''), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() && Number.isInteger(p.uid) ? p : null;
  } catch { return null; }
}

export function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

export const sessionOf = req => readSession(cookies(req)[COOKIE]);

export function setSessionCookie(res, token) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? MAX_AGE : 0}`];
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// Verifies a Google Identity Services ID token via Google's tokeninfo endpoint.
export async function verifyGoogleIdToken(idToken) {
  const base = process.env.GOOGLE_TOKENINFO_URL || 'https://oauth2.googleapis.com/tokeninfo';
  const r = await fetch(`${base}?id_token=${encodeURIComponent(idToken)}`, { cache: 'no-store' });
  if (!r.ok) return null;
  const t = await r.json();
  const okIss = t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com';
  const okAud = t.aud === process.env.GOOGLE_CLIENT_ID;
  const okExp = Number(t.exp) * 1000 > Date.now();
  const okEmail = t.email && (t.email_verified === true || t.email_verified === 'true');
  if (!okIss || !okAud || !okExp || !okEmail || !t.sub) return null;
  return { sub: String(t.sub), email: String(t.email).toLowerCase(), name: t.name ? String(t.name).slice(0, 80) : null };
}
