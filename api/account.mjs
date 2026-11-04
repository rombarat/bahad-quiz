// The signed-in user and their access.
// GET → { user, access }
// POST { action: 'subscribe', token } → charge the first month with a payments.js single-use token and open the standing order
// POST { action: 'cancel' }          → cancel the standing order; access stays until the paid period ends
// POST { action: 'logout' }
import { sql } from './_lib/db.mjs';
import { setSessionCookie } from './_lib/session.mjs';
import { accessFor } from './_lib/access.mjs';
import { startMonthly, cancelMonthly, SumitError } from './_lib/sumit.mjs';

const GRACE_DAYS = 3;
function monthAfter(d) { const x = new Date(d); x.setMonth(x.getMonth() + 1); x.setDate(x.getDate() + GRACE_DAYS); return x; }

function formBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return Object.fromEntries(new URLSearchParams(String(req.body || '')));
}

// Charge the first month with a payments.js single-use token and open the standing order.
async function subscribe(req, token) {
  const a = await accessFor(req);
  if (!a.viaSession) return { status: 401, error: 'login required', message: 'צריך להתחבר עם Google לפני התשלום' };
  if (a.access.reason === 'subscription' && a.sub && a.sub.status === 'active') return { status: 200, ok: true, user: a.user, access: a.access };
  if (!token || token.length > 200) return { status: 400, error: 'missing payment token', message: 'פרטי הכרטיס לא נקלטו' };
  let r;
  try {
    r = await startMonthly({ userId: a.userId, email: a.user.email, name: a.user.name, token });
  } catch (e) {
    if (e instanceof SumitError) return { status: 402, error: 'payment failed', message: e.message };
    throw e;
  }
  if (!r.ok) return { status: 402, error: 'payment failed', message: String(r.message) };
  const until = monthAfter(new Date());
  await sql`
    insert into subscriptions (user_id, status, paid_until, sumit_customer_id, sumit_recurring_id)
    values (${a.userId}, 'active', ${until.toISOString()}, ${r.customerId}, ${r.recurringId})
    on conflict (user_id) do update set status = 'active', paid_until = excluded.paid_until,
      sumit_customer_id = excluded.sumit_customer_id, sumit_recurring_id = excluded.sumit_recurring_id, updated_at = now()`;
  if (r.paymentId) await sql`insert into payments (sumit_payment_id, user_id, amount, kind) values (${r.paymentId}, ${a.userId}, ${r.amount}, 'first') on conflict do nothing`;
  const after = await accessFor(req);
  return { status: 200, ok: true, user: after.user, access: after.access };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const a = await accessFor(req);
      return res.status(200).json({ user: a.user, signedIn: a.viaSession, access: a.access });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }
    // The payment form posts here directly (payments.js puts only its single-use token, og-token, in the form;
    // the card fields have no name attribute, so card details never reach this server). Answer with a redirect.
    const isForm = String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded');
    const b = isForm ? formBody(req) : typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (isForm) {
      const r = await subscribe(req, String(b['og-token'] || ''));
      res.statusCode = 303;
      res.setHeader('Location', r.ok ? '/?paid=ok' : `/?paid=fail&m=${encodeURIComponent(r.message || '')}`);
      return res.end();
    }

    if (b.action === 'logout') { setSessionCookie(res, ''); return res.status(200).json({ ok: true }); }

    const a = await accessFor(req);
    if (!a.viaSession) return res.status(401).json({ error: 'login required' });

    if (b.action === 'subscribe') {
      const r = await subscribe(req, String(b.token || ''));
      if (r.status !== 200) return res.status(r.status).json({ error: r.error, message: r.message });
      return res.status(200).json({ user: r.user, access: r.access });
    }

    if (b.action === 'cancel') {
      if (!a.sub || a.sub.status !== 'active') return res.status(400).json({ error: 'no active subscription' });
      try {
        await cancelMonthly({ customerId: Number(a.sub.sumit_customer_id), recurringId: Number(a.sub.sumit_recurring_id) });
      } catch (e) {
        if (e instanceof SumitError) return res.status(502).json({ error: 'cancel failed', message: e.message });
        throw e;
      }
      await sql`update subscriptions set status = 'canceled', updated_at = now() where user_id = ${a.userId}`;
      const after = await accessFor(req);
      return res.status(200).json({ user: after.user, access: after.access });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('account', e && e.message);
    return res.status(500).json({ error: 'server error' });
  }
}
