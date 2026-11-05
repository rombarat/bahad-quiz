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
