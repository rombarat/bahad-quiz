// SUMIT (OfficeGuy) billing API: monthly recurring charge, cancel, and the payments list used for renewals.
// Credentials go in the JSON body. The response envelope is { Status, UserErrorMessage, TechnicalErrorDetails, Data },
// Status 0 = success. Paths and field names follow community docs of the SUMIT API; verify in the SUMIT test org.
const BASE = () => (process.env.SUMIT_API_BASE || 'https://api.sumit.co.il').replace(/\/$/, '');

export class SumitError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}

async function call(path, body) {
  const r = await fetch(`${BASE()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Language': 'he' },
    body: JSON.stringify({
      Credentials: { CompanyID: Number(process.env.SUMIT_COMPANY_ID), APIKey: process.env.SUMIT_API_KEY },
      ...body
    }),
    cache: 'no-store'
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new SumitError(`SUMIT HTTP ${r.status}`, j);
  if (j.Status !== 0 && j.Status !== '0' && j.Status !== 'Success') {
    throw new SumitError(j.UserErrorMessage || 'SUMIT error', j.TechnicalErrorDetails || j);
  }
  return j.Data || {};
}

export const PRICE = () => Number(process.env.SUB_PRICE || 19.9);

// Charges the first month now and creates a monthly standing order (הוראת קבע) for it.
export async function startMonthly({ userId, email, name, token }) {
  const day = new Date().toISOString().slice(0, 10);
  const data = await call('/billing/recurring/charge/', {
    Customer: { ExternalIdentifier: `user-${userId}`, SearchMode: 2, Name: name || email, EmailAddress: email },
    SingleUseToken: token,
    Items: [{
      Item: { Name: 'מנוי חודשי לבוחן בה״ד 1', Duration_Months: 1 },
      Quantity: 1, UnitPrice: PRICE(), Currency: 0, Duration_Months: 1
    }],
    VATIncluded: true,
    OnlyDocument: false,
    UniqueIdentifier: `sub-${userId}-${day}`
  });
  const p = data.Payment || {};
  const ok = p.ValidPayment === true && (p.Status === '000' || p.Status === 0 || p.Status === '0');
  return {
    ok,
    message: ok ? null : (p.StatusDescription || p.Status || 'התשלום נדחה'),
    paymentId: p.ID ? Number(p.ID) : null,
    customerId: Number(p.CustomerID || data.CustomerID) || null,
    recurringId: Array.isArray(p.RecurringCustomerItemIDs) && p.RecurringCustomerItemIDs.length ? Number(p.RecurringCustomerItemIDs[0]) : null,
    amount: Number(p.Amount) || PRICE()
  };
}

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
