# FullEnrich — Analysis, Benchmark & Gap Closure

Produced by the `website-analyzer-builder` skill for **https://fullenrich.com/**.

> **Method note.** The live site and several review pages returned HTTP 403 to
> automated fetches (network policy + bot protection), so the analysis below is
> built from web research (G2, review sites, FullEnrich's own indexed pages) and
> from public knowledge of the competitors. The **visual identity** (exact hex
> palette and font) could not be scraped and is a close, clearly-labelled
> approximation in `app/public/css/styles.css`. Everything else is sourced.

---

## Phase 1 — Target analysis: FullEnrich

**What it is.** A B2B *waterfall enrichment* service: feed it a contact (name +
company / LinkedIn URL) and it cascades the lookup through 20+ premium data
providers, returning the first **verified** email and/or mobile phone.

**Observed product capabilities**

| Area | Detail |
|---|---|
| Waterfall enrichment | 20+ providers in a cascade, +80% find rate; stops at first verified hit |
| Email verification | "Triple verifier"; recovers up to ~80% of catch-alls; <1% bounce |
| Phone | Mobile-first validation; ~85% business coverage; **10 credits** per mobile |
| Bulk | CSV upload → enriched list in minutes |
| API | REST API included on all plans |
| Integrations | HubSpot/any CRM auto-enrich; Zapier, Make, n8n, Clay, 1,000+ apps |
| Chrome extension | LinkedIn / Sales Navigator email & phone finder |
| Database/search | A lighter `/search` surface exists |
| Pricing | Credit-based; Starter ~$29/500cr, Pro ~$55/1,000cr; **email = 1 credit, mobile = 10**; only charged on success; rollover ~3 months |

**Visual identity (approximated).** Clean white surfaces, a violet/purple
primary, Inter-style type, soft rounded cards. Preserved in the rebuild's design
tokens.

## Phase 2 — Benchmark vs. market leaders

| Capability | FullEnrich | Clay | Apollo | BetterContact |
|---|:--:|:--:|:--:|:--:|
| Waterfall email/phone | ✅ | ✅ | ✅ | ✅ |
| Bulk CSV | ✅ | ✅ | ✅ | ✅ |
| REST API | ✅ | ✅ | ✅ | ✅ |
| Large searchable contact DB | ⚠️ light | ❌ | ✅ (275M) | ❌ |
| Outreach **sequences** | ❌ | ❌ | ✅ | ❌ |
| Built-in **dialer** | ❌ | ❌ | ✅ | ❌ |
| **AI research** column | ❌ | ✅ (Claygent) | ❌ | ❌ |
| Programmable **workflow/table** | ❌ | ✅ | ❌ | ❌ |
| **Analytics** (find-rate/credits) | ⚠️ minimal | ✅ | ✅ | ⚠️ |
| Credit system + rollover | ✅ | ✅ | ✅ | ✅ |

## Phase 3 — Gaps & priorities

Prioritised high-impact / reasonable-effort first:

1. **Contact database & search** (vs Apollo) — search by title/industry/size/
   location, reveal verified contacts on demand.
2. **Outreach sequences** (vs Apollo) — multi-step email+call cadences,
   templating, scheduling, reply tracking.
3. **AI research** (vs Clay) — per-contact Q&A: ICP fit, icebreakers, summaries.
4. **Workflow/table builder** (vs Clay) — stack enrichment + AI columns over
   rows, run in one pass.
5. **Built-in dialer** (vs Apollo) — click-to-call enriched mobiles, log
   outcomes.
6. **Analytics dashboard** — hit-rate, credit usage, provider-win breakdown.

## Phase 4 — Rebuild (what was built)

A runnable app in `/app` that **preserves FullEnrich's identity** and implements
the core **plus every gap above as a working function** (not just marketing
copy). See `app/README.md` for run instructions and the endpoint/feature map.

| Gap | Implemented as |
|---|---|
| Search DB | `GET /api/app/search`, `POST /api/app/search/reveal` + `Search DB` page |
| Sequences | `POST /api/app/sequences[/:id/enroll|/advance]` + `Sequences` page |
| Dialer | `POST /api/app/dialer/call` + `Dialer` page |
| AI research | `POST /api/app/ai-research` (Claude if `ANTHROPIC_API_KEY`, else heuristic) + `AI Research` page |
| Workflow builder | `POST /api/app/workflows[/:id/run]` + `Workflows` page |
| Analytics | `GET /api/app/analytics` + `Analytics` page |

Core preserved: waterfall engine (`server/lib/enrichment.js`), bulk CSV,
credit ledger with success-only charging, and a key-protected public REST API
(`/api/v1/*`).

## Phase 5 — Verification

- `npm test` — 9 passing unit tests (engine determinism, credit accounting,
  CSV parsing, workflow runner, sequences, dialer, AI research).
- All endpoints smoke-tested live; both pages render with no app JS errors
  (only blocked Google-Fonts requests, which fall back to system fonts).

### Honest limitations

- Data providers are **simulated** — there are no real third-party API keys in
  this environment. The waterfall *logic*, credit accounting, verification
  states and analytics are real; the underlying contact values are
  deterministic fakes. Swap `server/lib/enrichment.js` provider calls for real
  APIs to go live.
- The exact brand palette/font are approximated (site was un-scrapeable).
- AI research uses a heuristic unless `ANTHROPIC_API_KEY` is set.
