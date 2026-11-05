// Leaderboard players and pairing codes, in Neon (Postgres).
// They used to live in Vercel Blob, until the Blob store hit its free-plan limit and was suspended.
// A player not yet in Postgres is imported from their old Blob file (public URL, no Blob API call) the first
// time they show up; if that file can't be read, their device re-uploads name and progress on its next sync.
import { createHash } from 'node:crypto';
import { sql } from './db.mjs';

export const sha = s => createHash('sha256').update(String(s)).digest('hex');
const OLD_BLOB = () => (process.env.OLD_BLOB_BASE || 'https://i7ay9lthtmeexcbe.public.blob.vercel-storage.com').replace(/\/$/, '');

const toRow = r => r && ({
  id: r.id, name: r.name || '', hashes: Array.isArray(r.hashes) ? r.hashes : [],
  xp: Number(r.xp) || 0, correct: Number(r.correct) || 0, rounds: Number(r.rounds) || 0, stage: Number(r.stage) || 1,
  progress: r.progress || null, updated: Number(r.updated) || 0
});

async function fromOldBlob(id) {
  if (globalThis.__OLD_PLAYERS__) return globalThis.__OLD_PLAYERS__[id] || null; // tests
  try {
    const r = await fetch(`${OLD_BLOB()}/players/${id}.json?v=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const p = await r.json();
    return p && p.id === id ? p : null;
  } catch { return null; }
}

export async function putPlayer(p) {
  await sql`
    insert into players (id, name, hashes, xp, correct, rounds, stage, progress, updated)
    values (${p.id}, ${p.name || ''}, ${JSON.stringify(p.hashes || [])}::jsonb, ${p.xp || 0}, ${p.correct || 0}, ${p.rounds || 0},
            ${p.stage || 1}, ${p.progress ? JSON.stringify(p.progress) : null}::jsonb, ${p.updated || Date.now()})
    on conflict (id) do update set name = excluded.name, hashes = excluded.hashes, xp = excluded.xp, correct = excluded.correct,
      rounds = excluded.rounds, stage = excluded.stage, progress = excluded.progress, updated = excluded.updated`;
}

// The player, from Postgres or (first time) imported from the old Blob file. null if unknown.
export async function getPlayer(id) {
  const [r] = await sql`select id, name, hashes, xp, correct, rounds, stage, progress, updated from players where id = ${id}`;
  if (r) return toRow(r);
  const old = await fromOldBlob(id);
  if (!old) return null;
  const row = toRow({ ...old, hashes: old.hashes || (old.hash ? [old.hash] : []) });
  await putPlayer(row);
  console.log('imported player from old blob', id);
  return row;
}

export async function board() {
  const rows = await sql`select id, name, xp, correct, rounds, stage, updated from players where name <> ''
    order by xp desc, correct desc, updated asc limit 500`;
  return rows.map(r => ({ id: r.id, name: r.name, xp: Number(r.xp) || 0, correct: Number(r.correct) || 0, rounds: Number(r.rounds) || 0, stage: Number(r.stage) || 1, updated: Number(r.updated) || 0 }));
}

export async function putCode(code, id, exp) {
  await sql`insert into pair_codes (code, id, exp) values (${code}, ${id}, ${exp}) on conflict (code) do update set id = excluded.id, exp = excluded.exp`;
  await sql`delete from pair_codes where exp < ${Date.now()}`;
}
export async function takeCode(code) {
  const [c] = await sql`delete from pair_codes where code = ${code} returning id, exp`;
  return c ? { id: c.id, exp: Number(c.exp) } : null;
}

// ---- private group leaderboards ----
export const GROUP_LIMITS = { perPlayer: 20, members: 300 };

export async function groupInfo(code) {
  const [g] = await sql`select g.code, g.name, g.owner, (select count(*)::int from group_members m where m.code = g.code) as count
    from groups g where g.code = ${code}`;
  return g ? { code: g.code, name: g.name, owner: g.owner, count: Number(g.count) || 0 } : null;
}
export async function groupBoard(code) {
  const rows = await sql`select p.id, p.name, p.xp, p.correct, p.rounds, p.stage, p.updated
    from group_members m join players p on p.id = m.player_id
    where m.code = ${code} and p.name <> '' order by p.xp desc, p.correct desc, p.updated asc limit ${GROUP_LIMITS.members}`;
  return rows.map(r => ({ id: r.id, name: r.name, xp: Number(r.xp) || 0, correct: Number(r.correct) || 0, rounds: Number(r.rounds) || 0, stage: Number(r.stage) || 1, updated: Number(r.updated) || 0 }));
}
export async function myGroups(playerId) {
  const rows = await sql`select g.code, g.name, g.owner, (select count(*)::int from group_members x where x.code = g.code) as count
    from group_members m join groups g on g.code = m.code where m.player_id = ${playerId} order by m.joined`;
  return rows.map(g => ({ code: g.code, name: g.name, owner: g.owner === playerId, count: Number(g.count) || 0 }));
}
export async function createGroup(code, name, owner) {
  const ins = await sql`insert into groups (code, name, owner, created) values (${code}, ${name}, ${owner}, ${Date.now()}) on conflict do nothing returning code`;
  if (!ins.length) return false;
  await sql`insert into group_members (code, player_id, joined) values (${code}, ${owner}, ${Date.now()}) on conflict do nothing`;
  return true;
}
export async function joinGroup(code, playerId) {
  await sql`insert into group_members (code, player_id, joined) values (${code}, ${playerId}, ${Date.now()}) on conflict do nothing`;
}
export async function leaveGroup(code, playerId) {
  await sql`delete from group_members where code = ${code} and player_id = ${playerId}`;
  const [{ n }] = await sql`select count(*)::int as n from group_members where code = ${code}`;
  if (!Number(n)) await sql`delete from groups where code = ${code}`;
}
export async function countMyGroups(playerId) {
  const [{ n }] = await sql`select count(*)::int as n from group_members where player_id = ${playerId}`;
  return Number(n) || 0;
}

// ---- group chat ----
// Ready-made reactions: the client sends only the index, so their text can't be altered.
export const QUICK = ['אני אעקוף אותך 😤', 'וואו, איך הגעת לשם?! 🤯', 'כל הכבוד! 👏', '🔥🔥🔥', 'מי בא לסבב? 💪', 'חכה חכה... 😏', 'זה לא נגמר! 😅', 'גאה בך 🫡'];
const KEEP = 300; // messages kept per group

export async function isMember(code, playerId) {
  const [r] = await sql`select 1 as ok from group_members where code = ${code} and player_id = ${playerId}`;
  return !!r;
}
export async function addMessage(code, playerId, kind, body) {
  const [m] = await sql`insert into group_messages (code, player_id, kind, body, created)
    values (${code}, ${playerId}, ${kind}, ${body}, ${Date.now()}) returning id`;
  await sql`delete from group_messages where code = ${code} and id <= (
    select id from group_messages where code = ${code} order by id desc offset ${KEEP} limit 1)`;
  return Number(m.id);
}
export async function recentSends(code, playerId, sinceMs) {
  const [{ n }] = await sql`select count(*)::int as n from group_messages where code = ${code} and player_id = ${playerId} and created > ${Date.now() - sinceMs} and kind <> 'system'`;
  return Number(n) || 0;
}
export async function listMessages(code, after) {
  const rows = after
    ? await sql`select m.id, m.player_id, m.kind, m.body, m.created, p.name from group_messages m left join players p on p.id = m.player_id
        where m.code = ${code} and m.id > ${after} order by m.id limit 100`
    : await sql`select * from (select m.id, m.player_id, m.kind, m.body, m.created, p.name from group_messages m left join players p on p.id = m.player_id
        where m.code = ${code} order by m.id desc limit 60) t order by id`;
  return rows.map(r => ({ id: Number(r.id), by: r.player_id, name: r.name || '', kind: r.kind, text: r.body, at: Number(r.created) }));
}
export async function deleteMessage(code, id) {
  await sql`delete from group_messages where code = ${code} and id = ${id}`;
}
export async function messageAuthor(code, id) {
  const [r] = await sql`select player_id from group_messages where code = ${code} and id = ${id}`;
  return r ? (r.player_id || '') : null;
}
export async function lastMessageIds(codes) {
  if (!codes.length) return {};
  const rows = await sql`select code, max(id) as last from group_messages where code = any(${codes}) group by code`;
  return Object.fromEntries(rows.map(r => [r.code, Number(r.last)]));
}

// After a player's XP goes up: in each of their groups, announce whom they passed and any new stage.
export async function announceProgress(player, prevXp, prevStage) {
  if (!player.name || player.xp <= prevXp) return;
  const groups = await sql`select code from group_members where player_id = ${player.id}`;
  for (const { code } of groups) {
    const passed = await sql`select p.name from group_members m join players p on p.id = m.player_id
      where m.code = ${code} and p.id <> ${player.id} and p.name <> '' and p.xp >= ${prevXp} and p.xp < ${player.xp}
      order by p.xp desc limit 4`;
    if (passed.length) {
      const names = passed.slice(0, 3).map(r => r.name);
      const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' ו' + names[names.length - 1] : names[0];
      await addMessage(code, null, 'system', `🏆 ${player.name} עקף/ה את ${list}${passed.length > 3 ? ' ועוד' : ''}!`);
    }
    if (player.stage > (prevStage || 1)) await addMessage(code, null, 'system', `⭐ ${player.name} הגיע/ה לשלב ${player.stage}`);
  }
}

// ---- sharing ----
// A new player who arrived through someone's link: remember who brought them (once, never self, only real players).
export async function setReferrer(id, ref) {
  if (!ref || ref === id || !/^[a-z0-9]{10,32}$/.test(ref)) return;
  await sql`update players set referred_by = ${ref} where id = ${id} and referred_by is null
    and exists (select 1 from players r where r.id = ${ref})`;
}
export async function markShared(id) {
  await sql`update players set shares = shares + 1, shared_at = ${Date.now()} where id = ${id}`;
}
export async function referralStats() {
  return sql`select p.id, p.name, p.shares, p.shared_at, count(r.id)::int as brought,
      count(r.id) filter (where r.name <> '')::int as brought_named
    from players p left join players r on r.referred_by = p.id
    group by p.id having p.shares > 0 or count(r.id) > 0
    order by count(r.id) desc, p.shares desc limit 100`;
}
