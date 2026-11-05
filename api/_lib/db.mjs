// Postgres (Neon) access for accounts and subscriptions.
// DATABASE_URL is added by the Vercel ↔ Neon integration. Tests inject globalThis.__SQL__ instead.
import { neon } from '@neondatabase/serverless';

let sqlFn = null;
let schemaReady = null;

export function hasDb() {
  return Boolean(globalThis.__SQL__ || process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function client() {
  if (globalThis.__SQL__) return globalThis.__SQL__;
  if (!sqlFn) sqlFn = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  return sqlFn;
}

const SCHEMA = [
  `create table if not exists users (
     id bigserial primary key,
     google_sub text unique not null,
     email text not null,
     name text,
     player_id text,
     created_at timestamptz not null default now())`,
  `create table if not exists subscriptions (
     user_id bigint primary key references users(id),
     status text not null,
     paid_until timestamptz,
     sumit_customer_id bigint,
     sumit_recurring_id bigint,
     started_at timestamptz not null default now(),
     updated_at timestamptz not null default now())`,
  `create index if not exists subscriptions_customer on subscriptions (sumit_customer_id)`,
  // one row per payment SUMIT reported (webhook or the daily check); email is how a payment finds its user
  `create table if not exists payments (
     ref text primary key,
     user_id bigint,
     email text,
     sumit_customer_id bigint,
     amount numeric,
     paid_at timestamptz not null default now(),
     kind text not null)`,
  `create index if not exists payments_email on payments (lower(email)) where user_id is null`,
  // leaderboard players (moved from Vercel Blob) and short-lived codes for linking another device
  `create table if not exists players (
     id text primary key,
     name text not null default '',
     hashes jsonb not null default '[]'::jsonb,
     xp integer not null default 0,
     correct integer not null default 0,
     rounds integer not null default 0,
     stage integer not null default 1,
     progress jsonb,
     updated bigint not null default 0)`,
  `create index if not exists players_rank on players (xp desc) where name <> ''`,
  `alter table users add column if not exists picture text`,
  // sharing: who brought whom (from a ?ref= link) and how often a player shared the app
  `alter table players add column if not exists referred_by text`,
  `alter table players add column if not exists shares integer not null default 0`,
  `alter table players add column if not exists shared_at bigint`,
  `create index if not exists players_referred_by on players (referred_by) where referred_by is not null`,
  `create table if not exists pair_codes (code text primary key, id text not null, exp bigint not null)`,
  // private group leaderboards: anyone on the board can open one and share its code with friends
  `create table if not exists groups (code text primary key, name text not null, owner text not null, created bigint not null)`,
  `create table if not exists group_members (code text not null, player_id text not null, joined bigint not null, primary key (code, player_id))`,
  `create index if not exists group_members_player on group_members (player_id)`,
  // group chat: kind 'text' (typed), 'quick' (a ready-made reaction), 'system' (overtakes, new stages)
  `create table if not exists group_messages (
     id bigserial primary key,
     code text not null,
     player_id text,
     kind text not null,
     body text not null,
     created bigint not null)`,
  `create index if not exists group_messages_code on group_messages (code, id)`,
  // raw webhook bodies, kept so a payment that didn't match anyone can be checked and assigned by hand
  `create table if not exists webhook_events (
     id bigserial primary key,
     received_at timestamptz not null default now(),
     matched boolean not null default false,
     body text not null)`
];

// Tagged-template query: await sql`select ... ${value}` → rows
export async function sql(strings, ...values) {
  const run = client();
  if (!schemaReady) {
    // plain SQL text goes through .query(): the Neon driver only accepts real tagged templates when called directly
    schemaReady = (async () => { for (const s of SCHEMA) await run.query(s); })().catch(e => { schemaReady = null; throw e; });
  }
  await schemaReady;
  return run(strings, ...values);
}
