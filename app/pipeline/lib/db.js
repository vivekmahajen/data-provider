// Database layer for the pipeline. Uses Node's built-in SQLite (no native
// deps, no external service) so the whole pipeline runs from a clean checkout.
// The SQL in schema.sql is Postgres-portable; see pipeline/README.md for the
// swap-to-Postgres path (replace this module with a `pg` Pool of the same API).

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = resolve(__dirname, '../schema.sql');

// Deterministic-ish monotonic clock (Date.now is unavailable in some sandboxes).
let _clock = 1751000000000;
export function now() {
  _clock += 1000;
  return _clock;
}

export function id() {
  return randomUUID();
}

let _db = null;

export function open(path = resolve(__dirname, '../../data/provider.db')) {
  if (_db) return _db;
  _db = new DatabaseSync(path);
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec('PRAGMA foreign_keys = ON;');
  _db.exec(readFileSync(SCHEMA, 'utf8'));
  return _db;
}

export function db() {
  return open();
}

// Convenience wrappers ------------------------------------------------------
export function run(sql, params = {}) {
  return db().prepare(sql).run(params);
}
export function get(sql, params = {}) {
  return db().prepare(sql).get(params);
}
export function all(sql, params = {}) {
  return db().prepare(sql).all(params);
}

// Upsert a source and return its row.
export function ensureSource({ name, type, license = null, resaleAllowed = false }) {
  const existing = get('SELECT * FROM sources WHERE name = :name', { name });
  if (existing) return existing;
  const sid = id();
  run(
    `INSERT INTO sources (id, name, type, license, resale_allowed, created_at)
     VALUES (:id, :name, :type, :license, :resale, :created)`,
    { id: sid, name, type, license, resale: resaleAllowed ? 1 : 0, created: now() }
  );
  return get('SELECT * FROM sources WHERE id = :id', { id: sid });
}

export function recordProvenance(entityType, entityId, field, value, sourceId) {
  run(
    `INSERT INTO provenance (id, entity_type, entity_id, field, value, source_id, observed_at)
     VALUES (:id, :et, :eid, :field, :value, :sid, :ts)`,
    { id: id(), et: entityType, eid: entityId, field, value: value == null ? null : String(value), sid: sourceId, ts: now() }
  );
}

export function close() {
  if (_db) { _db.close(); _db = null; }
}
