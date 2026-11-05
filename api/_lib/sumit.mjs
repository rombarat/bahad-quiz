// SUMIT (OfficeGuy) billing API, used only when SUMIT_API_KEY is set: cancelling a standing order and the
// payments list that backs up the webhook. Customers pay on SUMIT's own payment page.
// Credentials go in the JSON body. The response envelope is { Status, UserErrorMessage, TechnicalErrorDetails, Data },
// Status 0 = success. Paths and field names follow community docs of the SUMIT API; verify in the SUMIT test org.
const BASE = () => (process.env.SUMIT_API_BASE || 'https://api.sumit.co.il').replace(/\/$/, '');

export class SumitError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}

export const sumitConfigured = () => !!(process.env.SUMIT_API_KEY && process.env.SUMIT_COMPANY_ID);

// Paths are /billing/...; some SUMIT docs write /api/billing/..., so a 404 is retried with that prefix.
async function call(path, body, retried) {
  const r = await fetch(`${BASE()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Language': 'he' },
    body: JSON.stringify({
      Credentials: { CompanyID: Number(process.env.SUMIT_COMPANY_ID), APIKey: process.env.SUMIT_API_KEY },
      ...body
    }),
    cache: 'no-store'
  });
  if (r.status === 404 && !retried && !path.startsWith('/api/')) return call(`/api${path}`, body, true);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new SumitError(`SUMIT HTTP ${r.status}`, j);
  if (j.Status !== 0 && j.Status !== '0' && j.Status !== 'Success') {
    throw new SumitError(j.UserErrorMessage || 'SUMIT error', j.TechnicalErrorDetails || j);
  }
  return j.Data || {};
}

export const PRICE = () => Number(process.env.SUB_PRICE || 19.9);

export function cancelMonthly({ customerId, recurringId }) {
  return call('/billing/recurring/cancel/', { Customer: { ID: customerId }, RecurringCustomerItemID: recurringId });
}

// Valid payments in a date range (all pages). Used once a day to extend subscriptions that renewed.
export async function listPayments(from, to) {
  const out = [];
  for (let start = 0, page = 0; page < 50; page++) {
    const d = await call('/billing/payments/list/', { Date_From: from.toISOString(), Date_To: to.toISOString(), Valid: true, StartIndex: start });
    const rows = Array.isArray(d.Payments) ? d.Payments : [];
    out.push(...rows);
    if (!d.HasNextPage || !rows.length) break;
    start += rows.length;
  }
  return out;
}

// One payment by its id, e.g. the OG-PaymentID SUMIT appends to the payment page's return address.
// Returns { id, customerId, valid, amount, date, email } or null if SUMIT has no such payment.
export async function getPayment(paymentId) {
  const d = await call('/billing/payments/get/', { PaymentID: Number(paymentId) });
  const p = d.Payment || d;
  if (!p || p.ID == null) return null;
  const status = p.Status == null ? null : String(p.Status);
  const valid = p.ValidPayment !== false && (status === null || status === '000' || status === '0');
  const c = p.Customer || {};
  return {
    id: Number(p.ID),
    customerId: Number(p.CustomerID || c.ID) || null,
    valid,
    amount: p.Amount == null ? null : Number(p.Amount),
    date: p.Date || p.PaymentDate || null,
    email: c.EmailAddress || p.EmailAddress || null
  };
}
