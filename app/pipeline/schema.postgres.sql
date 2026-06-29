-- PostgreSQL schema (used when DATABASE_URL is set). Mirrors schema.sql but
-- uses BIGINT for ms-epoch timestamp columns (they exceed INT4 range) and
-- otherwise keeps the same shape: app-generated TEXT ids, INTEGER flags.

CREATE TABLE IF NOT EXISTS sources (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,
  license        TEXT,
  resale_allowed INTEGER NOT NULL DEFAULT 0,
  created_at     BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_records (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sources(id),
  payload     TEXT NOT NULL,
  ingested_at BIGINT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'landed'
);

CREATE TABLE IF NOT EXISTS companies (
  id         TEXT PRIMARY KEY,
  domain     TEXT UNIQUE,
  name       TEXT,
  industry   TEXT,
  size       INTEGER,
  location   TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
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
  region       TEXT,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_points (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES people(id),
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unverified',
  confidence  INTEGER NOT NULL DEFAULT 0,
  source_id   TEXT NOT NULL REFERENCES sources(id),
  resale_ok   INTEGER NOT NULL DEFAULT 0,
  first_seen  BIGINT NOT NULL,
  verified_at BIGINT,
  UNIQUE (person_id, kind, value)
);

CREATE TABLE IF NOT EXISTS provenance (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  field       TEXT NOT NULL,
  value       TEXT,
  source_id   TEXT NOT NULL REFERENCES sources(id),
  observed_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppressions (
  value      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  payload   TEXT NOT NULL,
  run_after BIGINT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'queued',
  attempts  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_people_company ON people(company_id);
CREATE INDEX IF NOT EXISTS idx_people_name    ON people(full_name);
CREATE INDEX IF NOT EXISTS idx_cp_person      ON contact_points(person_id);
CREATE INDEX IF NOT EXISTS idx_cp_value       ON contact_points(value);
CREATE INDEX IF NOT EXISTS idx_prov_entity    ON provenance(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_jobs_due       ON jobs(status, run_after);

-- ---- Billing / payments ----------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  api_key          TEXT NOT NULL UNIQUE,
  plan             TEXT NOT NULL,
  credits_included INTEGER NOT NULL,
  credits_used     INTEGER NOT NULL DEFAULT 0,
  period_start     BIGINT NOT NULL,
  is_admin         INTEGER NOT NULL DEFAULT 0,
  created_at       BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_events (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  endpoint    TEXT NOT NULL,
  units       INTEGER NOT NULL,
  ts          BIGINT NOT NULL,
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
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_customer   ON usage_events(customer_id, ts);
CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(session_id);
