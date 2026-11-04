// SUMIT calls this when the payment page is paid and on every monthly charge of the standing order
// (set up in SUMIT as a trigger that sends the document/payment to a URL).
// URL: https://<site>/api/sumit-webhook?key=<SUMIT_WEBHOOK_KEY>
// SUMIT's payload layout isn't pinned down here, so it is read defensively: JSON or form, nested or flat,
// with the customer's email, customer id, amount and a payment/document id looked up by field name.
// Every body is saved in webhook_events, so anything that didn't match can be checked in /api/admin.
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from './_lib/db.mjs';
import { applyPayment } from './_lib/billing.mjs';

const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i;

function keyOk(given) {
  const want = process.env.SUMIT_WEBHOOK_KEY || '';
  const a = Buffer.from(String(given || '')), b = Buffer.from(want);
  return want.length >= 16 && a.length === b.length && timingSafeEqual(a, b);
}

// Body as an object: JSON, urlencoded, or a form whose field holds JSON.
export function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') {
    const t = b.trim();
    if (t.startsWith('{') || t.startsWith('[')) { try { b = JSON.parse(t); } catch { b = { raw: t }; } }
    else b = Object.fromEntries(new URLSearchParams(t));
  }
  if (!b || typeof b !== 'object') b = {};
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'string' && /^\s*[{[]/.test(v)) { try { b[k] = JSON.parse(v); } catch { /* keep text */ } }
  }
  return b;
}

// All leaves as [path, value], path in lower case like "data.customer.emailaddress".
function leaves(o, path = '', out = []) {
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) leaves(v, path ? `${path}.${String(k).toLowerCase()}` : String(k).toLowerCase(), out);
  } else out.push([path, o]);
  return out;
}

export function extract(body) {
  const all = leaves(body);
  const last = p => p.split('.').pop();
  const notOurs = p => !/(company|business|organization|organisation|user\b|sender|owner)/.test(p);
  // customer email: prefer fields under "customer", then any *mail* field, never the business's own
  const mails = all.filter(([p, v]) => typeof v === 'string' && EMAIL.test(v.trim()) && notOurs(p));
  const email = (mails.find(([p]) => /customer|client|payer|buyer/.test(p) && /mail/.test(p)) ||
                 mails.find(([p]) => /mail/.test(last(p))) || mails[0] || [])[1] || null;
  const num = v => { const n = Number(String(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) && String(v).trim() !== '' ? n : null; };
  const cust = all.find(([p, v]) => num(v) && (/customer(\.|_)?id$/.test(p) || (/customer/.test(p) && last(p) === 'id')));
  const amt = all.find(([p, v]) => num(v) != null && /^(amount|total|sum|totalamount|documentvalue|paymentamount|price)$/.test(last(p)));
  const idf = all.find(([p, v]) => v != null && v !== '' && /^(documentid|paymentid|transactionid|documentnumber|payment\.id|document\.id|id)$/.test(p.split('.').slice(-2).join('.').replace(/^(data|payload)\./, '')) );
  return {
    email: email ? email.trim().toLowerCase() : null,
    customerId: cust ? num(cust[1]) : null,
    amount: amt ? num(amt[1]) : null,
    id: idf ? String(idf[1]) : null
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method not allowed' }); }
  if (!keyOk(req.query && req.query.key)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const body = parseBody(req);
    const raw = JSON.stringify(body).slice(0, 20000);
    const [ev] = await sql`insert into webhook_events (body) values (${raw}) returning id`;
    const f = extract(body);
    const ref = f.id ? `sumit-${f.id}` : `hook-${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
    if (!f.email && !f.customerId) return res.status(200).json({ ok: true, matched: false, note: 'no customer email in payload' });
    const r = await applyPayment({ ref, email: f.email, customerId: f.customerId, amount: f.amount, kind: 'webhook' });
    if (r.userId) await sql`update webhook_events set matched = true where id = ${ev.id}`;
    return res.status(200).json({ ok: true, matched: !!r.userId });
  } catch (e) {
    console.error('sumit-webhook', e && e.message);
    return res.status(500).json({ error: 'server error' });
  }
}
