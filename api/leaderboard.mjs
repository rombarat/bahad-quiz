// Leaderboard for the Bahad 1 quiz.
// Storage: Vercel Blob, one small JSON file per player (players/<id>.json),
// so two players saving at the same moment never overwrite each other.
import { list, put, head } from '@vercel/blob';
import { createHash } from 'node:crypto';

const MAX = { correct: 5000, rounds: 5000, stage: 1000, xp: 10_000_000 };
const sha = s => createHash('sha256').update(String(s)).digest('hex');
const int = (v, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);

async function readPlayer(url, stamp) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(stamp || Date.now()), { cache: 'no-store' });
  return r.ok ? r.json() : null;
}

async function board() {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix: 'players/', cursor, limit: 1000 });
    const rows = await Promise.all(page.blobs.map(b => readPlayer(b.url, b.uploadedAt).catch(() => null)));
    rows.forEach(p => p && out.push({ id: p.id, name: p.name, correct: p.correct, rounds: p.rounds, stage: p.stage, xp: p.xp || 0, updated: p.updated }));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => b.correct - a.correct || b.rounds - a.rounds || a.updated - b.updated);
  return out;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ players: await board() });
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const id = String(b.id || '');
      const secret = String(b.secret || '');
      const name = cleanName(b.name);
      if (!/^[a-z0-9]{10,32}$/.test(id)) return res.status(400).json({ error: 'bad id' });
      if (secret.length < 16 || secret.length > 64) return res.status(400).json({ error: 'bad secret' });
      if (!name) return res.status(400).json({ error: 'name required' });

      const path = `players/${id}.json`;
      const existing = await head(path).catch(() => null);
      if (existing) {
        const prev = await readPlayer(existing.url, existing.uploadedAt);
        if (prev && prev.hash !== sha(secret)) return res.status(403).json({ error: 'not your player' });
      }
      const row = {
        id, name, hash: sha(secret),
        correct: int(b.correct, MAX.correct), rounds: int(b.rounds, MAX.rounds),
        stage: Math.max(1, int(b.stage, MAX.stage)), xp: int(b.xp, MAX.xp), updated: Date.now()
      };
      await put(path, JSON.stringify(row), {
        access: 'public', contentType: 'application/json',
        addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60
      });
      return res.status(200).json({ players: await board() });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
}
