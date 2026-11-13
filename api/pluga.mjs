// The company board (/pluga): schedule, duties, guard shifts, tasks and notices for one company at בה״ד 1.
// Every call is a POST with { op, ... } from a signed-in user (the same Google sign-in as the quiz).
// A user belongs to one company. Roles: 'admin' (everything), 'editor' (adds and changes the boards),
// 'member' (reads everything, ticks tasks, keeps personal tasks). With "open editing" on, every member is an editor.
import { randomInt } from 'node:crypto';
import { sql, hasDb } from './_lib/db.mjs';
import { sessionOf } from './_lib/session.mjs';
import { parseIcs } from './_lib/ics.mjs';

const DAY = 86400000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DEFAULT_DUTIES = ['צוער תורן', 'מ״מ תורן', 'סמל תורן', 'תורנות מטבח', 'תורנות ניקיון', 'תורנות רס״ר', 'כיתת כוננות'];
const DEFAULT_POSTS = ['ש״ג', 'סיור', 'נשקייה'];
const EVENT_KINDS = ['lesson', 'field', 'exam', 'sport', 'formation', 'meal', 'free', 'other'];
const TASK_KINDS = ['submit', 'exam', 'prep', 'gear', 'other'];
const ICS_EVERY = 15 * 60000;

class Bad extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const bad = (msg, status) => { throw new Bad(msg, status); };

const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
const num = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
const list = (v, max, each) => (Array.isArray(v) ? v : []).map(x => str(x, each)).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, max);
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

function ts(v, what) {
  const n = num(v);
  if (n === null || n < 1e12 || n > 5e12) bad(`${what}: תאריך לא תקין`);
  return n;
}

const unitOut = (u, admin) => ({
  id: Number(u.id), name: u.name, teams: u.teams, dutyTypes: u.duty_types, posts: u.posts, openEdit: u.open_edit,
  ...(admin ? { code: u.code, icsUrl: u.ics_url || '', icsAt: Number(u.ics_at), icsErr: u.ics_err || '' } : { hasIcs: Boolean(u.ics_url) })
});
const memberOut = m => ({ id: Number(m.id), name: m.name, team: m.team, role: m.role, active: m.active, linked: m.user_id != null });

async function membership(userId) {
  const [m] = await sql`select * from pl_members where user_id = ${userId} and active`;
  if (!m) return null;
  const [u] = await sql`select * from pl_units where id = ${m.unit_id}`;
  return u ? { m, u } : null;
}

// only ids of people who are on this company's roster are kept
async function memberIds(unitId, v, max = 60) {
  const want = [...new Set((Array.isArray(v) ? v : []).map(num).filter(n => n !== null))].slice(0, max);
  if (!want.length) return [];
  const rows = await sql`select id from pl_members where unit_id = ${unitId}`;
  const ok = new Set(rows.map(r => Number(r.id)));
  return want.filter(id => ok.has(id));
}

