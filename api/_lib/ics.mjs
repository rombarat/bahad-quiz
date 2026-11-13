// Reads an iCalendar (.ics) feed, such as the "secret address in iCal format" of a Google Calendar,
// and returns plain events inside a time window. Repeating events (daily / weekly / monthly / yearly rules,
// with INTERVAL, COUNT, UNTIL, BYDAY and EXDATE) are expanded into single occurrences.
const DAY = 86400000;
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// offset (ms) of a time zone at a given instant
function tzOffset(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
// wall-clock time in a zone → instant
export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let off;
  try { off = tzOffset(guess, tz); } catch { tz = 'Asia/Jerusalem'; off = tzOffset(guess, tz); }
  const off2 = tzOffset(guess - off, tz);
  return guess - off2;
}

function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}
const unesc = v => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseLine(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const [name, ...params] = line.slice(0, i).split(';');
  const par = {};
  params.forEach(p => { const k = p.indexOf('='); if (k > 0) par[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ''); });
  return { name: name.toUpperCase(), par, value: line.slice(i + 1) };
}

// → { ms, allDay, local: {y,mo,d,h,mi,s}, tz }
function parseDate(value, par, defTz) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map(i => Number(m[i] || 0));
  const tz = par.TZID || defTz;
  if (!m[4]) return { ms: zonedToUtc(y, mo, d, 0, 0, 0, defTz), allDay: true, local: { y, mo, d, h: 0, mi: 0, s: 0 }, tz: defTz };
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false, local: null, tz: 'UTC' };
  return { ms: zonedToUtc(y, mo, d, h, mi, s, tz), allDay: false, local: { y, mo, d, h, mi, s }, tz };
}

function parseRule(v) {
  const r = {};
  v.split(';').forEach(p => { const [k, x] = p.split('='); if (k && x) r[k.toUpperCase()] = x; });
  return r;
}

// Start instants of a repeating event inside [from, to]. Works on wall-clock dates so the hour stays put across DST.
function expand(start, rule, from, to, defTz) {
  const out = [];
  const freq = rule.FREQ;
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  let until = Infinity;
  if (rule.UNTIL) { const u = parseDate(rule.UNTIL, {}, defTz); if (u) until = u.ms + (u.allDay ? DAY - 1 : 0); }
  const tz = start.tz === 'UTC' ? 'UTC' : start.tz;
  const L = start.local || (() => { const d = new Date(start.ms); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }; })();
  const at = (dayUtc) => { const d = new Date(dayUtc); return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), L.h, L.mi, L.s, tz); };
  const day0 = Date.UTC(L.y, L.mo - 1, L.d);
  const byday = rule.BYDAY ? rule.BYDAY.split(',').map(x => WD[x.replace(/^[+-]?\d+/, '')]).filter(x => x !== undefined) : null;
  let n = 0;
  const push = (dayUtc) => {
    const ms = at(dayUtc);
    if (ms < start.ms) return true;
    if (ms > until || n >= count) return false;
    n++;
    if (ms >= from && ms <= to) out.push(ms);
    return ms <= to;
  };
  const LIMIT = 4000;
  if (freq === 'DAILY') {
    for (let i = 0, d = day0; i < LIMIT; i++, d += interval * DAY) {
      if (byday && !byday.includes(new Date(d).getUTCDay())) continue;
      if (!push(d)) break;
    }
  } else if (freq === 'WEEKLY') {
    const days = (byday && byday.length ? byday : [new Date(day0).getUTCDay()]).slice().sort((a, b) => a - b);
    const week0 = day0 - new Date(day0).getUTCDay() * DAY;
    outer: for (let w = 0; w < LIMIT; w++) {
      for (const wd of days) if (!push(week0 + w * interval * 7 * DAY + wd * DAY)) break outer;
    }
  } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const step = freq === 'YEARLY' ? 12 * interval : interval;
    for (let i = 0; i < 600; i++) {
      const d = new Date(Date.UTC(L.y, L.mo - 1 + i * step, L.d));
      if (d.getUTCDate() !== L.d) continue; // the 31st does not exist in every month
      if (!push(d.getTime())) break;
    }
  }
  return out;
}

// → [{ title, start, end, allDay, location, notes }] sorted by start
export function parseIcs(text, from, to, defTz = 'Asia/Jerusalem') {
  const lines = unfold(text);
  const raw = [];
  let cur = null, depth = 0;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { ex: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (line.startsWith('BEGIN:')) { depth++; continue; }
    if (line === 'END:VEVENT') { raw.push(cur); cur = null; continue; }
    if (line.startsWith('END:')) { depth--; continue; }
    if (depth > 0) continue; // alarms and other nested blocks
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'SUMMARY') cur.title = unesc(p.value);
    else if (p.name === 'LOCATION') cur.location = unesc(p.value);
    else if (p.name === 'DESCRIPTION') cur.notes = unesc(p.value);
    else if (p.name === 'UID') cur.uid = p.value;
    else if (p.name === 'STATUS') cur.status = p.value.toUpperCase();
    else if (p.name === 'DTSTART') cur.start = parseDate(p.value, p.par, defTz);
    else if (p.name === 'DTEND') cur.end = parseDate(p.value, p.par, defTz);
    else if (p.name === 'RRULE') cur.rule = parseRule(p.value);
    else if (p.name === 'RECURRENCE-ID') cur.recId = parseDate(p.value, p.par, defTz);
    else if (p.name === 'EXDATE') p.value.split(',').forEach(v => { const d = parseDate(v, p.par, defTz); if (d) cur.ex.push(d.ms); });
  }
  // a changed single occurrence replaces the one the rule would produce
  const overridden = new Set(raw.filter(e => e.recId && e.uid).map(e => `${e.uid}|${e.recId.ms}`));
  const out = [];
  for (const e of raw) {
    if (!e.start || e.status === 'CANCELLED') continue;
    const dur = e.end ? Math.max(0, e.end.ms - e.start.ms) : (e.start.allDay ? DAY : 3600000);
    const starts = e.rule && !e.recId ? expand(e.start, e.rule, from - dur, to, defTz) : [e.start.ms];
    for (const s of starts) {
      if (s + dur < from || s > to) continue;
      if (e.ex.includes(s)) continue;
      if (e.rule && !e.recId && overridden.has(`${e.uid}|${s}`)) continue;
      out.push({
        title: (e.title || '').trim().slice(0, 200) || '(ללא כותרת)',
        start: s, end: s + dur, allDay: e.start.allDay,
        location: (e.location || '').trim().slice(0, 200),
        notes: (e.notes || '').trim().slice(0, 2000)
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
