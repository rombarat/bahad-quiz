// The questions beyond the free 100. Sent only to people with access (see _lib/access.mjs).
// Each row: [id, topic, question, answer, 'wrong1|wrong2|wrong3', explanation]; id is the question's
// permanent position, which saved progress refers to.
import { readFileSync } from 'node:fs';
import { accessFor } from './_lib/access.mjs';

let rows = null;
const load = () => rows || (rows = JSON.parse(readFileSync(new URL('./_data/premium.json', import.meta.url), 'utf8')));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const a = await accessFor(req);
    if (!a.access.full) return res.status(402).json({ error: 'subscription required', access: a.access });
    return res.status(200).json({ questions: load(), access: a.access });
  } catch (e) {
    console.error('questions', e && e.message);
    return res.status(500).json({ error: 'server error' });
  }
}
