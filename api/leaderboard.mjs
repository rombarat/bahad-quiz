// Leaderboard + cross-device sync for the Bahad 1 quiz.
// Storage: Vercel Blob.
//   players/<id>.json  one file per player (stats, progress, hashes of device secrets)
//   codes/<code>.json  short-lived pairing codes for linking another device
// Secrets never get stored in plain text: each device holds its own secret,
// the server keeps only SHA-256 hashes.
import { list, put, head, del } from '@vercel/blob';
import { createHash, randomBytes } from 'node:crypto';

const MAX = { correct: 5000, rounds: 5000, stage: 1000, xp: 10_000_000 };
const CODE_TTL = 15 * 60 * 1000;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const sha = s => createHash('sha256').update(String(s)).digest('hex');
const int = (v, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const token = (n, abc = 'abcdefghijklmnopqrstuvwxyz0123456789') => [...randomBytes(n)].map(b => abc[b % abc.length]).join('');
const hashesOf = p => p ? (p.hashes || (p.hash ? [p.hash] : [])) : [];

async function readJson(url, stamp) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(stamp || Date.now()), { cache: 'no-store' });
  return r.ok ? r.json() : null;
}
async function getBlob(path) {
  const h = await head(path).catch(() => null);
  return h ? readJson(h.url, h.uploadedAt) : null;
}
const save = (path, obj) => put(path, JSON.stringify(obj), {
  access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60
});

async function board() {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix: 'players/', cursor, limit: 1000 });
    const rows = await Promise.all(page.blobs.map(b => readJson(b.url, b.uploadedAt).catch(() => null)));
    rows.forEach(p => p && out.push({ id: p.id, name: p.name, xp: p.xp || 0, correct: p.correct || 0, rounds: p.rounds || 0, stage: p.stage || 1, updated: p.updated || 0 }));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => b.xp - a.xp || b.correct - a.correct || a.updated - b.updated);
  return out;
}

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
  const prev = await getBlob(`players/${id}.json`);
  if (prev && !hashesOf(prev).includes(sha(secret))) return { error: 403 };
  return { prev };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json({ players: await board() });
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method not allowed' }); }

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = b.action || 'save';
    const id = String(b.id || ''), secret = String(b.secret || '');

    // Redeem a pairing code on a new device: returns a fresh secret for that device + saved progress.
    if (action === 'redeem') {
      const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 6) return res.status(400).json({ error: 'bad code' });
      const c = await getBlob(`codes/${code}.json`);
      if (!c || c.exp < Date.now()) return res.status(404).json({ error: 'code not found' });
      await del(`codes/${code}.json`).catch(() => {});
      const p = await getBlob(`players/${c.id}.json`);
      if (!p) return res.status(404).json({ error: 'player not found' });
      const newSecret = token(32);
      p.hashes = [...hashesOf(p), sha(newSecret)].slice(-10);
      delete p.hash;
      await save(`players/${p.id}.json`, p);
      return res.status(200).json({ id: p.id, secret: newSecret, name: p.name, progress: p.progress || null });
    }

    const auth = await authed(id, secret);
    if (auth.error === 400) return res.status(400).json({ error: 'bad id' });
    if (auth.error === 403) return res.status(403).json({ error: 'not your player' });
    const prev = auth.prev;

    if (action === 'pull') {
      return res.status(200).json({ name: prev ? prev.name : null, progress: prev ? prev.progress || null : null });
    }

    if (action === 'mkcode') {
      if (!prev) return res.status(404).json({ error: 'join first' });
      const code = token(6, CODE_ABC);
      await save(`codes/${code}.json`, { id, exp: Date.now() + CODE_TTL });
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
    await save(`players/${id}.json`, row);
    return res.status(200).json({ players: await board() });
  } catch (e) {
    console.error('leaderboard error', e && e.message);
    return res.status(500).json({ error: 'server error' });
  }
}
