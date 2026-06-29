// Web-scraping connector (scaffold) — YOU complete the marked TODOs.
//
// The framework gives you everything downstream (normalize → dedup → verify →
// score → compliance gate → store). Your job is just: fetch pages politely, and
// turn each page into record objects. The reusable, easy-to-get-wrong parts
// (robots.txt, rate-limiting, fetch) are done for you below.
//
// COMPLIANCE (read before scraping anything):
//  - type 'public_web' + resaleAllowed:false → scraped values are usable for
//    your own outreach/verification but are NEVER resold (export excludes them).
//  - Respect each site's robots.txt AND Terms of Service. robotsAllows() covers
//    robots.txt; ToS is on you.
//  - Rate-limit (politeDelayMs) and identify yourself (userAgent).
//  - Don't scrape gated/private/logged-in content.

import { Connector } from './base.js';

export class WebScrapeConnector extends Connector {
  /**
   * @param {string[]} seedUrls  pages to scrape
   * @param {{politeDelayMs?:number, userAgent?:string, respectRobots?:boolean}} [opts]
   */
  constructor(seedUrls = [], opts = {}) {
    super({
      name: opts.name || 'web-scrape',
      type: 'public_web',
      license: 'scraped public web — NOT resellable',
      resaleAllowed: false, // do not flip this on for scraped data
    });
    this.seedUrls = seedUrls;
    this.politeDelayMs = opts.politeDelayMs ?? 2000; // be a good citizen
    this.userAgent = opts.userAgent || 'MyDataPipelineBot/1.0 (+contact@example.com)';
    this.respectRobots = opts.respectRobots !== false;
    this._robotsCache = new Map(); // origin -> disallowed path prefixes
  }

  // ---- the one method you write ------------------------------------------
  // Turn a fetched page into an array of record objects. Understood keys:
  //   fullName/firstName/lastName, company, domain, title, location, email,
  //   phone, linkedinUrl. Return [] if a page has nothing.
  //
  // The example below extracts schema.org JSON-LD (Person/Organization) and
  // mailto: links — a robust, ToS-friendlier starting point. Replace/extend it
  // with selectors for YOUR target site.
  extract(html, url) {
    const records = [];

    // 1) schema.org JSON-LD blocks
    for (const block of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const data = JSON.parse(block[1].trim());
        for (const node of Array.isArray(data) ? data : [data]) {
          if (node['@type'] === 'Person') {
            records.push({
              fullName: node.name,
              title: node.jobTitle,
              company: node.worksFor?.name,
              email: cleanMailto(node.email),
              linkedinUrl: (node.sameAs || []).find((u) => /linkedin\.com/i.test(u)),
            });
          }
        }
      } catch { /* not valid JSON-LD, skip */ }
    }

    // 2) mailto: links as a fallback signal
    for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
      records.push({ email: cleanMailto(m[1]), domain: new URL(url).hostname.replace(/^www\./, '') });
    }

    // TODO(you): add CSS/regex extraction tailored to your target's markup,
    // e.g. team/directory pages: name, title, company per card.
    return records.filter((r) => r.fullName || r.email);
  }

  // ---- reusable plumbing (you usually don't need to touch this) -----------
  async *records() {
    for (const url of this.seedUrls) {
      if (this.respectRobots && !(await this.robotsAllows(url))) {
        // skip disallowed paths rather than scraping them
        continue;
      }
      const html = await this.fetchHtml(url);
      if (!html) continue;
      for (const rec of this.extract(html, url)) yield rec;
      await sleep(this.politeDelayMs);
    }
  }

  async fetchHtml(url) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': this.userAgent, accept: 'text/html' } });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null; // network/transport failure → skip this page
    }
  }

  // Minimal robots.txt check: fetch once per origin, honor Disallow under * .
  async robotsAllows(url) {
    const u = new URL(url);
    if (!this._robotsCache.has(u.origin)) {
      let disallow = [];
      try {
        const res = await fetch(`${u.origin}/robots.txt`, { headers: { 'user-agent': this.userAgent } });
        if (res.ok) disallow = parseDisallow(await res.text());
      } catch { /* no robots.txt → allow */ }
      this._robotsCache.set(u.origin, disallow);
    }
    const blocked = this._robotsCache.get(u.origin);
    return !blocked.some((prefix) => u.pathname.startsWith(prefix));
  }
}

function cleanMailto(s) { return s ? String(s).replace(/^mailto:/i, '').trim() : undefined; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Parse the `User-agent: *` group's Disallow rules (good enough to be polite).
function parseDisallow(txt) {
  const lines = txt.split('\n').map((l) => l.replace(/#.*$/, '').trim());
  const out = [];
  let active = false;
  for (const line of lines) {
    const [k, ...rest] = line.split(':');
    const key = (k || '').toLowerCase();
    const val = rest.join(':').trim();
    if (key === 'user-agent') active = val === '*';
    else if (active && key === 'disallow' && val) out.push(val);
  }
  return out;
}