// ---- calendar feed ----
function icsUrlOk(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'calendar.google.com' && u.pathname.startsWith('/calendar/ical/') && u.pathname.endsWith('.ics');
  } catch { return false; }
}
function guessKind(title) {
  const t = title;
  if (/בוחן|מבחן|בחינה|בר.?אור|מסכם/.test(t)) return 'exam';
  if (/מד.?ס|כושר|ריצה|אימון|קרב מגע/.test(t)) return 'sport';
  if (/ארוח|א\.?\s?בוקר|א\.?\s?צהריים|א\.?\s?ערב/.test(t)) return 'meal';
  if (/מסדר|טקס|ה\.?ד\.?ל|דגל/.test(t)) return 'formation';
  if (/שטח|ניווט|תרגיל|תרג.?ד|מטווח|מסע|אימון הקמה|תרח.?ט/.test(t)) return 'field';
  if (/שיעור|הרצאה|סדנ|לימוד|מת.?ש|שיחת|סיכום/.test(t)) return 'lesson';
  if (/ת.?ש|זמן אישי|מנוחה|שינה|כיבוי אורות|חופש|יציאה|שבת/.test(t)) return 'free';
  return 'other';
}
async function syncIcs(u, force) {
  if (!u.ics_url) return;
  const now = Date.now();
  if (!force && now - Number(u.ics_at) < ICS_EVERY) return;
  let err = '';
  try {
    if (!icsUrlOk(u.ics_url)) throw new Error('הכתובת אינה כתובת iCal של Google Calendar');
    const r = await fetch(u.ics_url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(7000) });
    if (!r.ok) throw new Error(`היומן החזיר שגיאה ${r.status}`);
    const text = await r.text();
    if (text.length > 4e6 || !text.includes('BEGIN:VCALENDAR')) throw new Error('הקובץ שהתקבל אינו יומן');
    const evs = parseIcs(text, now - 14 * DAY, now + 180 * DAY).slice(0, 3000)
      .map(e => ({ title: e.title, start_ts: e.start, end_ts: e.end, all_day: e.allDay, kind: guessKind(e.title), location: e.location, notes: e.notes }));
    await sql`delete from pl_events where unit_id = ${u.id} and source = 'ics'`;
    if (evs.length) {
      await sql`insert into pl_events (unit_id, title, start_ts, end_ts, all_day, kind, location, notes, source)
        select ${u.id}, x.title, x.start_ts, x.end_ts, x.all_day, x.kind, x.location, x.notes, 'ics'
        from jsonb_to_recordset(${JSON.stringify(evs)}::jsonb) as x(title text, start_ts bigint, end_ts bigint, all_day boolean, kind text, location text, notes text)`;
    }
  } catch (e) {
    err = String(e && e.message || e).slice(0, 200);
    if (e && e.name === 'TimeoutError') err = 'היומן לא ענה בזמן';
  }
  await sql`update pl_units set ics_at = ${now}, ics_err = ${err || null} where id = ${u.id}`;
  u.ics_at = now; u.ics_err = err || null;
}

// ---- everything the page shows, in one answer ----
async function fullState(userId, user) {
  const ms = await membership(userId);
  if (!ms) return { user, unit: null };
  const { m, u } = ms;
  await syncIcs(u, false);
  const now = Date.now();
  const [members, events, tasks, done, duties, shifts, notices, roles] = await Promise.all([
    sql`select * from pl_members where unit_id = ${u.id} order by team, name`,
    sql`select * from pl_events where unit_id = ${u.id} and end_ts >= ${now - 14 * DAY} and start_ts <= ${now + 180 * DAY} order by start_ts limit 4000`,
    sql`select * from pl_tasks where unit_id = ${u.id} and (scope <> 'personal' or owner = ${m.id}) and (due is null or due >= ${now - 45 * DAY}) order by due nulls last, id limit 1000`,
    sql`select d.task_id, d.member_id from pl_task_done d join pl_tasks t on t.id = d.task_id where t.unit_id = ${u.id}`,
    sql`select * from pl_duties where unit_id = ${u.id} order by day, id limit 5000`,
    sql`select * from pl_shifts where unit_id = ${u.id} and end_ts >= ${now - 90 * DAY} order by start_ts, post limit 8000`,
    sql`select * from pl_notices where unit_id = ${u.id} order by pinned desc, id desc limit 40`,
    sql`select * from pl_roles where unit_id = ${u.id} order by id limit 300`
  ]);
  const doneBy = new Map();
  done.forEach(d => { const k = Number(d.task_id); if (!doneBy.has(k)) doneBy.set(k, []); doneBy.get(k).push(Number(d.member_id)); });
  return {
    user, now,
    me: memberOut(m),
    unit: unitOut(u, m.role === 'admin'),
    members: members.map(memberOut),
    events: events.map(e => ({ id: Number(e.id), title: e.title, start: Number(e.start_ts), end: Number(e.end_ts), allDay: e.all_day, kind: e.kind, location: e.location, notes: e.notes, team: e.team, ics: e.source === 'ics' })),
    tasks: tasks.map(t => ({ id: Number(t.id), title: t.title, notes: t.notes, due: t.due == null ? null : Number(t.due), kind: t.kind, scope: t.scope, team: t.team, owner: t.owner == null ? null : Number(t.owner), done: doneBy.get(Number(t.id)) || [] })),
    duties: duties.map(d => ({ id: Number(d.id), day: d.day, type: d.type, notes: d.notes, members: d.member_ids })),
    shifts: shifts.map(s => ({ id: Number(s.id), post: s.post, start: Number(s.start_ts), end: Number(s.end_ts), members: s.member_ids })),
    roles: roles.map(r => ({ id: Number(r.id), title: r.title, grp: r.grp, team: r.team, holder: r.holder, phone: r.phone, notes: r.notes })),
    notices: notices.map(n => ({ id: Number(n.id), body: n.body, pinned: n.pinned, by: n.created_by == null ? null : Number(n.created_by), at: Number(n.created) }))
  };
}

