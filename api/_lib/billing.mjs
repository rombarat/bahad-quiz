// Turning a payment into access.
// Payments arrive from SUMIT's payment page through the webhook (and, when the API key is set, the daily check).
// A payment is tied to a user by the email typed on the payment page, which should be the user's Google email.
// A payment whose email has no user yet waits in the table and is claimed when that person signs in.
import { sql } from './db.mjs';

export const GRACE_DAYS = 3;

// Paid through one month after the payment, plus a few days so a renewal charged a day late doesn't lock anyone out.
export function periodEnd(paidAt) {
  const x = new Date(paidAt);
  x.setMonth(x.getMonth() + 1);
  x.setDate(x.getDate() + GRACE_DAYS);
  x.setUTCHours(23, 59, 59, 0); // whole days, so the same charge reported at different times gives the same date
  return x;
}

// Extends the user's subscription to cover a payment made at paidAt.
// Idempotent per period: the same charge reported twice (webhook and daily check) only ever moves paid_until to the same date.
export async function grant(userId, paidAt, customerId) {
  const until = periodEnd(paidAt).toISOString();
  await sql`
    insert into subscriptions (user_id, status, paid_until, sumit_customer_id)
    values (${userId}, 'active', ${until}, ${customerId || null})
    on conflict (user_id) do update set
      -- a payment after the old period ran out is a new subscription; otherwise it's a renewal and a pending cancel stays
      status = case when subscriptions.paid_until is null or subscriptions.paid_until < now() then 'active' else subscriptions.status end,
      paid_until = greatest(coalesce(subscriptions.paid_until, excluded.paid_until), excluded.paid_until),
      sumit_customer_id = coalesce(excluded.sumit_customer_id, subscriptions.sumit_customer_id),
      updated_at = now()`;
}

// Records a payment once (by ref) and, if its user is known, extends their access. Returns { isNew, userId }.
export async function applyPayment({ ref, email, customerId, amount, paidAt, kind, userId }) {
  const at = paidAt ? new Date(paidAt) : new Date();
  const mail = email ? String(email).trim().toLowerCase() : null;
  let uid = userId || null;
  if (!uid && mail) {
    const [u] = await sql`select id from users where lower(email) = ${mail} order by id limit 1`;
    if (u) uid = Number(u.id);
  }
  if (!uid && customerId) {
    const [s] = await sql`select user_id from subscriptions where sumit_customer_id = ${customerId} limit 1`;
    if (s) uid = Number(s.user_id);
  }
  const ins = await sql`
    insert into payments (ref, user_id, email, sumit_customer_id, amount, paid_at, kind)
    values (${ref}, ${uid}, ${mail}, ${customerId || null}, ${amount == null ? null : amount}, ${at.toISOString()}, ${kind})
    on conflict (ref) do nothing returning ref`;
  if (uid && ins.length) await grant(uid, at, customerId); // a payment already recorded was already applied
  return { isNew: ins.length > 0, userId: uid };
}

// Payments made with this email before the person signed in (or before the webhook found them) → theirs now.
export async function claimPayments(userId, email) {
  if (!email) return 0;
  const rows = await sql`
    update payments set user_id = ${userId}
    where user_id is null and lower(email) = ${String(email).trim().toLowerCase()}
    returning paid_at, sumit_customer_id`;
  for (const r of rows) await grant(userId, r.paid_at, r.sumit_customer_id);
  return rows.length;
}

// The buyer is back from SUMIT's payment page with ?OG-PaymentID=... while signed in: ask SUMIT about that payment
// and, if it is real, recent, for the right amount and not someone else's, open access right away.
// Returns 'ok' | 'no-api' | 'not-found' | 'invalid' | 'old' | 'amount' | 'taken' | 'error'.
export async function confirmReturn(userId, paymentId) {
  const { sumitConfigured, getPayment, PRICE, SumitError } = await import('./sumit.mjs');
  if (!sumitConfigured()) return 'no-api';
  if (!/^\d{1,15}$/.test(String(paymentId || ''))) return 'not-found';
  const ref = `sumit-pay-${Number(paymentId)}`;
  const [have] = await sql`select user_id from payments where ref = ${ref}`;
  if (have && have.user_id && Number(have.user_id) !== userId) return 'taken';
  if (have && Number(have.user_id) === userId) return 'ok';
  let p;
  try { p = await getPayment(paymentId); } catch (e) {
    if (e instanceof SumitError) { console.error('confirmReturn', e.message); return 'error'; }
    throw e;
  }
  if (!p) return 'not-found';
  if (!p.valid) return 'invalid';
  if (p.date && Date.now() - new Date(p.date).getTime() > 3 * 864e5) return 'old';
  if (p.amount != null && p.amount < PRICE() - 0.01) return 'amount';
  // a standing-order customer already tied to another user can't be claimed by guessing their payment id
  if (p.customerId) {
    const [other] = await sql`select user_id from subscriptions where sumit_customer_id = ${p.customerId} and user_id <> ${userId} limit 1`;
    if (other) return 'taken';
  }
  if (have) { // already listed by the daily check, with no user yet
    await sql`update payments set user_id = ${userId} where ref = ${ref} and user_id is null`;
    await grant(userId, p.date || new Date(), p.customerId);
  } else {
    await applyPayment({ ref, userId, customerId: p.customerId, amount: p.amount, paidAt: p.date || new Date(), kind: 'return', email: p.email });
  }
  return 'ok';
}
