// The signed-in user and their access.
// GET               → { user, signedIn, access }  (also claims payments made with the user's email)
// POST { action: 'sync' }   → same, called when the user comes back from the payment page
// POST { action: 'cancel' } → stop the monthly charge; access stays until the paid period ends
// POST { action: 'logout' }
// Payment itself happens on SUMIT's payment page; the webhook (api/sumit-webhook.mjs) turns it into access.
import { sql } from './_lib/db.mjs';
import { setSessionCookie } from './_lib/session.mjs';
import { accessFor } from './_lib/access.mjs';
import { claimPayments, confirmReturn } from './_lib/billing.mjs';
import { cancelAllRecurring, sumitConfigured, SumitError } from './_lib/sumit.mjs';
import { notify, adminLink } from './_lib/notify.mjs';

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

    // Coming back from SUMIT's payment page: keep the parameters it added to the return address (shown in /admin),
    // to learn what SUMIT passes back. Logged once per return, signed in or not.
    if (b.action === 'sync' && b.ret && typeof b.ret === 'object' && Object.keys(b.ret).some(k => k !== 'paid')) {
      const pre = await accessFor(req);
      const body = JSON.stringify({ source: 'return-from-payment-page', user: pre.user ? pre.user.email : null, params: b.ret }).slice(0, 4000);
      await sql`insert into webhook_events (body) values (${body})`;
      // the payment id SUMIT put in the return address → verify it with SUMIT and open access now
      const pid = b.ret['OG-PaymentID'] || b.ret['og-paymentid'];
      if (pid && pre.viaSession && !pre.access.full) {
        const result = await confirmReturn(pre.userId, String(pid));
        if (result !== 'ok') console.error('return payment not confirmed', result);
        const after = await current(req);
        return res.status(200).json({ user: after.user, signedIn: true, access: after.access, confirm: result });
      }
    }

    const a = await current(req);
    if (!a.viaSession) return res.status(401).json({ error: 'login required' });

    if (b.action === 'sync') return res.status(200).json({ user: a.user, signedIn: true, access: a.access });

    if (b.action === 'cancel') {
      if (!a.sub || a.sub.status !== 'active') return res.status(400).json({ error: 'no active subscription' });
      // With the API key and the SUMIT customer (saved from their receipt), stop the standing order right away.
      // If that isn't possible, record the request; the owner gets an email and sees it in /admin.
      let status = 'cancel_requested';
      if (sumitConfigured() && a.sub.sumit_customer_id) {
        try {
          const n = await cancelAllRecurring(a.sub.sumit_customer_id, a.sub.sumit_recurring_id);
          if (n > 0) status = 'canceled';
          else console.error('cancel: no active standing order found for customer', a.sub.sumit_customer_id);
        } catch (e) {
          if (!(e instanceof SumitError)) throw e;
          console.error('cancel at SUMIT failed, recorded as a request', e.message);
        }
      }
      await sql`update subscriptions set status = ${status}, updated_at = now() where user_id = ${a.userId}`;
      const until = a.access.paidUntil ? new Date(a.access.paidUntil).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '';
      await notify(status === 'canceled' ? `מנוי בוטל: ${a.user.email}` : `בקשת ביטול מנוי: ${a.user.email}`, [
        `${a.user.name || ''} (${a.user.email}) ביקש/ה לבטל את המנוי.`,
        status === 'canceled'
          ? 'הוראת הקבע בוטלה אוטומטית בסאמיט. אין צורך לעשות כלום.'
          : 'מה לעשות: לבטל את הוראת הקבע של הלקוח בסאמיט לפני החיוב הבא, ואז לסמן "ביטלתי בסאמיט" בדף הניהול.',
        until && `הגישה נשארת פתוחה עד ${until}.`,
        `דף הניהול: ${adminLink(req)}`
      ]);
      const after = await accessFor(req);
      return res.status(200).json({ user: after.user, signedIn: true, access: after.access });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('account', e && e.message);
    return res.status(500).json({ error: 'server error' });
  }
}
