// Owner's page: subscribers, cancel requests waiting to be done in SUMIT, payments no user matched,
// and the last webhook bodies. Open https://<site>/api/admin?key=<ADMIN_KEY>
// Actions: give a month to an email (e.g. someone who paid with a different email), mark a cancel as done, revoke.
import { timingSafeEqual } from 'node:crypto';
import { sql } from './_lib/db.mjs';
import { applyPayment } from './_lib/billing.mjs';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = d => d ? new Date(d).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }) : '';

function keyOk(given) {
  const want = process.env.ADMIN_KEY || '';
  const a = Buffer.from(String(given || '')), b = Buffer.from(want);
  return want.length >= 16 && a.length === b.length && timingSafeEqual(a, b);
}
function form(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return Object.fromEntries(new URLSearchParams(String(req.body || '')));
}

async function act(b) {
  const email = String(b.email || '').trim().toLowerCase();
  if (!email) return 'חסר מייל';
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
  const key = (req.query && req.query.key) || b.key;
  if (!keyOk(key)) { res.statusCode = 401; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('unauthorized'); }
  try {
    let msg = '';
    if (req.method === 'POST') msg = await act(b);
    const subs = await sql`select u.email, u.name, s.status, s.paid_until, s.updated_at from subscriptions s join users u on u.id = s.user_id order by (s.status = 'cancel_requested') desc, s.paid_until desc limit 300`;
    const orphans = await sql`select ref, email, amount, paid_at, kind from payments where user_id is null order by paid_at desc limit 100`;
    const events = await sql`select id, received_at, matched, body from webhook_events order by id desc limit 15`;
    const k = esc(key);
    const active = subs.filter(s => s.paid_until && new Date(s.paid_until) > new Date()).length;
    const requests = subs.filter(s => s.status === 'cancel_requested');
    const row = (cells) => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
    const status = s => ({ active: 'פעיל', cancel_requested: '<b class="warn">ביקש ביטול</b>', canceled: 'בוטל', failed: 'נכשל' }[s] || esc(s));
    const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ניהול מנויים</title><style>
:root{--bg:#f6f5ef;--surface:#fff;--fg:#1c2117;--muted:#6a7160;--line:#dedcd0;--accent:#58702a;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#12150f;--surface:#1b1f17;--fg:#eceee4;--muted:#9ba290;--line:#30362a;--accent:#9cbc52;--warn:#f59e0b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Arial,sans-serif}main{max-width:900px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.1rem;margin:24px 0 8px}.muted{color:var(--muted)}.warn{color:var(--warn)}
.box{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px;overflow-x:auto}
table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
form{display:flex;flex-wrap:wrap;gap:8px;align-items:center}input,select,button{font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
input[type=email]{min-width:0;flex:1 1 220px;direction:ltr}button{background:var(--accent);color:#fff;border:0;font-weight:700}
.msg{background:var(--surface);border:2px solid var(--accent);border-radius:10px;padding:8px 12px;margin:10px 0}
pre{white-space:pre-wrap;word-break:break-all;font-size:12px;margin:4px 0 0;direction:ltr;text-align:left}details{border-bottom:1px solid var(--line);padding:6px 0}
</style></head><body><main>
<h1>ניהול מנויים</h1><p class="muted">${active} מנויים עם גישה פעילה</p>
${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
<h2>פעולה לפי מייל</h2><div class="box"><form method="post"><input type="hidden" name="key" value="${k}">
<input type="email" name="email" placeholder="המייל שאיתו התחבר באפליקציה" required>
<select name="do"><option value="grant">הוספת חודשים</option><option value="canceled">סימון: ביטלתי בסאמיט</option><option value="revoke">סגירת גישה עכשיו</option></select>
<input type="number" name="months" value="1" min="1" max="12" style="width:70px"><button>ביצוע</button></form></div>
<h2>בקשות ביטול (${requests.length})</h2><div class="box">${requests.length ? `<p class="muted">לבטל את הוראת הקבע של כל אחד מהם בסאמיט, ואז לסמן "ביטלתי בסאמיט".</p><table>${requests.map(s => row([esc(s.email), esc(s.name), `גישה עד ${day(s.paid_until)}`, `ביקש ב־${day(s.updated_at)}`])).join('')}</table>` : '<span class="muted">אין</span>'}</div>
<h2>תשלומים שלא שויכו למשתמש (${orphans.length})</h2><div class="box">${orphans.length ? `<p class="muted">המייל בתשלום לא תואם אף משתמש. כשהמשתמש יתחבר עם המייל הזה הגישה תיפתח לבד; אם שילם עם מייל אחר, הוסיפו לו חודש לפי המייל שלו באפליקציה.</p><table>${orphans.map(o => row([esc(o.email || '(בלי מייל)'), esc(o.amount), day(o.paid_at), esc(o.kind)])).join('')}</table>` : '<span class="muted">אין</span>'}</div>
<h2>מנויים</h2><div class="box"><table><tr><th>מייל</th><th>שם</th><th>מצב</th><th>גישה עד</th></tr>${subs.map(s => row([esc(s.email), esc(s.name), status(s.status), day(s.paid_until)])).join('')}</table></div>
<h2>עדכונים אחרונים מסאמיט</h2><div class="box">${events.length ? events.map(e => `<details><summary>${day(e.received_at)} · ${e.matched ? 'שויך' : '<span class="warn">לא שויך</span>'}</summary><pre>${esc(e.body)}</pre></details>`).join('') : '<span class="muted">עוד לא הגיע אף עדכון</span>'}</div>
</main></body></html>`;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(html);
  } catch (e) {
    console.error('admin', e && e.message);
    res.statusCode = 500; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('server error');
  }
}
