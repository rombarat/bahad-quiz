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

// A card from SUMIT's CRM by its id: a credit-card transaction, a document or a customer.
// Triggers send only { Folder, EntityID, Type, Properties }; SUMIT's advice is to fetch the customer card
// this way to get the email. Returns the entity object (shape varies by folder) or null.
export async function getEntity(entityId) {
  const d = await call('/crm/data/getentity/', { EntityID: Number(entityId) });
  return d.Entity || d || null;
}
// A document (invoice/receipt) with its customer, for triggers on the documents folder.
export async function getDocument(documentId) {
  const d = await call('/accounting/documents/getdetails/', { DocumentID: Number(documentId) });
  return d.Document || d || null;
}

// The customer's active standing orders (הוראות קבע). Returns [{ id, raw }].
export async function listRecurring(customerId) {
  const d = await call('/billing/recurring/listforcustomer/', { Customer: { ID: Number(customerId) }, IncludeInactive: false });
  const items = Array.isArray(d.RecurringItems) ? d.RecurringItems : Array.isArray(d.Items) ? d.Items : Array.isArray(d) ? d : [];
  return items.map(r => ({ id: Number(r.ID ?? r.RecurringCustomerItemID ?? r.CustomerItemID), raw: r }))
    .filter(r => r.id && r.raw.IsActive !== false && !/cancel|בוטל|inactive/i.test(String(r.raw.Status ?? '')));
}

// Stops the monthly charge at SUMIT: the known standing order, or every active one this customer has
// (this business sells only the subscription). Returns how many were cancelled; throws SumitError on failure.
export async function cancelAllRecurring(customerId, knownRecurringId) {
  const ids = knownRecurringId ? [Number(knownRecurringId)] : (await listRecurring(customerId)).map(r => r.id);
  for (const id of ids) await cancelMonthly({ customerId: Number(customerId), recurringId: id });
  return ids.length;
}
