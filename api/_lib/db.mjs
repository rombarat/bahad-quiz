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
  `create table if not exists payments (
     sumit_payment_id bigint primary key,
     user_id bigint,
     amount numeric,
     paid_at timestamptz not null default now(),
     kind text not null)`
];

// Tagged-template query: await sql`select ... ${value}` → rows
export async function sql(strings, ...values) {
  const run = client();
  if (!schemaReady) {
    schemaReady = (async () => { for (const s of SCHEMA) await run([s]); })().catch(e => { schemaReady = null; throw e; });
  }
  await schemaReady;
  return run(strings, ...values);
}
