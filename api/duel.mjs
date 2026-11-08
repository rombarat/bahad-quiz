// Head-to-head duels ("דו־קרב"): two players answer the same questions at the same time.
// - One player opens a duel and gets a code; the other joins with it. Questions are picked when they join.
// - Each question is open for 30 seconds. Once one player locks an answer, the other has 5 seconds left.
// - A duel is one round or best of three; a round has 5–20 questions.
// The server keeps the clock: every phase (intro, question, reveal, break between rounds) is derived from
// the start time and the stored answers, so both players see the same thing whenever they poll.
// Players are identified by their device account (X-Acct: "id.secret"); the duel keeps a hash of the secret.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from './_lib/db.mjs';
import { accessFor } from './_lib/access.mjs';

export const T = { Q: 30000, LOCK: 5000, REVEAL: 4000, BREAK: 7000, INTRO: 5500 };
const JOIN_TTL = 30 * 60 * 1000;   // an unanswered invitation expires
const KEEP = 24 * 3600 * 1000;     // finished duels are deleted after a day
const LENS = [5, 10, 15, 20], ROUNDS = [1, 3];
const PREP_MAX = 448;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const sha = s => createHash('sha256').update(String(s)).digest('hex');
const code5 = () => [...randomBytes(5)].map(b => CODE_ABC[b % CODE_ABC.length]).join('');
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randomBytes(4).readUInt32LE() % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// every question: the free ones (in index.html) and the rest (premium.json)
let FREE = null, PREMIUM = null;
function freeRows() {
  if (!FREE) {
    try {
      const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
      const m = html.match(/const FREE_Q=\[([\s\S]*?)\n\];/);
      FREE = m ? new Function(`return [${m[1]}]`)() : [];
    } catch { FREE = []; }
  }
  return FREE;
}
const premiumRows = () => PREMIUM || (PREMIUM = JSON.parse(readFileSync(new URL('./_data/premium.json', import.meta.url), 'utf8')));

// The duel's questions: the whole bank when both players have full access, otherwise only the free ones.
function pickQuestions(cfg, full) {
  const inBank = r => cfg.mode === 'prep' ? r[0] < PREP_MAX : r[0] >= PREP_MAX;
  const pool = [...freeRows(), ...(full ? premiumRows() : [])].filter(inBank);
  const need = cfg.len * cfg.rounds, out = [];
  while (pool.length && out.length < need) out.push(...shuffle(pool));
  return out.slice(0, need).map(([id, c, q, a, w, e, img]) => {
    const o = shuffle([a, ...String(w).split('|')]);
    return { id, c, q, o, a: o.indexOf(a), e: e || '', img: img || '' };
  });
}

// Where the duel is now. ans[qi] = { host: {choice, at}, guest: {choice, at} }
export function timeline(d, ans, now) {
  const L = d.cfg.len, R = d.cfg.rounds, res = [], rounds = [], wins = { host: 0, guest: 0 };
  if (!d.guest || !d.start) return { phase: 'wait', res, rounds, wins };
  let t = d.start;
  if (now < t) return { phase: 'intro', until: t, res, rounds, wins };
  for (let r = 0; r < R; r++) {
    const pts = { host: 0, guest: 0 };
    for (let k = 0; k < L; k++) {
      const i = r * L + k, qStart = t, a = ans[i] || {};
      const ats = ['host', 'guest'].filter(s => a[s]).map(s => a[s].at);
      const deadline = Math.min(qStart + T.Q, ats.length ? Math.min(...ats) + T.LOCK : Infinity);
      const end = a.host && a.guest ? Math.max(a.host.at, a.guest.at) : deadline;
      if (now < end) return { phase: 'q', i, r, k, qStart, deadline, pts, res, rounds, wins };
      const q = d.qs[i], got = {}, choice = {};
      for (const s of ['host', 'guest']) {
        const c = a[s];
        choice[s] = c ? c.choice : -1;
        got[s] = c && c.choice === q.a ? 100 + Math.round(50 * Math.max(0, 1 - (c.at - qStart) / T.Q)) : 0;
        pts[s] += got[s];
      }
      res.push({ i, got, choice });
      t = end + T.REVEAL;
      if (now < t) return { phase: 'reveal', i, r, k, until: t, pts, res, rounds, wins };
    }
    const win = pts.host > pts.guest ? 'host' : pts.guest > pts.host ? 'guest' : null;
    if (win) wins[win]++;
    rounds.push({ ...pts, win });
    if (r === R - 1 || wins.host * 2 > R || wins.guest * 2 > R) return { phase: 'done', res, rounds, wins };
    t += T.BREAK;
    if (now < t) return { phase: 'break', r, until: t, res, rounds, wins };
  }
  return { phase: 'done', res, rounds, wins };
}

