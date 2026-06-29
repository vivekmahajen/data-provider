# Data pipeline — build & sell a contact database

The ingestion/processing/storage half of a data-provider business. It turns raw
source records into a **canonical, deduped, verified, compliance-gated** contact
database, and reuses the waterfall **enrichment engine** from `../server/lib`.

Runs on Node's built-in SQLite — **no external services** — and the SQL is
Postgres-portable.

## Quick start

```bash
cd app && npm install

# Ingest a first-party / licensed CSV (optionally enrich gaps via the waterfall)
npm run pipeline -- ingest pipeline/data/sample-leads.csv --type first_party --enrich

npm run pipeline -- stats        # what's in the DB
npm run pipeline -- export 100   # resale-SAFE contacts only (CSV to stdout)
npm run pipeline -- reverify 50  # re-verify stale contacts (decay defense)
npm run pipeline -- suppress someone@acme.com opt_out
npm run pipeline -- erase someone@acme.com     # GDPR/CCPA erasure

npm run test:pipeline            # 8 tests
```

Block regions where you lack lawful basis:
```bash
PIPELINE_BLOCK_REGIONS=EU npm run pipeline -- ingest pipeline/data/sample-leads.csv
```

## The stages (`lib/pipeline.js` orchestrates)

| # | Stage | File |
|---|---|---|
| 2 | Land raw (immutable + provenance) | `lib/db.js` (`raw_records`) |
| 3 | Normalize (name/domain/phone/email/region) | `lib/normalize.js` |
| 8 | Compliance gate (suppression + region) | `lib/compliance.js` |
| 4 | Identity resolution & dedup | `lib/identity.js` |
| – | Upsert contact points + provenance | `lib/pipeline.js` |
| 5 | Enrichment (fills gaps; **not** resellable) | `../server/lib/enrichment.js` |
| 6 | Verification (email/phone status) | `lib/verify.js` |
| 7 | Confidence scoring | `lib/scoring.js` |
| 11 | Re-verification scheduler | `lib/jobs.js` |

Add a source by subclassing `connectors/base.js` (see `connectors/csv.js`).

## The one rule that makes it a *business*: `resale_allowed`

Every source carries a `resale_allowed` flag, denormalized onto each contact
point as `resale_ok`. Values from **first-party / licensed** sources are
resellable; values discovered via **third-party enrichment/verify APIs**
(Apollo, Hunter, …) are stored `resale_ok = 0` — useful for **your own**
outreach, but **never** included in `export`. This mirrors real provider
contracts, which almost universally forbid redistributing their data. The
end-to-end demo shows it: ingesting the sample with `--enrich` stores 11
contacts but exports only the 8 first-party ones.

Compliance is enforced in three places: at the **gate** (block suppressed /
restricted-region on the way in), at **erasure** (`erase` deletes everywhere +
suppresses so it can't return), and at **export** (resale_ok + verified +
not-suppressed only).

## Moving to Postgres

Swap `lib/db.js` for a `pg` Pool exposing the same `run/get/all` helpers and run
`schema.sql` (change `INTEGER`→`BIGINT`, keep TEXT ids). Everything else is
plain SQL and unchanged. For scale, put a queue (pg-boss/BullMQ/Temporal) behind
`lib/jobs.js`, a stream (Kafka) in front of stage 2, and a search index
(OpenSearch/Typesense) alongside the canonical store for the search product.

## Honest limitations

Verification and the enrichment providers are **simulated** (deterministic, no
real API keys here) — the *logic*, schema, dedup, provenance, scoring and
compliance gates are real. Replace `lib/verify.js` and the enrichment provider
calls with real APIs (ZeroBounce/Twilio Lookup; Apollo/Hunter for **verify
only**) to go live. None of this is legal advice — confirm GDPR lawful basis,
CCPA data-broker registration, and each source's resale terms before selling.
```