// ---- operations ----
const OPS = {
  // what a join code opens: the company's name, its teams, and roster names nobody has claimed yet
  async peek({ b }) {
    const [u] = await sql`select * from pl_units where code = ${str(b.code, 12).toUpperCase()}`;
    if (!u) bad('הקוד לא נמצא. בדקו אותו מול מי ששלח אותו.', 404);
    const free = await sql`select id, name, team from pl_members where unit_id = ${u.id} and user_id is null and active order by team, name`;
    return { unit: { name: u.name, teams: u.teams }, free: free.map(r => ({ id: Number(r.id), name: r.name, team: r.team })) };
  },

  async create({ b, userId, ms }) {
    if (ms) bad('כבר יש לך פלוגה. כדי לפתוח חדשה צריך לעזוב קודם.');
    const name = str(b.name, 60), myName = str(b.myName, 60), teams = list(b.teams, 30, 30);
    if (!name || !myName) bad('חסר שם פלוגה או השם שלך');
    const team = str(b.team, 30);
    if (team && !teams.includes(team)) teams.push(team);
    let u;
    for (let i = 0; i < 5 && !u; i++) {
      [u] = await sql`insert into pl_units (name, code, teams, duty_types, posts, created)
        values (${name}, ${newCode()}, ${JSON.stringify(teams)}::jsonb, ${JSON.stringify(DEFAULT_DUTIES)}::jsonb, ${JSON.stringify(DEFAULT_POSTS)}::jsonb, ${Date.now()})
        on conflict (code) do nothing returning id`;
    }
    if (!u) bad('לא הצלחנו ליצור קוד. נסו שוב.', 500);
    await sql`insert into pl_members (unit_id, user_id, name, team, role, created) values (${u.id}, ${userId}, ${myName}, ${team}, 'admin', ${Date.now()})`;
  },

  async join({ b, userId, ms }) {
    if (ms) bad('כבר יש לך פלוגה');
    const [u] = await sql`select * from pl_units where code = ${str(b.code, 12).toUpperCase()}`;
    if (!u) bad('הקוד לא נמצא', 404);
    const claim = num(b.memberId);
    if (claim !== null) {
      // taking a name that is already on the roster; the condition keeps two people from taking the same one
      const got = await sql`update pl_members set user_id = ${userId} where id = ${claim} and unit_id = ${u.id} and user_id is null and active returning id`;
      if (!got.length) bad('השם הזה כבר נתפס. בחרו שם אחר או הוסיפו את עצמכם.');
      return;
    }
    const name = str(b.name, 60), team = str(b.team, 30);
    if (!name) bad('חסר שם');
    if (team && !u.teams.includes(team)) bad('הצוות לא קיים בפלוגה');
    await sql`insert into pl_members (unit_id, user_id, name, team, role, created) values (${u.id}, ${userId}, ${name}, ${team}, 'member', ${Date.now()})`;
  },

  async leave({ m, u }) {
    if (m.role === 'admin') {
      const [o] = await sql`select count(*)::int as n from pl_members where unit_id = ${u.id} and role = 'admin' and active and user_id is not null and id <> ${m.id}`;
      const [all] = await sql`select count(*)::int as n from pl_members where unit_id = ${u.id} and active and user_id is not null and id <> ${m.id}`;
      if (!o.n && all.n) bad('את/ה המנהל/ת היחיד/ה. לפני העזיבה צריך למנות מנהל נוסף.');
    }
    // the name stays on the roster (it appears in past shifts and duties); only the account is detached
    await sql`update pl_members set user_id = null, role = 'member' where id = ${m.id}`;
  },

  async profile({ b, m, u }) {
    const name = str(b.name, 60), team = str(b.team, 30);
    if (!name) bad('חסר שם');
    if (team && !u.teams.includes(team)) bad('הצוות לא קיים');
    await sql`update pl_members set name = ${name}, team = ${team} where id = ${m.id}`;
  },

  // ---- admin: roster and settings ----
  async 'member.add'({ b, u, admin }) {
    admin();
    const team = str(b.team, 30);
    if (team && !u.teams.includes(team)) bad('הצוות לא קיים');
    const names = list(b.names, 200, 60);
    if (!names.length) bad('לא התקבלו שמות');
    const [c] = await sql`select count(*)::int as n from pl_members where unit_id = ${u.id}`;
    if (c.n + names.length > 600) bad('יותר מדי שמות ברשימה');
    await sql`insert into pl_members (unit_id, name, team, role, created)
      select ${u.id}, x.name, ${team}, 'member', ${Date.now()} from jsonb_to_recordset(${JSON.stringify(names.map(name => ({ name })))}::jsonb) as x(name text)`;
  },
  async 'member.save'({ b, m, u, admin }) {
    admin();
    const id = num(b.id), name = str(b.name, 60), team = str(b.team, 30);
    const role = ['admin', 'editor', 'member'].includes(b.role) ? b.role : 'member';
    if (!name) bad('חסר שם');
    if (team && !u.teams.includes(team)) bad('הצוות לא קיים');
    if (id === Number(m.id) && role !== 'admin') {
      const [o] = await sql`select count(*)::int as n from pl_members where unit_id = ${u.id} and role = 'admin' and active and user_id is not null and id <> ${m.id}`;
      if (!o.n) bad('חייב להישאר מנהל אחד לפחות');
    }
    await sql`update pl_members set name = ${name}, team = ${team}, role = ${role} where id = ${id} and unit_id = ${u.id}`;
  },
  async 'member.remove'({ b, m, u, admin }) {
    admin();
    const id = num(b.id);
    if (id === Number(m.id)) bad('אי אפשר להסיר את עצמך. השתמשו ב"עזיבת הפלוגה".');
    await sql`update pl_members set active = false, user_id = null, role = 'member' where id = ${id} and unit_id = ${u.id}`;
  },
  async settings({ b, u, admin }) {
    admin();
    const name = str(b.name, 60) || u.name;
    const teams = list(b.teams, 30, 30), dutyTypes = list(b.dutyTypes, 30, 40), posts = list(b.posts, 30, 40);
    const icsUrl = str(b.icsUrl, 600);
    if (icsUrl && !icsUrlOk(icsUrl)) bad('זו לא כתובת iCal של Google Calendar. היא מתחילה ב־https://calendar.google.com/calendar/ical/ ומסתיימת ב־.ics');
    const changed = icsUrl !== (u.ics_url || '');
    await sql`update pl_units set name = ${name}, teams = ${JSON.stringify(teams)}::jsonb, duty_types = ${JSON.stringify(dutyTypes)}::jsonb,
      posts = ${JSON.stringify(posts)}::jsonb, open_edit = ${Boolean(b.openEdit)}, ics_url = ${icsUrl || null},
      ics_at = ${changed ? 0 : Number(u.ics_at)} where id = ${u.id}`;
    if (changed && !icsUrl) await sql`delete from pl_events where unit_id = ${u.id} and source = 'ics'`;
  },
  async 'code.reset'({ u, admin }) {
    admin();
    for (let i = 0; i < 5; i++) {
      // a code that is already taken breaks the unique index: try another one
      const got = await sql`update pl_units set code = ${newCode()} where id = ${u.id} returning id`.catch(() => []);
      if (got.length) return;
    }
    bad('לא הצלחנו להחליף קוד. נסו שוב.', 500);
  },
  async 'ics.sync'({ u, admin }) { admin(); await syncIcs(u, true); },

  // ---- schedule ----
  async 'event.save'({ b, m, u, edit }) {
    edit();
    const title = str(b.title, 200);
    if (!title) bad('חסרה כותרת');
    const start = ts(b.start, 'התחלה'), end = ts(b.end, 'סיום');
    if (end < start) bad('הסיום לפני ההתחלה');
    const kind = EVENT_KINDS.includes(b.kind) ? b.kind : 'other';
    const team = str(b.team, 30), location = str(b.location, 200), notes = str(b.notes, 2000), allDay = Boolean(b.allDay);
    const id = num(b.id);
    if (id !== null) {
      await sql`update pl_events set title = ${title}, start_ts = ${start}, end_ts = ${end}, all_day = ${allDay}, kind = ${kind}, location = ${location}, notes = ${notes}, team = ${team}
        where id = ${id} and unit_id = ${u.id} and source = 'manual'`;
      return;
    }
    // "repeat" adds the same event on the following days as well
    const repeat = Math.min(Math.max(num(b.repeatDays) || 1, 1), 31);
    const rows = Array.from({ length: repeat }, (_, i) => ({ s: start + i * DAY, e: end + i * DAY }));
    await sql`insert into pl_events (unit_id, title, start_ts, end_ts, all_day, kind, location, notes, team, created_by)
      select ${u.id}, ${title}, x.s, x.e, ${allDay}, ${kind}, ${location}, ${notes}, ${team}, ${m.id} from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(s bigint, e bigint)`;
  },
  async 'event.del'({ b, u, edit }) { edit(); await sql`delete from pl_events where id = ${num(b.id)} and unit_id = ${u.id} and source = 'manual'`; },

  // ---- tasks ----
  async 'task.save'({ b, m, u, canEdit }) {
    const title = str(b.title, 200);
    if (!title) bad('חסרה כותרת');
    const scope = ['unit', 'team', 'personal'].includes(b.scope) ? b.scope : 'unit';
    if (scope !== 'personal' && !canEdit) bad('רק עורכים יכולים להוסיף משימה לכולם. אפשר להוסיף משימה אישית.', 403);
    const team = scope === 'team' ? str(b.team, 30) : '';
    if (scope === 'team' && !u.teams.includes(team)) bad('חסר צוות');
    const due = b.due == null || b.due === '' ? null : ts(b.due, 'מועד');
    const kind = TASK_KINDS.includes(b.kind) ? b.kind : 'other';
    const notes = str(b.notes, 2000);
    const id = num(b.id);
    if (id !== null) {
      const [t] = await sql`select * from pl_tasks where id = ${id} and unit_id = ${u.id}`;
      if (!t) bad('המשימה לא נמצאה', 404);
      if (t.scope === 'personal' ? Number(t.owner) !== Number(m.id) : !canEdit) bad('אין הרשאה', 403);
      if ((t.scope === 'personal') !== (scope === 'personal')) bad('אי אפשר להפוך משימה אישית למשותפת או להפך');
      await sql`update pl_tasks set title = ${title}, notes = ${notes}, due = ${due}, kind = ${kind}, scope = ${scope}, team = ${team} where id = ${id}`;
      return;
    }
    await sql`insert into pl_tasks (unit_id, title, notes, due, kind, scope, team, owner, created_by, created)
      values (${u.id}, ${title}, ${notes}, ${due}, ${kind}, ${scope}, ${team}, ${scope === 'personal' ? m.id : null}, ${m.id}, ${Date.now()})`;
  },
  async 'task.del'({ b, m, u, canEdit }) {
    const [t] = await sql`select * from pl_tasks where id = ${num(b.id)} and unit_id = ${u.id}`;
    if (!t) return;
    if (t.scope === 'personal' ? Number(t.owner) !== Number(m.id) : !canEdit) bad('אין הרשאה', 403);
    await sql`delete from pl_task_done where task_id = ${t.id}`;
    await sql`delete from pl_tasks where id = ${t.id}`;
  },
  // ticking a task marks it for the caller; an editor can also tick it for someone else
  async 'task.done'({ b, m, u, canEdit }) {
    const [t] = await sql`select * from pl_tasks where id = ${num(b.id)} and unit_id = ${u.id}`;
    if (!t || (t.scope === 'personal' && Number(t.owner) !== Number(m.id))) bad('המשימה לא נמצאה', 404);
    let who = Number(m.id);
    const other = num(b.memberId);
    if (other !== null && other !== who) {
      if (!canEdit) bad('אין הרשאה', 403);
      [who] = await memberIds(u.id, [other]);
      if (!who) bad('החבר לא נמצא', 404);
    }
    if (b.done) await sql`insert into pl_task_done (task_id, member_id, at) values (${t.id}, ${who}, ${Date.now()}) on conflict do nothing`;
    else await sql`delete from pl_task_done where task_id = ${t.id} and member_id = ${who}`;
  },

  // ---- duties ----
  async 'duty.save'({ b, u, edit }) {
    edit();
    const type = str(b.type, 40), notes = str(b.notes, 500);
    if (!type) bad('חסר סוג תורנות');
    const members = await memberIds(u.id, b.members);
    const id = num(b.id);
    if (id !== null) {
      if (!isDay(b.day)) bad('תאריך לא תקין');
      await sql`update pl_duties set day = ${b.day}, type = ${type}, notes = ${notes}, member_ids = ${JSON.stringify(members)}::jsonb where id = ${id} and unit_id = ${u.id}`;
      return;
    }
    const days = (Array.isArray(b.days) ? b.days : [b.day]).filter(isDay).slice(0, 31);
    if (!days.length) bad('תאריך לא תקין');
    await sql`insert into pl_duties (unit_id, day, type, notes, member_ids)
      select ${u.id}, x.day, ${type}, ${notes}, ${JSON.stringify(members)}::jsonb from jsonb_to_recordset(${JSON.stringify(days.map(day => ({ day })))}::jsonb) as x(day text)`;
  },
  async 'duty.del'({ b, u, edit }) { edit(); await sql`delete from pl_duties where id = ${num(b.id)} and unit_id = ${u.id}`; },

  // ---- guard shifts ----
  async 'shift.save'({ b, u, edit }) {
    edit();
    const post = str(b.post, 40);
    if (!post) bad('חסרה עמדה');
    const start = ts(b.start, 'התחלה'), end = ts(b.end, 'סיום');
    if (end <= start) bad('הסיום חייב להיות אחרי ההתחלה');
    const members = JSON.stringify(await memberIds(u.id, b.members));
    const id = num(b.id);
    if (id !== null) await sql`update pl_shifts set post = ${post}, start_ts = ${start}, end_ts = ${end}, member_ids = ${members}::jsonb where id = ${id} and unit_id = ${u.id}`;
    else await sql`insert into pl_shifts (unit_id, post, start_ts, end_ts, member_ids) values (${u.id}, ${post}, ${start}, ${end}, ${members}::jsonb)`;
  },
  async 'shift.del'({ b, u, edit }) { edit(); await sql`delete from pl_shifts where id = ${num(b.id)} and unit_id = ${u.id}`; },
  // a whole generated list at once
  async 'shifts.bulk'({ b, u, edit }) {
    edit();
    const rows = await sql`select id from pl_members where unit_id = ${u.id}`;
    const ok = new Set(rows.map(r => Number(r.id)));
    const items = (Array.isArray(b.shifts) ? b.shifts : []).slice(0, 600).map(s => {
      const post = str(s.post, 40), start = ts(s.start, 'התחלה'), end = ts(s.end, 'סיום');
      if (!post || end <= start) bad('רשימה לא תקינה');
      return { post, s: start, e: end, m: [...new Set((Array.isArray(s.members) ? s.members : []).map(num))].filter(id => ok.has(id)).slice(0, 30) };
    });
    if (!items.length) bad('הרשימה ריקה');
    await sql`insert into pl_shifts (unit_id, post, start_ts, end_ts, member_ids)
      select ${u.id}, x.post, x.s, x.e, x.m from jsonb_to_recordset(${JSON.stringify(items)}::jsonb) as x(post text, s bigint, e bigint, m jsonb)`;
  },
  // remove every shift that starts inside a time range (used to redo a day)
  async 'shifts.clear'({ b, u, edit }) {
    edit();
    const from = ts(b.from, 'התחלה'), to = ts(b.to, 'סיום');
    if (to - from > 8 * DAY) bad('טווח גדול מדי');
    await sql`delete from pl_shifts where unit_id = ${u.id} and start_ts >= ${from} and start_ts < ${to}`;
  },

  // ---- roles: who fills which job, and how to reach them ----
  async 'role.save'({ b, u, edit }) {
    edit();
    const title = str(b.title, 60);
    if (!title) bad('חסר שם תפקיד');
    const grp = ['staff', 'cadets', 'other'].includes(b.grp) ? b.grp : 'staff';
    const team = str(b.team, 30);
    if (team && !u.teams.includes(team)) bad('הצוות לא קיים');
    const holder = str(b.holder, 60), notes = str(b.notes, 300);
    const phone = str(b.phone, 20);
    if (phone && !/^\+?[0-9][0-9 -]{5,18}$/.test(phone)) bad('מספר הטלפון לא תקין');
    const id = num(b.id);
    if (id !== null) {
      await sql`update pl_roles set title = ${title}, grp = ${grp}, team = ${team}, holder = ${holder}, phone = ${phone}, notes = ${notes} where id = ${id} and unit_id = ${u.id}`;
      return;
    }
    const [c] = await sql`select count(*)::int as n from pl_roles where unit_id = ${u.id}`;
    if (c.n >= 300) bad('יותר מדי תפקידים');
    await sql`insert into pl_roles (unit_id, title, grp, team, holder, phone, notes, created)
      values (${u.id}, ${title}, ${grp}, ${team}, ${holder}, ${phone}, ${notes}, ${Date.now()})`;
  },
  async 'role.del'({ b, u, edit }) { edit(); await sql`delete from pl_roles where id = ${num(b.id)} and unit_id = ${u.id}`; },

  // ---- notices ----
  async 'notice.save'({ b, m, u, edit }) {
    edit();
    const body = str(b.body, 1000);
    if (!body) bad('ההודעה ריקה');
    const id = num(b.id);
    if (id !== null) await sql`update pl_notices set body = ${body}, pinned = ${Boolean(b.pinned)} where id = ${id} and unit_id = ${u.id}`;
    else await sql`insert into pl_notices (unit_id, body, pinned, created_by, created) values (${u.id}, ${body}, ${Boolean(b.pinned)}, ${m.id}, ${Date.now()})`;
  },
  async 'notice.del'({ b, u, edit }) { edit(); await sql`delete from pl_notices where id = ${num(b.id)} and unit_id = ${u.id}`; }
};

