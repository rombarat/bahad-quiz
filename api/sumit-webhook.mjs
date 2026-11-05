// SUMIT calls this when the payment page is paid and on every monthly charge of the standing order
// (set up in SUMIT as a trigger that sends the document/payment to a URL).
// URL: https://<site>/api/sumit-webhook?key=<SUMIT_WEBHOOK_KEY>
// SUMIT's payload layout isn't pinned down here, so it is read defensively: JSON or form, nested or flat,
// with the customer's email, customer id, amount and a payment/document id looked up by field name.
// Every body is saved in webhook_events, so anything that didn't match can be checked in /api/admin.
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from './_lib/db.mjs';
import { applyPayment } from './_lib/billing.mjs';
import { notify, adminLink } from './_lib/notify.mjs';
import { sumitConfigured, getEntity, getDocument, PRICE } from './_lib/sumit.mjs';

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
  const last = p => p.split('.').filter(x => !/^\d+$/.test(x)).pop() || ''; // SUMIT wraps values in arrays: a.0 → a
  const notOurs = p => !/(company|business|organization|organisation|user\b|sender|owner|חברה|עסק|ארגון|שולח)/.test(p);
  // customer email: prefer fields under "customer", then any *mail* field, never the business's own
  const mails = all.filter(([p, v]) => typeof v === 'string' && EMAIL.test(v.trim()) && notOurs(p));
  // SUMIT triggers send the fields of a view, possibly under Hebrew names (לקוח, אימייל, דואר אלקטרוני...)
  const MAIL = /mail|מייל|דוא"?ל|דואר/;
  const email = (mails.find(([p]) => /customer|client|payer|buyer|לקוח|משלם/.test(p) && MAIL.test(p)) ||
                 mails.find(([p]) => MAIL.test(last(p))) || mails[0] || [])[1] || null;
  const num = v => { const n = Number(String(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) && String(v).trim() !== '' ? n : null; };
  const cust = all.find(([p, v]) => num(v) && (/customer(\.|_)?id$/.test(p) || (/customer|לקוח/.test(p) && /^(id|מזהה|מספר לקוח|מזהה לקוח)$/.test(last(p)))));
  const amt = all.find(([p, v]) => num(v) != null && /^(amount|total|sum|totalamount|documentvalue|paymentamount|price|accounting_displaycompanyvalue|accounting_totalvalue|accounting_value|סכום|סה"כ|סהכ|סכום כולל|סה"כ לתשלום|סכום כולל מע"מ)$/.test(last(p)));
  const idf = all.find(([p, v]) => v != null && v !== '' && /^(documentid|paymentid|transactionid|documentnumber|payment\.id|document\.id|id|entityid|מזהה|מספר מסמך|מזהה מסמך)$/.test(p.split('.').slice(-2).join('.').replace(/^(data|payload|json)\./, '')) );
  return {
    email: email ? email.trim().toLowerCase() : null,
    customerId: cust ? num(cust[1]) : null,
    amount: amt ? num(amt[1]) : null,
    id: idf ? String(idf[1]) : null
  };
}

// True if a fetched card says the payment didn't go through (declined, failed, cancelled).
export function paymentFailed(o) {
  const all = leaves(o);
  return all.some(([p, v]) => {
    const k = p.split('.').filter(x => !/^\d+$/.test(x)).pop() || '';
    if (/^(validpayment|isvalid|ispaid|תקין|שולם)$/.test(k)) return v === false || v === 'false' || v === 0 || v === 'לא';
    if (/(^|_)(status|סטטוס)$/.test(k) && typeof v === 'string') return /נכשל|נדחה|בוטל|failed|declined|cancel/i.test(v);
    return false;
  });
}

// The trigger gave no email: ask SUMIT for the card it points at, then for the customer card (needs the API key).
async function enrich(body, f) {
  const out = { ...f, fetched: [] };
  const entityId = Number(body.EntityID || (body.json && body.json.EntityID)) || null;
  if (entityId && !out.customerId) {
    let ent = await getEntity(entityId).catch(e => { console.error('getentity', e.message); return null; });
    if (!ent && /מסמך|document/i.test(JSON.stringify(body.Folder || ''))) ent = await getDocument(entityId).catch(() => null);
    if (ent) {
      out.fetched.push({ entity: entityId, data: ent });
      const g = extract(ent);
      out.email = out.email || g.email;
      out.customerId = out.customerId || g.customerId;
      if (out.amount == null) out.amount = g.amount;
      out.failed = paymentFailed(ent);
    }
  }
  if (!out.email && out.customerId) {
    const c = await getEntity(out.customerId).catch(e => { console.error('getentity customer', e.message); return null; });
    if (c) { out.fetched.push({ customer: out.customerId, data: c }); out.email = extract(c).email; }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // one line per call (no values), so a trigger that 'was sent' can be traced in the Vercel logs
  const shape = b => { try { const o = parseBody({ body: b }); return Object.keys(o).slice(0, 20).join(','); } catch { return '?'; } };
  console.log('sumit-webhook', JSON.stringify({ method: req.method, type: String(req.headers['content-type'] || ''),
    key: req.query && req.query.key ? (keyOk(req.query.key) ? 'ok' : 'wrong') : 'missing',
    bytes: typeof req.body === 'string' ? req.body.length : JSON.stringify(req.body || {}).length, fields: shape(req.body),
    agent: String(req.headers['user-agent'] || '').slice(0, 60) }));
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method not allowed' }); }
  if (!keyOk(req.query && req.query.key)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const body = parseBody(req);
    const raw = JSON.stringify(body).slice(0, 20000);
    const [ev] = await sql`insert into webhook_events (body) values (${raw}) returning id`;
    let f = extract(body);
    if (f.failed === undefined) f.failed = paymentFailed(body);
    if (!f.email && sumitConfigured()) {
      f = await enrich(body, f);
      // keep what SUMIT returned next to the trigger body, for the admin page
      if (f.fetched.length) await sql`update webhook_events set body = ${(raw + '\n\nמסאמיט: ' + JSON.stringify(f.fetched)).slice(0, 40000)} where id = ${ev.id}`;
    }
    // only an approved payment of at least the price opens access
    if (f.failed || (f.amount != null && f.amount > 0 && f.amount < PRICE() - 0.01)) {
      console.log('sumit-webhook: not a valid subscription payment', JSON.stringify({ failed: !!f.failed, amount: f.amount }));
      return res.status(200).json({ ok: true, matched: false, note: f.failed ? 'payment not approved' : 'amount below price' });
    }
    const ref = f.id ? `sumit-${f.id}` : `hook-${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
    const unmatched = what => notify(`תשלום שלא שויך למשתמש${f.email ? ': ' + f.email : ''}`, [
      what,
      f.amount != null && `סכום: ${f.amount}`,
      'אם המשלם התחבר לאפליקציה עם מייל אחר, הוסיפו לו חודש לפי המייל שלו בדף הניהול.',
      `דף הניהול: ${adminLink(req)}`
    ]);
    if (!f.email && !f.customerId) {
      await unmatched('הגיע עדכון תשלום מסאמיט בלי מייל של לקוח. כדאי לבדוק אותו בדף הניהול.');
      return res.status(200).json({ ok: true, matched: false, note: 'no customer email in payload' });
    }
    const r = await applyPayment({ ref, email: f.email, customerId: f.customerId, amount: f.amount, kind: 'webhook' });
    if (r.userId) await sql`update webhook_events set matched = true where id = ${ev.id}`;
    // the payer may simply not have signed in yet; the access opens by itself when they do, but tell the owner
    else if (r.isNew) await unmatched(`התקבל תשלום מ־${f.email || 'לקוח בלי מייל'}, ואין עדיין משתמש באפליקציה עם המייל הזה. אם יתחבר עם המייל הזה, הגישה תיפתח לו לבד.`);
    return res.status(200).json({ ok: true, matched: !!r.userId });
  } catch (e) {
    console.error('sumit-webhook', e && e.message);
    return res.status(500).json({ error: 'server error' });
  }
}
