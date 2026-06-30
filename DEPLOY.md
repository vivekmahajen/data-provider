# Deploying the candidate registry

This is a standard Node app (the code is in `app/`). It runs on anything that
hosts Node or Docker. The one thing that matters for a real registry:

> **Use Postgres in production.** Free hosts wipe the filesystem on every
> redeploy, which would erase candidate signups stored in SQLite. Set
> `DATABASE_URL` to a managed Postgres and the app uses it automatically
> (schema is applied on first boot). Use SQLite only for quick demos, or pair it
> with a paid persistent disk.

## Recommended: Render (web UI, free Postgres) — no CLI needed

1. Make sure this repo is on GitHub (it is: `vivekmahajen/data-provider`).
2. Go to https://render.com → sign in with GitHub → **New → Blueprint**.
3. Pick this repo. Render reads `render.yaml`, creates the **web service +
   a free Postgres database**, and wires `DATABASE_URL` for you.
4. Click **Apply**. First deploy takes a few minutes.
5. In the service's **Environment** tab, set **`ADMIN_API_KEY`** to a long random
   secret (this is your master Data-API key — don't leave it as the demo value).
6. Open the service URL:
   - Candidates: `https://<your-app>.onrender.com/registry`
   - Universities: `https://<your-app>.onrender.com/universities`
   - Privacy: `/privacy`  ·  Health: `/api/health`

Note: Render's free Postgres expires after ~90 days and the free web service
sleeps when idle — fine for testing; upgrade to paid plans for production.

## Vercel (serverless)

Vercel runs the app as a serverless function (config: `app/vercel.json`,
entry `app/api/index.js`). Because Vercel's filesystem is read-only/ephemeral,
**you must use a managed Postgres** — SQLite/file storage will not persist.

1. Create a Postgres database: **Vercel → Storage → Postgres** (or Neon /
   Supabase). Copy its connection string.
2. **Vercel → Add New → Project**, import `vivekmahajen/data-provider`.
3. Set **Root Directory = `app`** (the app lives there).
4. Add Environment Variables:
   - `DATABASE_URL` = your Postgres connection string  ← **required**
   - `ADMIN_API_KEY` = a long random secret
   - (optional) `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
5. Deploy. Then visit `/registry`, `/universities`, `/admin`.

Notes & caveats:
- `app/vercel.json` rewrites all routes to the single function, which serves both
  the API and the static pages, and bundles the schema + `public/` via
  `includeFiles`.
- Initialization (schema + admin seed) runs lazily on the first request.
- The marketing/enrichment demo state (`store.js`) is best-effort on Vercel and
  may reset between invocations — the real product data (candidates, customers,
  payments) lives in Postgres and persists.
- If Vercel's file-bundling or cold starts give you trouble, **Render is a more
  natural fit** for this stateful app (see above) — same `DATABASE_URL`.

## Alternative: Fly.io or Railway (Docker)

The repo ships a `app/Dockerfile`, so any container host works.

**Fly.io**
```bash
cd app
fly launch            # detects the Dockerfile; say no to deploying immediately
fly postgres create   # creates a managed Postgres
fly postgres attach <db-name>   # sets DATABASE_URL on the app
fly secrets set ADMIN_API_KEY=$(openssl rand -hex 24)
fly deploy
```

**Railway**
- New Project → Deploy from GitHub repo → set **Root Directory** to `app`.
- Add a **Postgres** plugin (sets `DATABASE_URL`).
- Add variable `ADMIN_API_KEY`. Deploy.

**Plain VPS / Docker**
```bash
cd app
docker build -t candidate-registry .
docker run -p 8080:8080 \
  -e DATABASE_URL=postgres://user:pass@host:5432/db \
  -e ADMIN_API_KEY=$(openssl rand -hex 24) \
  candidate-registry
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | host sets it | Port to listen on (defaults 3000 local / 8080 in Docker) |
| `DATABASE_URL` | **production** | Postgres connection string → data persists |
| `ADMIN_API_KEY` | **production** | Your master Data-API key (override the demo value) |
| `STRIPE_SECRET_KEY` | optional | Real Stripe payments (else simulated) |
| `STRIPE_WEBHOOK_SECRET` | optional | Verify Stripe webhooks |
| `PIPELINE_BLOCK_REGIONS` | optional | Comma list of regions to exclude at ingest |

## After it's live

1. **Verify Postgres**: the first boot applies the schema. You can confirm with
   `DATABASE_URL=… npm run db:migrate` locally, or just check `/api/health`.
2. **Onboard a university** (issue them a key):
   ```bash
   curl -H "x-api-key: $ADMIN_API_KEY" -H 'content-type: application/json' \
     -X POST https://<your-app>/api/v1/billing/customers \
     -d '{"name":"Pune University","plan":"starter"}'
   ```
   Give them the returned `fe_cust_…` key to use at `/universities`.
3. **Share `/registry`** with candidates to start collecting consented signups.
4. **Fill in `/privacy`** (entity, grievance officer, retention) and have counsel
   confirm DPDP fit before collecting real data.
5. For Stripe payments, set the Stripe env vars and point a webhook at
   `POST /api/v1/billing/webhook`.

## Caveat

The Postgres code path is exercised through the same async call sites the test
suite covers on SQLite, and the SQL is unit-tested, but it has not been run
against a live Postgres in CI. Run `npm run db:migrate` against your
`DATABASE_URL` once after deploy to confirm connectivity end-to-end.