const NO_UNIT_OPS = new Set(['peek', 'create', 'join']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method not allowed' }); }
  if (!hasDb()) return res.status(503).json({ error: 'מסד הנתונים לא מוגדר' });
  const s = sessionOf(req);
  if (!s) return res.status(401).json({ error: 'auth' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const [row] = await sql`select id, email, name, picture from users where id = ${s.uid}`;
    if (!row) return res.status(401).json({ error: 'auth' });
    const user = { name: row.name || '', email: row.email, picture: row.picture || null };
    const op = String(b.op || 'state');
    if (op !== 'state') {
      const fn = Object.hasOwn(OPS, op) ? OPS[op] : null;
      if (!fn) bad('פעולה לא מוכרת');
      const ms = await membership(s.uid);
      if (!ms && !NO_UNIT_OPS.has(op)) bad('עוד לא הצטרפת לפלוגה', 403);
      const role = ms ? ms.m.role : null;
      const canEdit = Boolean(ms) && (role === 'admin' || role === 'editor' || ms.u.open_edit);
      const out = await fn({
        b, userId: s.uid, ms, m: ms && ms.m, u: ms && ms.u, canEdit,
        admin: () => { if (role !== 'admin') bad('הפעולה שמורה למנהלי הפלוגה', 403); },
        edit: () => { if (!canEdit) bad('הפעולה שמורה לעורכים', 403); }
      });
      if (out) return res.status(200).json(out);
    }
    return res.status(200).json(await fullState(s.uid, user));
  } catch (e) {
    if (e instanceof Bad) return res.status(e.status).json({ error: e.message });
    console.error('pluga', e && e.message);
    return res.status(500).json({ error: 'משהו השתבש. נסו שוב.' });
  }
}
