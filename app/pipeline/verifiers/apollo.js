// Real verifier backed by Apollo's People Enrichment (match) REST API.
//
// Why REST and not the Apollo MCP? The pipeline/server run as plain Node; MCP
// tools are only callable inside the Claude agent runtime. The production path
// therefore calls https://api.apollo.io directly with an API key.
//
// Enable by setting APOLLO_API_KEY (and optionally VERIFIER=apollo). Each match
// costs 1 Apollo credit on success, 0 if not found — so we cache per person to
// avoid paying twice when verifying both a person's email and phone.
//
// NOTE: Apollo's people/match API requires a PAID Apollo plan; on a free plan it
// returns API_INACCESSIBLE. This verifier handles any non-OK response by
// returning { status: 'unverified', confidence: 40 } so the pipeline degrades
// gracefully rather than failing the ingest.
//
// We use Apollo only to VERIFY: we read email_status / phone presence and map
// them to our verdict. We deliberately do NOT import Apollo's email/phone as new
// resellable values here (see base.js).

import { Verifier } from './base.js';

const DEFAULT_MATCH_URL = 'https://api.apollo.io/api/v1/people/match';

// Apollo's email_status → our verdict.
function mapEmailStatus(status) {
  switch ((status || '').toLowerCase()) {
    case 'verified': return { status: 'valid', confidence: 95 };
    case 'extrapolated':
    case 'guessed': return { status: 'catch_all', confidence: 60 };
    case 'unavailable':
    case 'pending_manual_fulfillment': return { status: 'unverified', confidence: 40 };
    case 'bounced':
    case 'invalid': return { status: 'invalid', confidence: 5 };
    default: return { status: 'unverified', confidence: 40 };
  }
}

export class ApolloVerifier extends Verifier {
  name = 'apollo';

  constructor(apiKey = process.env.APOLLO_API_KEY) {
    super();
    if (!apiKey) throw new Error('ApolloVerifier requires APOLLO_API_KEY');
    this.apiKey = apiKey;
    // resolved at construction so tests/config can point at a stub via APOLLO_BASE_URL
    this.matchUrl = process.env.APOLLO_BASE_URL || DEFAULT_MATCH_URL;
    this._cache = new Map(); // ctxKey -> person (or null)
  }

  _ctxKey(ctx = {}) {
    return [ctx.linkedinUrl, ctx.fullName, ctx.domain, ctx.company].map((s) => (s || '').toLowerCase()).join('|');
  }

  async _match(ctx = {}) {
    const key = this._ctxKey(ctx);
    if (this._cache.has(key)) return this._cache.get(key);

    const body = {
      first_name: ctx.firstName || undefined,
      last_name: ctx.lastName || undefined,
      name: !ctx.firstName && ctx.fullName ? ctx.fullName : undefined,
      organization_name: ctx.company || undefined,
      domain: ctx.domain || undefined,
      linkedin_url: ctx.linkedinUrl || undefined,
    };
    let person = null;
    try {
      const res = await fetch(this.matchUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        person = data.person || null;
      }
    } catch {
      person = null; // network/transport failure → treat as no match
    }
    this._cache.set(key, person);
    return person;
  }

  async verify(kind, value, ctx = {}) {
    const person = await this._match(ctx);
    if (!person) return { status: 'unverified', confidence: 40 };

    if (kind === 'email') {
      const verdict = mapEmailStatus(person.email_status);
      const apolloEmail = (person.email || '').toLowerCase();
      // If Apollo's verified email matches the value we hold, full confidence;
      // if Apollo holds a DIFFERENT email, our value is suspect → cap it.
      if (apolloEmail && value && apolloEmail === value.toLowerCase()) return verdict;
      if (apolloEmail) return { status: verdict.status === 'valid' ? 'risky' : verdict.status, confidence: Math.min(verdict.confidence, 45) };
      return { status: 'unverified', confidence: 40 };
    }

    // phone: Apollo returns phone_numbers[] (and/or sanitized_phone)
    const phones = person.phone_numbers || (person.sanitized_phone ? [{ sanitized_number: person.sanitized_phone }] : []);
    return phones.length ? { status: 'valid', confidence: 80 } : { status: 'risky', confidence: 40 };
  }
}
