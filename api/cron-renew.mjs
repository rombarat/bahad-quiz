// Daily (Vercel cron): find the monthly charges SUMIT made in the last few days and extend those subscriptions.
// A charge that failed simply never shows up, so access ends a few days after the paid month.
import { sql } from './_lib/db.mjs';
import { listPayments } from './_lib/sumit.mjs';

const GRACE_DAYS = 3;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const to = new Date(), from = new Date(to.getTime() - 4 * 864e5);
    const payments = await listPayments(from, to);
    let extended = 0;
    for (const p of payments) {
      const pid = Number(p.ID), cid = Number(p.CustomerID);
      if (!pid || !cid || p.ValidPayment === false) continue;
      const [s] = await sql`select user_id, status from subscriptions where sumit_customer_id = ${cid}`;
      if (!s) continue;
      const inserted = await sql`insert into payments (sumit_payment_id, user_id, amount, paid_at, kind)
        values (${pid}, ${s.user_id}, ${Number(p.Amount) || null}, ${p.Date ? new Date(p.Date).toISOString() : new Date().toISOString()}, 'renewal')
        on conflict do nothing returning sumit_payment_id`;
      if (!inserted.length) continue; // already counted
      const paidAt = p.Date ? new Date(p.Date) : new Date();
      const until = new Date(paidAt); until.setMonth(until.getMonth() + 1); until.setDate(until.getDate() + GRACE_DAYS);
      await sql`update subscriptions set paid_until = greatest(coalesce(paid_until, ${until.toISOString()}), ${until.toISOString()}),
        status = case when status = 'canceled' then status else 'active' end, updated_at = now() where user_id = ${s.user_id}`;
      extended++;
    }
    return res.status(200).json({ checked: payments.length, extended });
  } catch (e) {
    console.error('cron-renew', e && e.message);
    return res.status(500).json({ error: 'server error' });
  }
}
