// Owner's page at https://<site>/admin: subscribers, cancel requests waiting to be done in SUMIT,
// payments no user matched, and the last webhook bodies.
// Sign-in with ADMIN_USER / ADMIN_PASSWORD (Vercel env). The sign-in is a signed HttpOnly cookie for 30 days;
// changing the password signs every browser out.
// Actions: give months to an email (e.g. someone who paid with a different email), mark a cancel as done, revoke.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from './_lib/db.mjs';
import { cookies } from './_lib/session.mjs';
import { applyPayment } from './_lib/billing.mjs';
import { sumitConfigured, listPayments, SumitError } from './_lib/sumit.mjs';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = d => d ? new Date(d).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }) : '';

const COOKIE = 'bq_admin', DAYS = 30;
const same = (x, y) => { const a = Buffer.from(String(x || '')), b = Buffer.from(String(y || '')); return a.length === b.length && timingSafeEqual(a, b); };
const configured = () => !!(process.env.ADMIN_USER && (process.env.ADMIN_PASSWORD || '').length >= 8 && (process.env.SESSION_SECRET || '').length >= 32);
const sign = body => createHmac('sha256', `${process.env.SESSION_SECRET}|admin|${process.env.ADMIN_USER}|${process.env.ADMIN_PASSWORD}`).update(body).digest('base64url');
function makeToken() {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + DAYS * 864e5 })).toString('base64url');
  return `${body}.${sign(body)}`;
}
function signedIn(req) {
  if (!configured()) return false;
  const [body, sig] = String(cookies(req)[COOKIE] || '').split('.');
  if (!body || !sig || !same(sig, sign(body))) return false;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}
