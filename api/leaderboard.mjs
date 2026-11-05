// Leaderboard + cross-device sync for the Bahad 1 quiz.
// Storage: Neon Postgres (api/_lib/players.mjs). It was Vercel Blob until that store hit its free-plan limit.
//   players     one row per player (stats, progress, hashes of device secrets)
//   pair_codes  short-lived pairing codes for linking another device
// Secrets never get stored in plain text: each device holds its own secret,
// the server keeps only SHA-256 hashes.
import { randomBytes } from 'node:crypto';
import { sha, getPlayer, putPlayer, board, putCode, takeCode } from './_lib/players.mjs';

const MAX = { correct: 5000, rounds: 5000, stage: 1000, xp: 10_000_000 };
const CODE_TTL = 15 * 60 * 1000;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const int = (v, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const token = (n, abc = 'abcdefghijklmnopqrstuvwxyz0123456789') => [...randomBytes(n)].map(b => abc[b % abc.length]).join('');
const hashesOf = p => p ? (p.hashes || (p.hash ? [p.hash] : [])) : [];

// progress = { done: [question indexes], path: {done:[...]}, xp }
function cleanProgress(p) {
  if (!p || typeof p !== 'object') return null;
  const done = Array.isArray(p.done) ? [...new Set(p.done.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < 5000))] : [];
  const rounds = p.path && Array.isArray(p.path.done) ? p.path.done.slice(0, 5000).map(r => ({
    t: r && r.t === 'review' ? 'review' : 'learn',
    qs: Array.isArray(r && r.qs) ? r.qs.map(Number).filter(Number.isInteger).slice(0, 100) : [],
    wrong: Array.isArray(r && r.wrong) ? r.wrong.map(Number).filter(Number.isInteger).slice(0, 100) : [],
    acc: int(r && r.acc, 100)
  })) : [];
  return { done, path: { done: rounds }, xp: int(p.xp, MAX.xp) };
}

async function authed(id, secret) {
  if (!/^[a-z0-9]{10,32}$/.test(id) || secret.length < 16 || secret.length > 64) return { error: 400 };
  const prev = await getPlayer(id);
  if (prev && !hashesOf(prev).includes(sha(secret))) return { error: 403 };
  return { prev };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      // every open home screen polls this; let the CDN answer most of those
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10, stale-while-revalidate=30');
      return res.status(200).json({ players: await board() });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = b.action || 'save';
    const id = String(b.id || ''), secret = String(b.secret || '');

    // Redeem a pairing code on a new device: returns a fresh secret for that device + saved progress.
    if (action === 'redeem') {
      const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 6) return res.status(400).json({ error: 'bad code' });
      const c = await takeCode(code);
      if (!c || c.exp < Date.now()) return res.status(404).json({ error: 'code not found' });
      const p = await getPlayer(c.id);
      if (!p) return res.status(404).json({ error: 'player not found' });
      const newSecret = token(32);
      p.hashes = [...hashesOf(p), sha(newSecret)].slice(-10);
      await putPlayer(p);
      return res.status(200).json({ id: p.id, secret: newSecret, name: p.name, progress: p.progress || null });
    }

    const auth = await authed(id, secret);
    if (auth.error === 400) return res.status(400).json({ error: 'bad id' });
    if (auth.error === 403) return res.status(403).json({ error: 'not your player' });
    const prev = auth.prev;

    if (action === 'pull') {
      return res.status(200).json({ name: prev && prev.name ? prev.name : null, progress: prev ? prev.progress || null : null });
    }

    // Silent backup of progress for players who haven't joined the board. Keeps any existing name.
    if (action === 'backup') {
      const row = {
        id, name: prev && prev.name ? prev.name : '',
        hashes: prev ? hashesOf(prev) : [sha(secret)],
        xp: int(b.xp, MAX.xp), correct: int(b.correct, MAX.correct), rounds: int(b.rounds, MAX.rounds),
        stage: Math.max(1, int(b.stage, MAX.stage)), updated: Date.now(),
        progress: cleanProgress(b.progress) || (prev && prev.progress) || null
      };
      await putPlayer(row);
      return res.status(200).json({ ok: true });
    }

    if (action === 'mkcode') {
      if (!prev) return res.status(404).json({ error: 'join first' });
      const code = token(6, CODE_ABC);
      await putCode(code, id, Date.now() + CODE_TTL);
      return res.status(200).json({ code, expiresInMin: CODE_TTL / 60000 });
    }

    // save
    const name = cleanName(b.name);
    if (!name) return res.status(400).json({ error: 'name required' });
    const row = {
      id, name,
      hashes: prev ? hashesOf(prev) : [sha(secret)],
      xp: int(b.xp, MAX.xp), correct: int(b.correct, MAX.correct), rounds: int(b.rounds, MAX.rounds),
      stage: Math.max(1, int(b.stage, MAX.stage)), updated: Date.now(),
      progress: cleanProgress(b.progress) || (prev && prev.progress) || null
    };
    await putPlayer(row);
    return res.status(200).json({ players: await board() });
  } catch (e) {
    console.error('leaderboard error', e && e.message);
    return res.status(500).json({ error: 'server error' });
  }
}
