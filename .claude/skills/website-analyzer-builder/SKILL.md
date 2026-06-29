---
name: website-analyzer-builder
description: >-
  Analyzes any website's frontend and backend architecture, compares it against
  market leaders, produces a detailed gap analysis, then rebuilds the site
  preserving its visual identity while adding every missing capability
  identified. Triggers when a user shares a URL and asks to analyze, improve,
  rebuild, or upgrade their website against competitors.
---

# Website Analyzer & Builder

A workflow for analyzing an existing website, benchmarking it against market
leaders, and rebuilding it so it keeps its visual identity while gaining every
capability it was missing.

## When to use this skill

Invoke when the user shares a URL **and** asks to:

- analyze a website's architecture or tech stack,
- compare a site against competitors / market leaders,
- find gaps or weaknesses versus the competition,
- improve, upgrade, or rebuild a site, or
- "make my site as good as <competitor>".

If the user shares a URL with no clear intent, ask whether they want an
**analysis only** or a **full rebuild** before proceeding.

## Inputs to gather first

1. **Target URL** — the site to analyze/rebuild (required).
2. **Competitors / market leaders** — explicit list, or infer 3–5 from the
   site's industry if the user doesn't supply them.
3. **Scope** — analysis-only, gap analysis, or full rebuild.
4. **Output location** — which directory/repo the rebuild should land in.
5. **Constraints** — required framework, hosting target, brand assets that must
   be preserved, accessibility/SEO targets, budget for third-party services.

## Phase 1 — Analyze the target site

Capture both the **frontend** and the **backend/architecture** signals you can
observe from the outside.

**Frontend**
- Framework/library (React, Vue, Svelte, Next.js, plain HTML, WordPress, etc.)
- Rendering strategy (SSR, SSG, SPA, hydration)
- Styling approach (Tailwind, CSS modules, design system, inline)
- Component structure, routing, and key pages/flows
- Design identity: color palette, typography, spacing, logo, imagery, tone
- Performance (Core Web Vitals: LCP, CLS, INP), bundle size, lazy-loading
- Accessibility (semantic HTML, ARIA, contrast, keyboard nav)
- SEO (meta tags, structured data, sitemap, canonical, OG tags)
- Analytics / tag managers / A/B tooling present

**Backend / architecture**
- Hosting & CDN (response headers, `server`, `x-powered-by`, CDN fingerprints)
- API style (REST/GraphQL), auth model, session/cookie handling
- Forms, search, checkout/payments, CMS, personalization
- Third-party integrations (payments, email, chat, maps, auth providers)
- Caching, security headers (CSP, HSTS), rate limiting signals

> Use available tools (WebFetch/WebSearch, browser automation, response-header
> inspection) to gather evidence. Record concrete observations, not guesses —
> label anything inferred as an assumption.

## Phase 2 — Benchmark against market leaders

For each competitor, run a lighter version of the Phase 1 checklist and build a
capability matrix:

| Capability | Target site | Leader A | Leader B | Gap? |
|------------|-------------|----------|----------|------|

Cover features, UX flows, performance, accessibility, SEO, content depth,
integrations, and trust signals (reviews, security badges, social proof).

## Phase 3 — Gap analysis

Produce a written report with:

- **Summary** — where the target stands versus the field.
- **Gaps** — each missing/weaker capability, with the leader(s) that have it.
- **Impact & effort** — prioritize (high impact / low effort first).
- **Recommendations** — concrete, ordered changes to close each gap.

Confirm the prioritized list with the user before building.

## Phase 4 — Rebuild

Rebuild the site so it **preserves the existing visual identity** (palette,
typography, logo, layout language, tone) while **adding every gap-closing
capability** from Phase 3.

- Re-create the design tokens first so the look stays faithful.
- Pick a stack appropriate to the project (default to a modern, well-supported
  framework unless the user specified one).
- Implement page-by-page; wire up the new capabilities (search, auth, forms,
  CMS, payments, SEO, analytics, a11y) identified as gaps.
- Keep accessibility and Core Web Vitals as acceptance criteria, not
  afterthoughts.
- Leave the original visual identity intact unless the user explicitly approves
  a redesign.

## Phase 5 — Verify & hand off

- Compare the rebuild against the gap list — every item should be addressed or
  explicitly deferred with a reason.
- Run a11y, performance, and SEO checks.
- Document the stack, how to run it, and the deltas from the original.
- Summarize what changed, what improved versus competitors, and any follow-ups.

## Guardrails

- Only analyze sites the user owns or is authorized to benchmark; respect
  robots.txt and terms of service. Don't scrape gated/private content.
- Never copy a competitor's proprietary assets, copy, or trademarked design —
  benchmark capabilities, build original implementations.
- Distinguish observed facts from inferences in every report.
- Get explicit approval before changing the site's visual identity or before a
  destructive rebuild of existing code.