function setCookie(res, token) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${token ? DAYS * 86400 : 0}`];
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

const STYLE = `:root{--bg:#f6f5ef;--surface:#fff;--fg:#1c2117;--muted:#6a7160;--line:#dedcd0;--accent:#58702a;--warn:#b45309;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#12150f;--surface:#1b1f17;--fg:#eceee4;--muted:#9ba290;--line:#30362a;--accent:#9cbc52;--warn:#f59e0b;--bad:#f97066}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Arial,sans-serif}main{max-width:900px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.1rem;margin:24px 0 8px}.muted{color:var(--muted)}.warn{color:var(--warn)}
.box{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px;overflow-x:auto}
table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
form{display:flex;flex-wrap:wrap;gap:8px;align-items:center}input,select,button{font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
input[type=email]{min-width:0;flex:1 1 220px;direction:ltr}button{background:var(--accent);color:#fff;border:0;font-weight:700}
.msg{background:var(--surface);border:2px solid var(--accent);border-radius:10px;padding:8px 12px;margin:10px 0}
.err{border-color:var(--bad)}
pre{white-space:pre-wrap;word-break:break-all;font-size:12px;margin:4px 0 0;direction:ltr;text-align:left}details{border-bottom:1px solid var(--line);padding:6px 0}
.login{max-width:340px;margin:12vh auto 0}.login form{flex-direction:column;align-items:stretch}.login input{direction:ltr}
.user{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--line)}.user:last-child{border-bottom:0}.user b{word-break:break-all}.user form button{white-space:nowrap}button.ghost{background:none;color:var(--muted);border:1px solid var(--line)}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.top form button{background:none;color:var(--muted);text-decoration:underline;padding:0}`;
const page = (title, inner) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title><style>${STYLE}</style></head><body><main>${inner}</main></body></html>`;
const loginPage = err => page('כניסה לניהול', `<div class="login"><h1>ניהול מנויים</h1><p class="muted">השביל לבה״ד</p>
${err ? `<div class="msg err">${esc(err)}</div>` : ''}
<div class="box"><form method="post"><input type="hidden" name="do" value="login">
<label>שם משתמש<br><input name="user" autocomplete="username" required autofocus></label>
<label>סיסמה<br><input name="password" type="password" autocomplete="current-password" required></label>
<button>כניסה</button></form></div></div>`);
function send(res, status, html) {
  res.statusCode = status; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html);
}
function form(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return Object.fromEntries(new URLSearchParams(String(req.body || '')));
}

// Sends this server's own webhook the same kind of request SUMIT sends after a payment, so the whole path
// (webhook → match by email → access) can be tried without charging a card.
async function simulate(req, email) {
  const key = process.env.SUMIT_WEBHOOK_KEY;
  if (!key) return 'חסר SUMIT_WEBHOOK_KEY ב־Vercel';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (/^localhost|^127\./.test(host) ? 'http' : 'https');
  const id = `SIM-${Date.now()}`;
  const r = await fetch(`${proto}://${host}/api/sumit-webhook?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Simulated: true, Customer: { Name: 'הדמיה', EmailAddress: email }, Document: { ID: id, Total: 19.9 } }),
    signal: AbortSignal.timeout(15000)
  }).catch(e => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return `ההדמיה נכשלה (${r.status || 'אין חיבור'}): ${j.error || ''}`;
  if (!j.matched) return `העדכון התקבל, אבל אין עדיין משתמש עם ${email}. התשלום שמור, והגישה תיפתח כשהוא יתחבר עם Google במייל הזה.`;
  const [s] = await sql`select s.paid_until from subscriptions s join users u on u.id = s.user_id where lower(u.email) = ${email}`;
  return `הצליח: העדכון שויך ל־${email} והמנוי פעיל עד ${day(s && s.paid_until)}. באפליקציה: לרענן או ללחוץ "כבר שילמתי, לבדוק שוב".`;
}

// Is the SUMIT API key working? Lists the last two days of payments.
async function sumitCheck() {
  if (!sumitConfigured()) return 'חסרים SUMIT_COMPANY_ID או SUMIT_API_KEY ב־Vercel.';
  try {
    const to = new Date(), from = new Date(to.getTime() - 2 * 864e5);
    const list = await listPayments(from, to);
    return `החיבור לסאמיט תקין ✓ (נמצאו ${list.length} תשלומים ביומיים האחרונים)`;
  } catch (e) {
    if (e instanceof SumitError) return `סאמיט החזירה שגיאה: ${e.message}. בדקו את מספר החברה ואת מפתח ה־API.`;
    return `אין חיבור לסאמיט: ${e.message}`;
  }
}
// Run a stored webhook body through the webhook again (e.g. after the API key was added).
async function reprocess(req, id) {
  const [ev] = await sql`select body from webhook_events where id = ${Number(id)}`;
  if (!ev) return 'העדכון לא נמצא';
  const raw = String(ev.body).split('\n\nמסאמיט: ')[0];
  if (/"Simulated":true/.test(raw)) return 'זו הדמיה, אין מה לעבד מחדש';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (/^localhost|^127\./.test(host) ? 'http' : 'https');
  const r = await fetch(`${proto}://${host}/api/sumit-webhook?key=${encodeURIComponent(process.env.SUMIT_WEBHOOK_KEY || '')}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw, signal: AbortSignal.timeout(20000)
  }).catch(e => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return `העיבוד נכשל (${r.status}): ${j.error || ''}`;
  return j.matched ? 'עובד מחדש: התשלום שויך והמנוי נפתח ✓' : `עובד מחדש, אבל לא שויך${j.note ? ' (' + j.note + ')' : ''}. פתחו את העדכון החדש למטה כדי לראות מה סאמיט החזירה.`;
}

async function act(b, req) {
  if (b.do === 'sumitcheck') return sumitCheck();
  if (b.do === 'reprocess') return reprocess(req, b.ev);
  const email = String(b.email || '').trim().toLowerCase();
  if (!email) return 'חסר מייל';
  if (b.do === 'simulate') return simulate(req, email);
  if (b.do === 'grant') {
    const months = Math.min(12, Math.max(1, Number(b.months) || 1));
    // stack on top of any time already paid for
    const [cur] = await sql`select s.paid_until from subscriptions s join users u on u.id = s.user_id where lower(u.email) = ${email}`;
    const base = new Date(Math.max(Date.now(), cur && cur.paid_until ? new Date(cur.paid_until).getTime() - 3 * 864e5 : 0));
    for (let i = 0; i < months; i++) {
      const at = new Date(base); at.setMonth(at.getMonth() + i);
      await applyPayment({ ref: `manual-${Date.now()}-${i}`, email, paidAt: at, kind: 'manual' });
    }
    const [u] = await sql`select id from users where lower(email) = ${email}`;
    return u ? `נוספו ${months} חודשים ל־${email}` : `נשמר. ${email} עוד לא התחבר; הגישה תיפתח כשיתחבר עם המייל הזה`;
  }
  const [u] = await sql`select id from users where lower(email) = ${email}`;
  if (!u) return `אין משתמש עם ${email}`;
  if (b.do === 'canceled') { await sql`update subscriptions set status = 'canceled', updated_at = now() where user_id = ${u.id}`; return `סומן כבוטל: ${email}`; }
  if (b.do === 'revoke') { await sql`update subscriptions set status = 'canceled', paid_until = now(), updated_at = now() where user_id = ${u.id}`; return `הגישה של ${email} נסגרה`; }
  return 'פעולה לא מוכרת';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const b = req.method === 'POST' ? form(req) : {};
  if (!configured()) return send(res, 503, page('ניהול', '<div class="login"><h1>ניהול מנויים</h1><div class="msg err">הכניסה עוד לא הוגדרה: צריך להגדיר ב־Vercel את ADMIN_USER, ADMIN_PASSWORD (8 תווים לפחות) ו־SESSION_SECRET.</div></div>'));
  if (b.do === 'login') {
    const ok = same(String(b.user || '').trim(), process.env.ADMIN_USER) & same(b.password, process.env.ADMIN_PASSWORD);
    if (!ok) { await new Promise(r => setTimeout(r, 1000)); return send(res, 401, loginPage('שם משתמש או סיסמה שגויים')); }
    setCookie(res, makeToken());
    res.statusCode = 303; res.setHeader('Location', req.url.split('?')[0]); return res.end();
  }
  if (b.do === 'logout') { setCookie(res, ''); return send(res, 200, loginPage('')); }
  // the login form itself is a normal page (200); an action posted without a login is refused (401)
  if (!signedIn(req)) return send(res, req.method === 'GET' ? 200 : 401, loginPage(''));
  try {
    // Post/Redirect/Get: do the action, then send the browser back to a plain GET of /admin with the result
    // in a short-lived cookie, so refreshing or going back never repeats an action (e.g. adding months twice).
    if (req.method === 'POST') {
      const done = await act(b, req);
      const parts = [`bq_admin_msg=${encodeURIComponent(String(done || '')).slice(0, 1500)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=60'];
      if (process.env.VERCEL) parts.push('Secure');
      res.setHeader('Set-Cookie', parts.join('; '));
      res.statusCode = 303; res.setHeader('Location', req.url.split('?')[0]); return res.end();
    }
    let msg = '';
    const flash = cookies(req).bq_admin_msg;
    if (flash) { msg = flash; res.setHeader('Set-Cookie', `bq_admin_msg=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.VERCEL ? '; Secure' : ''}`); }
    const subs = await sql`select u.email, u.name, s.status, s.paid_until, s.updated_at from subscriptions s join users u on u.id = s.user_id order by (s.status = 'cancel_requested') desc, s.paid_until desc limit 300`;
    const users = await sql`select u.email, u.name, u.created_at, s.status, s.paid_until from users u left join subscriptions s on s.user_id = u.id order by u.created_at desc limit 200`;
    const [{ n: userCount }] = await sql`select count(*)::int as n from users`;
    const orphans = await sql`select ref, email, amount, paid_at, kind from payments where user_id is null order by paid_at desc limit 100`;
    const events = await sql`select id, received_at, matched, body from webhook_events order by id desc limit 15`;
    const active = subs.filter(s => s.paid_until && new Date(s.paid_until) > new Date()).length;
    const requests = subs.filter(s => s.status === 'cancel_requested');
    const row = (cells) => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
    const status = s => ({ active: 'פעיל', cancel_requested: '<b class="warn">ביקש ביטול</b>', canceled: 'בוטל', failed: 'נכשל' }[s] || esc(s));
    const html = page('ניהול מנויים', `<div class="top"><div><h1>ניהול מנויים</h1><p class="muted">${active} מנויים עם גישה פעילה</p></div><form method="post"><input type="hidden" name="do" value="logout"><button>יציאה</button></form></div>
${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
<h2>פעולה לפי מייל</h2><div class="box"><form method="post">
<input type="email" name="email" placeholder="המייל שאיתו התחבר באפליקציה" required>
<select name="do"><option value="grant">הוספת חודשים</option><option value="simulate">הדמיית תשלום (בלי חיוב)</option><option value="canceled">סימון: ביטלתי בסאמיט</option><option value="revoke">סגירת גישה עכשיו</option></select>
<input type="number" name="months" value="1" min="1" max="12" style="width:70px"><button>ביצוע</button></form></div>
<h2>בקשות ביטול (${requests.length})</h2><div class="box">${requests.length ? `<p class="muted">לבטל את הוראת הקבע של כל אחד מהם בסאמיט, ואז לסמן "ביטלתי בסאמיט".</p><table>${requests.map(s => row([esc(s.email), esc(s.name), `גישה עד ${day(s.paid_until)}`, `ביקש ב־${day(s.updated_at)}`])).join('')}</table>` : '<span class="muted">אין</span>'}</div>
<h2>תשלומים שלא שויכו למשתמש (${orphans.length})</h2><div class="box">${orphans.length ? `<p class="muted">המייל בתשלום לא תואם אף משתמש. כשהמשתמש יתחבר עם המייל הזה הגישה תיפתח לבד; אם שילם עם מייל אחר, הוסיפו לו חודש לפי המייל שלו באפליקציה.</p><table>${orphans.map(o => row([esc(o.email || '(בלי מייל)'), esc(o.amount), day(o.paid_at), esc(o.kind)])).join('')}</table>` : '<span class="muted">אין</span>'}</div>
<h2>מנויים (${subs.length})</h2><div class="box">${subs.length ? `<table><tr><th>מייל</th><th>שם</th><th>מצב</th><th>גישה עד</th></tr>${subs.map(s => row([esc(s.email), esc(s.name), status(s.status), day(s.paid_until)])).join('')}</table>` : '<span class="muted">עוד אין</span>'}</div>
<h2>כל מי שהתחבר עם Google (${userCount})</h2><div class="box"><p class="muted">"הדמיית תשלום" שולחת לשרת את אותו עדכון שסאמיט שולחת אחרי תשלום, בלי חיוב, ופותחת למשתמש מנוי לחודש. לניקוי אחרי בדיקה: "סגירת גישה".</p>${users.length ? users.map(u => { const on = u.paid_until && new Date(u.paid_until) > new Date();
  const btn = (d, label, cls) => `<form method="post"><input type="hidden" name="email" value="${esc(u.email)}"><input type="hidden" name="do" value="${d}"><button class="${cls || ''}">${label}</button></form>`;
  return `<div class="user"><div><b dir="ltr">${esc(u.email)}</b><div class="muted">${esc(u.name || '')} · הצטרף ${day(u.created_at)}</div>
    <div>${on ? `מנוי: ${status(u.status)} עד ${day(u.paid_until)}` : '<span class="muted">בלי מנוי</span>'}</div></div>
    ${on ? btn('revoke', 'סגירת גישה', 'ghost') : btn('simulate', 'הדמיית תשלום')}</div>`; }).join('') : '<span class="muted">עוד אף אחד</span>'}</div>
<h2>עדכונים אחרונים מסאמיט</h2><div class="box"><form method="post" style="margin-bottom:8px"><input type="hidden" name="do" value="sumitcheck"><button>בדיקת חיבור לסאמיט</button></form>
${events.length ? events.map(e => `<details><summary>${day(e.received_at)} · ${e.matched ? 'שויך' : '<span class="warn">לא שויך</span>'}</summary>${!e.matched && !/"Simulated":true/.test(e.body) && !/^\{"source":"return/.test(e.body) ? `<form method="post" style="margin:6px 0"><input type="hidden" name="do" value="reprocess"><input type="hidden" name="ev" value="${e.id}"><button>עיבוד מחדש</button></form>` : ''}<pre>${esc(e.body)}</pre></details>`).join('') : '<span class="muted">עוד לא הגיע אף עדכון</span>'}</div>
`);
    return send(res, 200, html);
  } catch (e) {
    console.error('admin', e && e.message);
    res.statusCode = 500; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('server error');
  }
}