// overall winner: more rounds won, then more points in total
function winner(tl) {
  if (tl.wins.host !== tl.wins.guest) return tl.wins.host > tl.wins.guest ? 'host' : 'guest';
  const sum = s => tl.rounds.reduce((n, r) => n + r[s], 0);
  return sum('host') > sum('guest') ? 'host' : sum('guest') > sum('host') ? 'guest' : null;
}

async function load(code) {
  const [d] = await sql`select * from duels where code = ${code}`;
  if (!d) return null;
  d.created = Number(d.created); d.start = d.start ? Number(d.start) : null;
  return d;
}
async function answers(code, d) {
  const rows = await sql`select qi, player, choice, at from duel_answers where code = ${code}`;
  const ans = [];
  for (const r of rows) {
    const s = r.player === d.host ? 'host' : r.player === d.guest ? 'guest' : null;
    if (!s) continue;
    (ans[r.qi] = ans[r.qi] || {})[s] = { choice: Number(r.choice), at: Number(r.at) };
  }
  return ans;
}
function who(req) {
  const m = String(req.headers['x-acct'] || '').match(/^([a-z0-9]{10,32})\.([a-z0-9]{16,64})$/);
  return m ? { id: m[1], hash: sha(m[2]) } : null;
}
const sideOf = (d, me) => !me ? null : me.id === d.host && me.hash === d.host_hash ? 'host'
  : d.guest && me.id === d.guest && me.hash === d.guest_hash ? 'guest' : null;

// What one player sees. The correct answer and the opponent's choice only after the question closes.
function view(d, ans, side, now) {
  const opp = side === 'host' ? 'guest' : 'host', tl = timeline(d, ans, now);
  const flip = o => o && { me: o[side], opp: o[opp] };
  const out = {
    code: d.code, side, now, cfg: d.cfg, T,
    names: { me: d[side + '_name'], opp: d[opp + '_name'] || '' },
    phase: tl.phase, total: d.cfg.len * d.cfg.rounds,
    wins: flip(tl.wins), rounds: tl.rounds.map(r => ({ me: r[side], opp: r[opp], win: r.win === side ? 'me' : r.win ? 'opp' : null })),
    history: tl.res.map(x => ({ i: x.i, me: x.got[side], opp: x.got[opp] })),
    next: d.next_code || null
  };
  for (const k of ['i', 'r', 'k', 'qStart', 'deadline', 'until']) if (tl[k] !== undefined) out[k] = tl[k];
  if (tl.pts) out.pts = flip(tl.pts);
  if (tl.phase === 'q' || tl.phase === 'reveal') {
    const q = d.qs[tl.i], a = ans[tl.i] || {};
    out.q = { c: q.c, q: q.q, o: q.o, img: q.img };
    out.mine = a[side] ? a[side].choice : -1;
    out.oppLocked = !!a[opp];
    if (tl.phase === 'reveal') {
      const r = tl.res[tl.res.length - 1];
      Object.assign(out.q, { a: q.a, e: q.e });
      out.choice = flip(r.choice); out.got = flip(r.got);
    }
  }
  if (tl.phase === 'done') { const w = winner(tl); out.result = w === side ? 'win' : w ? 'lose' : 'draw'; }
  if (d.left_by && tl.phase !== 'done') { out.phase = 'left'; out.result = d.left_by === side ? 'lose' : 'win'; }
  return out;
}

