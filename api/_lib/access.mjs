// Who may see all the questions.
// - PAYWALL not "on": everyone (the switch stays off until billing is set up and tested)
// - friends: device accounts that were on the leaderboard before the paywall, plus FRIEND_PLAYER_IDS / FRIEND_EMAILS
// - subscribers: an active or cancelled subscription whose paid period hasn't ended yet
import { createHash } from 'node:crypto';
import { getPlayer } from './players.mjs';
import { sql, hasDb } from './db.mjs';
import { sessionOf, cookies } from './session.mjs';

// Players on the leaderboard when the paywall was built. Their ids are public on the board;
// using one still requires the device secret, which only the player's own devices hold.
const FRIENDS_AT_LAUNCH = [
  'qxk6kup5k0t3bfuw', 'ink5acb17n8gkl5q', '6za13id46rdpoeef', '9pg2ql33ncbsruav', '7klrgtnmn09cz3de',
  'sxstcys5iugfrw1r', 'w4scjxltb2xf5g6j', 'dxborh5ezym7uonn', '7ey8qu0loq1ynotc', 'kgg754m3gjl07gqc',
  'pndqghkkdomslgpu'
];
const list = v => String(v || '').split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
// On for everyone with PAYWALL=on. Before that, one browser can try the whole flow by opening /?paywall-test=1
// (sets the bq_pwtest cookie; /?paywall-test=0 clears it). It only ever locks that browser, so it needs no protection.
// PAYWALL_FROM (an ISO date) delays it: until then everything stays open and the app shows a countdown.
export const paywallFrom = () => { const t = Date.parse(process.env.PAYWALL_FROM || ''); return Number.isFinite(t) ? t : null; };
export const paywallOn = req => (process.env.PAYWALL === 'on' && !(paywallFrom() && Date.now() < paywallFrom()))
  || (!!req && cookies(req).bq_pwtest === '1');
const friendPlayer = id => FRIENDS_AT_LAUNCH.includes(id) || list(process.env.FRIEND_PLAYER_IDS).includes(id);
const friendEmail = email => !!email && list(process.env.FRIEND_EMAILS).includes(email.toLowerCase());
const sha = s => createHash('sha256').update(String(s)).digest('hex');

// The device account (leaderboard player) from the X-Acct header "id.secret", checked against its stored hashes.
async function devicePlayer(req) {
  const m = String(req.headers['x-acct'] || '').match(/^([a-z0-9]{10,32})\.([a-z0-9]{16,64})$/);
  if (!m) return null;
  const [, id, secret] = m;
  if (globalThis.__PLAYERS__) {
    const p = globalThis.__PLAYERS__[id];
    return p && (p.hashes || []).includes(sha(secret)) ? id : null;
  }
  try {
    const p = await getPlayer(id);
    return p && p.hashes.includes(sha(secret)) ? id : null;
  } catch { return null; }
}

// Returns { user, sub, access: { full, reason, paidUntil, status } }
export async function accessFor(req) {
  const sess = sessionOf(req);
  let user = null, sub = null, viaSession = false;
  const pw = paywallOn(req);
  const playerId = pw || sess ? await devicePlayer(req) : null;
  if (hasDb() && (sess || (pw && playerId))) {
    if (sess) [user] = await sql`select id, email, name, player_id from users where id = ${sess.uid}`;
    viaSession = !!user;
    // no sign-in on this device (e.g. the installed iPhone app, or a phone synced with a code):
    // fall back to the person this device account was linked to when they signed in
    if (!user && playerId) [user] = await sql`select id, email, name, player_id from users where player_id = ${playerId} order by id limit 1`;
    if (user) {
      [sub] = await sql`select status, paid_until, sumit_customer_id, sumit_recurring_id from subscriptions where user_id = ${user.id}`;
      // remember which device account this person plays on, so a friend keeps access after signing in elsewhere
      if (playerId && !user.player_id) {
        await sql`update users set player_id = ${playerId} where id = ${user.id}`;
        user.player_id = playerId;
      }
    }
  }
  const paidUntil = sub && sub.paid_until ? new Date(sub.paid_until) : null;
  let reason = 'none';
  if (!pw) reason = 'open';
  else if ((playerId && friendPlayer(playerId)) || (user && (friendPlayer(user.player_id) || friendEmail(user.email)))) reason = 'friend';
  else if (sub && paidUntil && paidUntil > new Date() && sub.status !== 'failed') reason = 'subscription';
  return {
    user: user ? { email: user.email, name: user.name } : null,
    sub,
    userId: user ? Number(user.id) : null,
    viaSession,
    access: { full: reason !== 'none', reason, paidUntil: paidUntil ? paidUntil.toISOString() : null, status: sub ? sub.status : null }
  };
}
