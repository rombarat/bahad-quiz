// The signed-in user and their access.
// GET               → { user, signedIn, access }  (also claims payments made with the user's email)
// POST { action: 'sync' }   → same, called when the user comes back from the payment page
// POST { action: 'cancel' } → stop the monthly charge; access stays until the paid period ends
// POST { action: 'logout' }
// Payment itself happens on SUMIT's payment page; the webhook (api/sumit-webhook.mjs) turns it into access.
import { sql } from './_lib/db.mjs';
import { setSessionCookie } from './_lib/session.mjs';
import { accessFor } from './_lib/access.mjs';
import { claimPayments } from './_lib/billing.mjs';
import { cancelMonthly, SumitError } from './_lib/sumit.mjs';

const body = req => typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

async function current(req) {
  let a = await accessFor(req);
  if (a.viaSession && !a.access.full && a.user) {
    if (await claimPayments(a.userId, a.user.email)) a = await accessFor(req);
  }
  return a;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const a = await current(req);
      return res.status(200).json({ user: a.user, signedIn: a.viaSession, access: a.access });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }
    const b = body(req);

    if (b.action === 'logout') { setSessionCookie(res, ''); return res.status(200).json({ ok: true }); }

    const a = await current(req);
    if (!a.viaSession) return res.status(401).json({ error: 'login required' });

    if (b.action === 'sync') return res.status(200).json({ user: a.user, signedIn: true, access: a.access });

    if (b.action === 'cancel') {
      if (!a.sub || a.sub.status !== 'active') return res.status(400).json({ error: 'no active subscription' });
      // With the API key and the standing-order id, cancel at SUMIT right away.
      // Otherwise record the request; the owner sees it in /api/admin and cancels the standing order in SUMIT.
      let status = 'cancel_requested';
      if (process.env.SUMIT_API_KEY && a.sub.sumit_customer_id && a.sub.sumit_recurring_id) {
        try {
          await cancelMonthly({ customerId: Number(a.sub.sumit_customer_id), recurringId: Number(a.sub.sumit_recurring_id) });
          status = 'canceled';
        } catch (e) {
          if (!(e instanceof SumitError)) throw e;
          console.error('cancel at SUMIT failed, recorded as a request', e.message);
        }
      }
      await sql`update subscriptions set status = ${status}, updated_at = now() where user_id = ${a.userId}`;
      const after = await accessFor(req);
      return res.status(200).json({ user: after.user, signedIn: true, access: after.access });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('account', e && e.message);
    return res.status(500).json({ error: 'server error' });
  }
}
