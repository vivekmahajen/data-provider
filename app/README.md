# FullEnrich — rebuild

A rebuild of [fullenrich.com](https://fullenrich.com/) produced by the
`website-analyzer-builder` skill. It **preserves FullEnrich's visual identity**
(clean white + violet, Inter-style type) and rebuilds the core product —
waterfall email/phone enrichment, bulk CSV, credits, REST API — while **closing
every capability gap** found against Clay, Apollo and BetterContact.

See [`../docs/GAP-ANALYSIS.md`](../docs/GAP-ANALYSIS.md) for the full
analysis, benchmark matrix and gap list.

## Run it

```bash
cd app
npm install
npm start          # → http://localhost:3000
```

- Marketing site: `http://localhost:3000/`
- App dashboard: `http://localhost:3000/app`

```bash
npm test           # 9 unit tests (engine, workflows, sequences, dialer, ai)
npm run seed       # regenerate the contact DB + reset credits
```

Optional: set `ANTHROPIC_API_KEY` to make **AI Research** call Claude instead of
the offline heuristic. Set `PORT` to change the port.

## What's in the box

**Core (rebuilt from FullEnrich)**
- 🌊 Waterfall enrichment across 8 simulated providers — stops at first verified
  hit; email = 1 credit, mobile = 10 credits; only charged on success.
- ✅ Triple-verifier email status (valid / catch-all / risky) + confidence.
- 📇 Bulk CSV enrichment (up to 1,000 rows).
- 🔌 Key-protected public REST API (`/api/v1/enrich`, `/api/v1/credits`).
- 💳 Credit ledger with rollover.

**Candidate registry (opt-in, consent-based)** — a public signup at `/registry`
for job-seekers who **consent** to be listed for university hiring (Dean,
Director of Admissions, Registrar, …). Consent + exact text + timestamp are
recorded and written to the provenance log (India DPDP lawful basis); candidates
can withdraw, which suppresses their data. Universities search the pool via the
billed Data API (`/api/v1/people/search?candidatesOnly=true&role=Dean`).

**Gaps closed (new vs. the leaders)**
- 🔎 **Search DB** — searchable B2B contact database with facets + reveal-on-demand *(vs Apollo)*.
- ✉️ **Sequences** — multi-step email+call cadences, templating, scheduling, reply tracking *(vs Apollo)*.
- 📞 **Dialer** — click-to-call enriched mobiles, logged outcomes *(vs Apollo)*.
- 🤖 **AI Research** — per-contact Q&A (ICP fit, icebreakers, summaries) *(vs Clay)*.
- 🧱 **Workflow builder** — programmable table; stack enrichment + AI columns, run in one pass *(vs Clay)*.
- 📊 **Analytics** — hit-rate, credit usage, provider-win breakdown.

## Layout

```
app/
  server/
    index.js            Express app + all routes
    seed.js             seed/reset the JSON store
    lib/
      enrichment.js     waterfall engine (core)
      airesearch.js     AI research (Claude or heuristic)
      sequences.js      sequences + dialer
      workflows.js      programmable workflow runner
      store.js          in-memory store + contact DB (JSON-persisted)
      util.js           hashing, CSV parser, ids, clock
  public/
    index.html          marketing site (identity preserved)
    app.html            dashboard shell
    js/app.js           dashboard client
    css/styles.css      design tokens (brand palette)
  test/smoke.test.js    unit tests
  data/db.json          generated at first run
```

## Honest limitations

The data providers are **simulated** — no real third-party API keys exist in
this environment. The waterfall *logic*, credit accounting, verification states
and analytics are genuinely implemented and exercised; the underlying contact
values are deterministic placeholders. To go live, replace the simulated
provider calls in `server/lib/enrichment.js` with real provider APIs. The brand
palette/font are a close approximation (the live site blocked scraping).
