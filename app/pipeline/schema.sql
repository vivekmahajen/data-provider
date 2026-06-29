-- Canonical data-provider schema.
-- Written for SQLite (node:sqlite) so the demo runs with zero external
-- services, but kept Postgres-portable: TEXT ids generated in app code (no
-- AUTOINCREMENT), simple types, explicit UNIQUE constraints. To move to
-- Postgres: TEXT->TEXT, INTEGER->BIGINT/INT, keep the same DDL shape.

-- Where every record came from, and whether we're allowed to RESELL it.
-- This single flag (resale_allowed) is what separates a compliant data
-- business from a ToS violation: third-party verify/enrich APIs are stored
-- with resale_allowed = 0 so their values can update STATUS but never become a
-- resellable source-of-record.
CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL,              -- first_party | licensed | public_web | third_party_verify
  license         TEXT,                       -- human-readable license / contract ref
  resale_allowed  INTEGER NOT NULL DEFAULT 0, -- 1 = values may be redistributed/sold
  created_at      INTEGER NOT NULL
);

-- Immutable landing zone: the raw payload exactly as received, with source +
-- timestamp. Never mutated; everything downstream is derived and re-buildable.
CREATE TABLE IF NOT EXISTS raw_records (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sources(id),
  payload     TEXT NOT NULL,                  -- JSON
  ingested_at INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'landed'  -- landed | processed | rejected
);

CREATE TABLE IF NOT EXISTS companies (
  id         TEXT PRIMARY KEY,
  domain     TEXT UNIQUE,
  name       TEXT,
  industry   TEXT,
  size       INTEGER,
  location   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id           TEXT PRIMARY KEY,
  full_name    TEXT,
  first_name   TEXT,
  last_name    TEXT,
  linkedin_url TEXT UNIQUE,
  company_id   TEXT REFERENCES companies(id),
  title        TEXT,
  location     TEXT,
  region       TEXT,                          -- coarse region for compliance gating (EU/US/...)
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Emails and phones. One row per (person, kind, value). Carries verification
-- status, confidence, and — crucially — the source + license it came from.
CREATE TABLE IF NOT EXISTS contact_points (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES people(id),
  kind        TEXT NOT NULL,                  -- email | phone
  value       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unverified', -- valid | catch_all | risky | invalid | unverified
  confidence  INTEGER NOT NULL DEFAULT 0,     -- 0-100
  source_id   TEXT NOT NULL REFERENCES sources(id),
  resale_ok   INTEGER NOT NULL DEFAULT 0,     -- denormalized from source for fast export filtering
  first_seen  INTEGER NOT NULL,
  verified_at INTEGER,
  UNIQUE (person_id, kind, value)
);

-- Field-level lineage: every observed value for an entity field, with its
-- source and when we saw it. This is what powers confidence (agreement across
-- sources), audit, and GDPR "where did you get this" requests.
CREATE TABLE IF NOT EXISTS provenance (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,                  -- person | company | contact_point
  entity_id   TEXT NOT NULL,
  field       TEXT NOT NULL,
  value       TEXT,
  source_id   TEXT NOT NULL REFERENCES sources(id),
  observed_at INTEGER NOT NULL
);

-- Global suppression list, checked at the compliance gate AND at export time.
CREATE TABLE IF NOT EXISTS suppressions (
  value      TEXT PRIMARY KEY,               -- email/phone/domain that must never be sold
  reason     TEXT NOT NULL,                  -- opt_out | gdpr_erasure | bounce | complaint
  created_at INTEGER NOT NULL
);

-- Lightweight job queue for the re-verification scheduler (fighting data decay).
CREATE TABLE IF NOT EXISTS jobs (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,                    -- reverify_contact | ...
  payload   TEXT NOT NULL,                    -- JSON
  run_after INTEGER NOT NULL,
  status    TEXT NOT NULL DEFAULT 'queued',   -- queued | done | failed
  attempts  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_people_company   ON people(company_id);
CREATE INDEX IF NOT EXISTS idx_people_name       ON people(full_name);
CREATE INDEX IF NOT EXISTS idx_cp_person         ON contact_points(person_id);
CREATE INDEX IF NOT EXISTS idx_cp_value          ON contact_points(value);
CREATE INDEX IF NOT EXISTS idx_prov_entity       ON provenance(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_jobs_due          ON jobs(status, run_after);

-- ---- Billing / payments (Data API monetization) ---------------------------
CREATE TABLE IF NOT EXISTS customers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  api_key          TEXT NOT NULL UNIQUE,
  plan             TEXT NOT NULL,
  credits_included INTEGER NOT NULL,
  credits_used     INTEGER NOT NULL DEFAULT 0,
  period_start     INTEGER NOT NULL,
  is_admin         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_events (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  endpoint    TEXT NOT NULL,
  units       INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  meta        TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  kind        TEXT NOT NULL,
  target      TEXT NOT NULL,
  credits     INTEGER NOT NULL DEFAULT 0,
  amount_usd  INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  session_id  TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_customer  ON usage_events(customer_id, ts);
CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(session_id);
