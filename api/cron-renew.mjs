// Daily (Vercel cron), a backup for the webhook: when SUMIT_API_KEY is set, read the last few days of payments
// from SUMIT and apply any that belong to a known customer. Applying the same charge twice changes nothing,
// so a payment the webhook already handled is harmless here. Without the API key this does nothing.
import { listPayments } from './_lib/sumit.mjs';
import { applyPayment } from './_lib/billing.mjs';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.SUMIT_API_KEY || !process.env.SUMIT_COMPANY_ID) return res.status(200).json({ skipped: 'no SUMIT API key' });
  try {
    const to = new Date(), from = new Date(to.getTime() - 4 * 864e5);
    const payments = await listPayments(from, to);
    let applied = 0;
    for (const p of payments) {
      const pid = Number(p.ID), cid = Number(p.CustomerID) || null;
      if (!pid || p.ValidPayment === false) continue;
      const email = (p.Customer && (p.Customer.EmailAddress || p.Customer.Email)) || p.EmailAddress || null;
      if (!cid && !email) continue;
      const r = await applyPayment({ ref: `sumit-pay-${pid}`, email, customerId: cid, amount: Number(p.Amount) || null, paidAt: p.Date || null, kind: 'daily-check' });
      if (r.isNew && r.userId) applied++;
    }
    return res.status(200).json({ checked: payments.length, applied });
  } catch (e) {
    console.error('cron-renew', e && e.message);
    return res.status(500).json({ error: 'server error' });
  }
}
