// Database layer — pluggable backend, async interface.
//
//   default:           Node's built-in SQLite (no deps, no service) — the
//                      tested demo runtime.
//   DATABASE_URL set:  PostgreSQL via `pg` (lazy-imported), for production scale.
//
// The interface is async so both backends share identical call sites. Callers
// `await get/all/run/exec`. SQLite is synchronous under the hood but wrapped in
// async so swapping to Postgres needs no caller changes — only DATABASE_URL.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQLITE = resolve(__dirname, '../schema.sql');
const SCHEMA_PG = resolve(__dirname, '../schema.postgres.sql');

// Deterministic-ish monotonic clock (Date.now is unavailable in some sandboxes).
let _clock = 1751000000000;
export function now() { _clock += 1000; return _clock; }
export function id() { return randomUUID(); }

let _backend = null;

// ---- backends --------------------------------------------------------------

function makeSqlite(path) {
  // Create the parent directory on first run (git doesn't track empty dirs, so
  // a fresh clone has no data/ folder → SQLite "unable to open database file").
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const d = new DatabaseSync(path);
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec('PRAGMA foreign_keys = ON;');
  return {
    dialect: 'sqlite',
    async exec(sql) { d.exec(sql); },
    async run(sql, params = {}) { return d.prepare(sql).run(params); },
    async get(sql, params = {}) { return d.prepare(sql).get(params); },
    async all(sql, params = {}) { return d.prepare(sql).all(params); },
    async close() { d.close(); },
  };
}

// Convert `:name` placeholders + a params object to Postgres `$n` + values.
// Exported for unit testing the adapter without a live Postgres.
export function toPg(sql, params = {}) {
  const values = [];
  const seen = new Map();
  const text = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
    if (!seen.has(name)) { values.push(params[name] === undefined ? null : params[name]); seen.set(name, values.length); }
    return '$' + seen.get(name);
  });
  return { text, values };
}

// Resolve a Postgres connection string from the common env-var names. Vercel's
// Supabase/Neon integrations inject POSTGRES_URL (pooled) etc. rather than
// DATABASE_URL, so we accept any of them.
export function connectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_PRISMA_URL ||
    null
  );
}

async function makePg(url) {
  const pg = (await import('pg')).default;
  // Return BIGINT (oid 20) as a JS number — our values (ms timestamps) are well
  // within Number.MAX_SAFE_INTEGER, and this keeps arithmetic/comparisons sane.
  pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
  // Managed Postgres (Supabase/Neon/RDS) needs SSL; local does not. We don't
  // verify the cert chain to avoid pooler self-signed-cert hassles.
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 3, // gentle on serverless / pooled connections
  });
  return {
    dialect: 'pg',
    pool,
    async exec(sql) { await pool.query(sql); },
    async run(sql, params = {}) { const { text, values } = toPg(sql, params); return pool.query(text, values); },
    async get(sql, params = {}) { const { text, values } = toPg(sql, params); const r = await pool.query(text, values); return r.rows[0]; },
    async all(sql, params = {}) { const { text, values } = toPg(sql, params); const r = await pool.query(text, values); return r.rows; },
    async close() { await pool.end(); },
  };
}

async function applySchema(backend) {
  const file = backend.dialect === 'pg' ? SCHEMA_PG : SCHEMA_SQLITE;
  await backend.exec(readFileSync(file, 'utf8'));
}

// ---- lifecycle -------------------------------------------------------------

// On serverless (Vercel) the project FS is read-only — fall back to /tmp so
// SQLite at least doesn't crash. NOTE: /tmp is ephemeral and per-instance, so
// production on Vercel must set DATABASE_URL (Postgres) for real persistence.
const DEFAULT_SQLITE = process.env.VERCEL
  ? resolve(tmpdir(), 'provider.db')
  : resolve(__dirname, '../../data/provider.db');

export async function open(sqlitePath = DEFAULT_SQLITE) {
  if (_backend) return _backend;
  const url = connectionString();
  _backend = url ? await makePg(url) : makeSqlite(sqlitePath);
  await applySchema(_backend);
  return _backend;
}

export function dialect() { return _backend?.dialect || (connectionString() ? 'pg' : 'sqlite'); }

export async function close() { if (_backend) { await _backend.close(); _backend = null; } }

// ---- async query helpers ---------------------------------------------------

export async function exec(sql) { return (await open()).exec(sql); }
export async function run(sql, params = {}) { return (await open()).run(sql, params); }
export async function get(sql, params = {}) { return (await open()).get(sql, params); }
export async function all(sql, params = {}) { return (await open()).all(sql, params); }

// Upsert a source and return its row.
export async function ensureSource({ name, type, license = null, resaleAllowed = false }) {
  const existing = await get('SELECT * FROM sources WHERE name = :name', { name });
  if (existing) return existing;
  const sid = id();
  await run(
    `INSERT INTO sources (id, name, type, license, resale_allowed, created_at)
     VALUES (:id, :name, :type, :license, :resale, :created)`,
    { id: sid, name, type, license, resale: resaleAllowed ? 1 : 0, created: now() }
  );
  return get('SELECT * FROM sources WHERE id = :id', { id: sid });
}

export async function recordProvenance(entityType, entityId, field, value, sourceId) {
  await run(
    `INSERT INTO provenance (id, entity_type, entity_id, field, value, source_id, observed_at)
     VALUES (:id, :et, :eid, :field, :value, :sid, :ts)`,
    { id: id(), et: entityType, eid: entityId, field, value: value == null ? null : String(value), sid: sourceId, ts: now() }
  );
}