async function create(me, req, b, cfg) {
  const name = cleanName(b.name);
  if (!name) return [400, { error: 'name required' }];
  const a = await accessFor(req).catch(() => ({ access: { full: false } }));
  const now = Date.now();
  await sql`delete from duel_answers where code in (select code from duels where created < ${now - KEEP})`;
  await sql`delete from duels where created < ${now - KEEP}`;
  for (let n = 0; n < 5; n++) {
    const code = code5();
    const ins = await sql`insert into duels (code, host, host_hash, host_name, host_full, cfg, created)
      values (${code}, ${me.id}, ${me.hash}, ${name}, ${!!a.access.full}, ${JSON.stringify(cfg)}::jsonb, ${now})
      on conflict do nothing returning code`;
    if (ins.length) return [200, { code }];
  }
  return [500, { error: 'no code' }];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const me = who(req);
    if (!me) return res.status(401).json({ error: 'no account' });
    const now = () => Date.now();

    if (req.method === 'GET') {
      const code = String((req.query && req.query.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const d = code.length === 5 ? await load(code) : null;
      if (!d) return res.status(404).json({ error: 'not found' });
      const side = sideOf(d, me);
      // not in this duel: just enough to show the invitation
      if (!side) return res.status(200).json({ code, invite: { host: d.host_name, cfg: d.cfg, open: !d.guest && now() - d.created < JOIN_TTL, mine: d.host === me.id } });
      return res.status(200).json(view(d, await answers(code, d), side, now()));
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.action === 'create') {
      const cfg = { len: LENS.includes(+b.len) ? +b.len : 10, rounds: ROUNDS.includes(+b.rounds) ? +b.rounds : 1, mode: b.mode === 'prep' ? 'prep' : 'bahad' };
      const [st, j] = await create(me, req, b, cfg);
      return res.status(st).json(j);
    }

    const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const d = code.length === 5 ? await load(code) : null;
    if (!d) return res.status(404).json({ error: 'not found' });

    if (b.action === 'join') {
      const name = cleanName(b.name);
      if (!name) return res.status(400).json({ error: 'name required' });
      const side = sideOf(d, me);
      if (side) return res.status(200).json(view(d, await answers(code, d), side, now()));
      if (d.host === me.id) return res.status(409).json({ error: 'own duel' });
      if (d.guest) return res.status(409).json({ error: 'taken' });
      if (now() - d.created > JOIN_TTL) return res.status(410).json({ error: 'expired' });
      const a = await accessFor(req).catch(() => ({ access: { full: false } }));
      const qs = pickQuestions(d.cfg, d.host_full && a.access.full);
      if (!qs.length) return res.status(500).json({ error: 'no questions' });
      const start = now() + T.INTRO;
      const up = await sql`update duels set guest = ${me.id}, guest_hash = ${me.hash}, guest_name = ${name}, qs = ${JSON.stringify(qs)}::jsonb, start = ${start}
        where code = ${code} and guest is null returning code`;
      if (!up.length) return res.status(409).json({ error: 'taken' });
      const d2 = await load(code);
      return res.status(200).json(view(d2, [], 'guest', now()));
    }

    const side = sideOf(d, me);
    if (!side) return res.status(403).json({ error: 'not in this duel' });

    if (b.action === 'answer') {
      const ans = await answers(code, d), t = now(), tl = timeline(d, ans, t), i = Number(b.i), choice = Number(b.choice);
      if (d.left_by) return res.status(409).json({ error: 'ended' });
      if (tl.phase !== 'q' || tl.i !== i || !(Number.isInteger(choice) && choice >= 0 && choice < d.qs[i].o.length)) return res.status(409).json({ error: 'closed', state: view(d, ans, side, t) });
      await sql`insert into duel_answers (code, qi, player, choice, at) values (${code}, ${i}, ${me.id}, ${choice}, ${t}) on conflict do nothing`;
      return res.status(200).json(view(d, await answers(code, d), side, now()));
    }
    if (b.action === 'leave') {
      const ans = await answers(code, d);
      if (!d.left_by && timeline(d, ans, now()).phase !== 'done') {
        if (!d.guest) await sql`delete from duels where code = ${code} and guest is null`;
        else await sql`update duels set left_by = ${side} where code = ${code} and left_by is null`;
      }
      return res.status(200).json({ ok: true });
    }
    if (b.action === 'rematch') {
      if (d.next_code) return res.status(200).json({ code: d.next_code });
      const ans = await answers(code, d), ph = d.left_by ? 'left' : timeline(d, ans, now()).phase;
      if (ph !== 'done' && ph !== 'left') return res.status(409).json({ error: 'not finished' });
      const [st, j] = await create(me, req, { name: d[side + '_name'] }, d.cfg);
      if (st !== 200) return res.status(st).json(j);
      const up = await sql`update duels set next_code = ${j.code} where code = ${code} and next_code is null returning next_code`;
      if (!up.length) { await sql`delete from duels where code = ${j.code}`; return res.status(200).json({ code: (await load(code)).next_code }); }
      return res.status(200).json({ code: j.code });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('duel', e && e.message);
    return res.status(500).json({ error: 'server error' });
  }
}
