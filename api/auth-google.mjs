// "Sign in with Google" in redirect mode: Google POSTs the ID token here as a form, we verify it,
// create or update the user, set the session cookie and send the browser back to the app.
// Redirect mode (not a popup) is used because it also works inside the installed iPhone app.
import { sql } from './_lib/db.mjs';
import { claimPayments } from './_lib/billing.mjs';
import { cookies, makeSession, setSessionCookie, verifyGoogleIdToken } from './_lib/session.mjs';

function formBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return Object.fromEntries(new URLSearchParams(String(req.body || '')));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const back = ok => { res.statusCode = 303; res.setHeader('Location', `/?login=${ok ? 'ok' : 'error'}`); res.end(); };
  if (req.method !== 'POST') return back(false);
  try {
    const b = formBody(req);
    // Google's CSRF check for redirect mode: the g_csrf_token cookie must equal the posted field
    const csrf = cookies(req).g_csrf_token;
    if (!csrf || csrf !== b.g_csrf_token) return back(false);
    const g = await verifyGoogleIdToken(String(b.credential || ''));
    if (!g) return back(false);
    const [u] = await sql`
      insert into users (google_sub, email, name, picture) values (${g.sub}, ${g.email}, ${g.name}, ${g.picture})
      on conflict (google_sub) do update set email = excluded.email, name = coalesce(excluded.name, users.name),
        picture = coalesce(excluded.picture, users.picture)
      returning id`;
    await claimPayments(Number(u.id), g.email);
    setSessionCookie(res, makeSession(Number(u.id)));
    return back(true);
  } catch (e) {
    console.error('auth-google', e && e.message);
    return back(false);
  }
}
