// Waterfall enrichment engine — the core capability rebuilt from FullEnrich.
//
// A contact is routed through an ordered cascade of providers. The first
// provider that returns a *verified* result wins; credits are only charged on
// success (email = 1 credit, mobile phone = 10 credits — matching FullEnrich's
// model). Results are deterministic per input so the demo is reproducible.
//
// NOTE: providers here are simulated (no real third-party API keys in this
// environment). Each "provider" models a real one's typical hit-rate/latency so
// the waterfall logic, credit accounting and analytics are genuinely exercised.

import { hashString, seededUnit, pick, slug, domainFromCompany } from './util.js';

// Ordered cascade. `emailRate` / `phoneRate` are the simulated per-provider hit
// rates; the cascade stops as soon as a verified value is found.
export const PROVIDERS = [
  { id: 'dropcontact', name: 'Dropcontact', emailRate: 0.55, phoneRate: 0.0 },
  { id: 'prospeo', name: 'Prospeo', emailRate: 0.45, phoneRate: 0.2 },
  { id: 'hunter', name: 'Hunter', emailRate: 0.4, phoneRate: 0.0 },
  { id: 'apollo', name: 'Apollo', emailRate: 0.5, phoneRate: 0.35 },
  { id: 'rocketreach', name: 'RocketReach', emailRate: 0.35, phoneRate: 0.4 },
  { id: 'contactout', name: 'ContactOut', emailRate: 0.3, phoneRate: 0.45 },
  { id: 'datagma', name: 'Datagma', emailRate: 0.25, phoneRate: 0.5 },
  { id: 'peopledatalabs', name: 'People Data Labs', emailRate: 0.3, phoneRate: 0.3 },
];

export const EMAIL_CREDIT_COST = 1;
export const PHONE_CREDIT_COST = 10;

function buildEmail(name, domain, pattern) {
  const [first = '', last = ''] = String(name).toLowerCase().split(/\s+/);
  const f = slug(first);
  const l = slug(last);
  if (!f || !domain) return null;
  switch (pattern) {
    case 'first.last': return `${f}.${l}@${domain}`;
    case 'flast': return `${f[0]}${l}@${domain}`;
    case 'first': return `${f}@${domain}`;
    case 'firstl': return `${f}${l[0] || ''}@${domain}`;
    default: return `${f}.${l}@${domain}`;
  }
}

function buildPhone(seed) {
  const n = hashString('phone' + seed);
  const area = 200 + (n % 800);
  const mid = 100 + ((n >> 4) % 900);
  const last = 1000 + ((n >> 8) % 9000);
  return `+1 (${area}) ${mid}-${last}`;
}

// Email verification — simulates the "triple verifier" (3 checks). Returns a
// status: valid | catch_all | risky. Catch-all emails are partially recovered,
// mirroring FullEnrich's "verify up to 80% of catch-alls" claim.
function verifyEmail(email, seed) {
  const u = seededUnit('verify' + seed + email);
  if (u < 0.78) return { status: 'valid', confidence: Math.round(85 + u * 14) };
  if (u < 0.92) return { status: 'catch_all', confidence: Math.round(55 + u * 20) };
  return { status: 'risky', confidence: Math.round(30 + u * 20) };
}

/**
 * Run the waterfall for a single contact.
 * @param {{fullName?:string,firstName?:string,lastName?:string,company?:string,domain?:string,linkedinUrl?:string}} input
 * @param {{wantEmail?:boolean, wantPhone?:boolean}} opts
 */
export function enrichContact(input = {}, opts = {}) {
  const wantEmail = opts.wantEmail !== false;
  const wantPhone = opts.wantPhone !== false;

  const fullName =
    input.fullName ||
    [input.firstName, input.lastName].filter(Boolean).join(' ') ||
    '';
  const company = input.company || '';
  const domain = (input.domain || domainFromCompany(company) || '').toLowerCase();
  const seed = `${slug(fullName)}|${domain}|${input.linkedinUrl || ''}`;

  const trace = []; // per-provider attempt log for transparency / analytics
  let email = null;
  let emailProvider = null;
  let emailVerification = null;
  let phone = null;
  let phoneProvider = null;

  for (const p of PROVIDERS) {
    const attempt = { provider: p.id, name: p.name, email: false, phone: false };

    if (wantEmail && !email && fullName && domain) {
      const u = seededUnit(`${p.id}:email:${seed}`);
      if (u < p.emailRate) {
        const pattern = pick(['first.last', 'flast', 'first', 'firstl'], 'pat' + seed);
        const candidate = buildEmail(fullName, domain, pattern);
        const v = candidate ? verifyEmail(candidate, seed) : null;
        if (candidate && v && v.status !== 'risky') {
          email = candidate;
          emailProvider = p.id;
          emailVerification = v;
          attempt.email = true;
        }
      }
    }

    if (wantPhone && !phone && fullName) {
      const u = seededUnit(`${p.id}:phone:${seed}`);
      if (u < p.phoneRate) {
        phone = buildPhone(seed);
        phoneProvider = p.id;
        attempt.phone = true;
      }
    }

    trace.push(attempt);
    if ((!wantEmail || email) && (!wantPhone || phone)) break;
  }

  const creditsUsed =
    (email ? EMAIL_CREDIT_COST : 0) + (phone ? PHONE_CREDIT_COST : 0);

  return {
    input: { fullName, company, domain, linkedinUrl: input.linkedinUrl || null },
    email,
    emailProvider,
    emailVerification,
    phone,
    phoneProvider,
    status: email || phone ? 'enriched' : 'not_found',
    creditsUsed,
    providersTried: trace.length,
    trace,
  };
}
