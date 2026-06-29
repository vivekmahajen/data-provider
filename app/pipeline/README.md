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

## Serving the data (the "offer to others" surface)

`npm start` exposes key-protected endpoints over this DB (in `server/provider-api.js`),
returning **only resale-safe** records (resale_ok + verified + not suppressed).
The DB auto-seeds from the sample on first boot.

```bash
KEY=$(curl -s localhost:3000/api/app/account | grep -o 'fe_live_[a-z0-9_]*')
curl -H "x-api-key: $KEY" "localhost:3000/api/v1/people/search?q=Sales&limit=3"
curl -H "x-api-key: $KEY" "localhost:3000/api/v1/people/<id>"      # + provenance
curl -H "x-api-key: $KEY" "localhost:3000/api/v1/export.csv?limit=1000"
curl -H "x-api-key: $KEY" "localhost:3000/api/v1/stats"
curl -H "x-api-key: $KEY" -X POST localhost:3000/api/v1/suppress -d '{"value":"a@b.com"}'
```

This closes the loop: **ingest → canonical DB → serving API → customers**, with
compliance enforced at query time (a suppressed value disappears from search and
export immediately).

### Billing & metering (charging customers)

Every Data API request is authenticated by a **per-customer key** and metered
(`server/billing.js`): **1 credit per delivered contact value**; `?preview=true`
returns masked values for **free**; a depleted balance returns **402** without
partial billing. Each customer has a plan (`free`/`starter`/`pro`/`scale`) with
included monthly credits and a usage ledger. The app's existing key is seeded as
an admin customer so nothing breaks.

```bash
ADMIN=$(curl -s localhost:3000/api/app/account | grep -o 'fe_live_[a-z0-9_]*')
curl -H "x-api-key: $ADMIN" localhost:3000/api/v1/billing/usage          # plan, balance, ledger
# provision a customer (admin only) → returns a fe_cust_… key
curl -H "x-api-key: $ADMIN" -X POST localhost:3000/api/v1/billing/customers -d '{"name":"Acme","plan":"starter"}'
curl -H "x-api-key: $ADMIN" "localhost:3000/api/v1/people/search?q=Sales&preview=true"  # free preview
```

Responses carry `X-Credits-Charged` / `X-Credits-Remaining`.

### Payments (Stripe)

Customers buy credit packs or upgrade plans via Stripe Checkout
(`server/payments.js`). Real Stripe is used when `STRIPE_SECRET_KEY` is set;
otherwise a **simulated** provider runs the whole flow with no keys.

```bash
curl -H "x-api-key: $CKEY" localhost:3000/api/v1/billing/catalog            # packs + plan prices
# start a purchase → returns a checkout url (Stripe-hosted, or a simulated complete url)
curl -H "x-api-key: $CKEY" -X POST localhost:3000/api/v1/billing/checkout -d '{"kind":"credits","target":"pack_1k"}'
# simulated mode: "pay" by POSTing to the returned url; Stripe mode: completion arrives via webhook
curl -H "x-api-key: $CKEY" -X POST localhost:3000/api/v1/billing/checkout/<paymentId>/complete
```

Going live: set `STRIPE_SECRET_KEY` (+ `STRIPE_WEBHOOK_SECRET`) and point a
Stripe webhook at `POST /api/v1/billing/webhook` — `checkout.session.completed`
grants credits (`billing.topUp`) or switches plan (`billing.changePlan`),
idempotently. Signature is verified against the raw request body.

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
