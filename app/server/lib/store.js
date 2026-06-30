// In-memory data store with JSON persistence. Holds the searchable contact
// database, the account/credit ledger, enrichment jobs, sequences, workflows,
// call logs and analytics events. Persisted to app/data/db.json between runs.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hashString, id, pick, slug, domainFromCompany, nextTs } from './util.js';

export { nextTs };

const __dirname = dirname(fileURLToPath(import.meta.url));
// Writable location: serverless platforms (Vercel) only allow writes to /tmp.
const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? resolve(tmpdir(), 'fe-data') : resolve(__dirname, '../../data'));
const DB_PATH = resolve(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  account: {
    plan: 'Pro',
    creditsTotal: 1000,
    creditsUsed: 0,
    creditsRolloverFrom: 0,
    // Admin/Data-API key. Override in production with ADMIN_API_KEY so it isn't
    // the public demo value.
    apiKey: process.env.ADMIN_API_KEY || 'fe_live_demo_0000000000',
  },
  contacts: [], // searchable B2B database
  jobs: [], // enrichment jobs (single + bulk)
  sequences: [],
  workflows: [],
  calls: [],
  events: [], // analytics events
};

let db = null;

function load() {
  if (db) return db;
  if (existsSync(DB_PATH)) {
    try {
      db = JSON.parse(readFileSync(DB_PATH, 'utf8'));
      // shallow-merge defaults for forward-compat
      db = { ...structuredClone(DEFAULT_DB), ...db };
    } catch {
      db = structuredClone(DEFAULT_DB);
    }
  } else {
    db = structuredClone(DEFAULT_DB);
  }
  if (!db.contacts.length) db.contacts = generateContacts();
  return db;
}

export function save() {
  // Best-effort: on a read-only serverless FS this may fail; the JSON store is
  // demo state (the real product data lives in the pipeline DB / Postgres), so
  // we don't crash the request if persistence isn't available.
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch { /* ignore on read-only / ephemeral FS */ }
}

export function getDB() {
  return load();
}

// ---- Account / credits -----------------------------------------------------

export function creditsRemaining() {
  const a = load().account;
  return a.creditsTotal + a.creditsRolloverFrom - a.creditsUsed;
}

export function chargeCredits(n) {
  const a = load().account;
  if (n <= 0) return true;
  if (creditsRemaining() < n) return false;
  a.creditsUsed += n;
  return true;
}

// ---- Analytics -------------------------------------------------------------

export function logEvent(type, payload = {}) {
  const d = load();
  d.events.push({ id: id('evt'), type, ts: nextTs(), ...payload });
  if (d.events.length > 5000) d.events.shift();
}

// ---- Searchable contact database (seed) ------------------------------------

const FIRST = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Sam', 'Jamie', 'Avery', 'Quinn', 'Drew', 'Parker', 'Reese', 'Skyler', 'Cameron', 'Devon', 'Emerson', 'Finley', 'Harper', 'Kendall'];
const LAST = ['Nguyen', 'Patel', 'Garcia', 'Smith', 'Kim', 'Johnson', 'Martinez', 'Lee', 'Brown', 'Singh', 'Dubois', 'Rossi', 'Müller', 'Silva', 'Andersson', 'Ivanov', 'Costa', 'Wang', 'Okafor', 'Hassan'];
const COMPANIES = ['Northstar Labs', 'Brightwave', 'Quanta Systems', 'Lumen GTM', 'Cedar Analytics', 'Volt Commerce', 'Atlas Health', 'Pioneer Logistics', 'Vertex Security', 'Harbor Fintech', 'Nimbus Cloud', 'Forge Robotics', 'Meadow Foods', 'Orbit Media', 'Summit Energy', 'Echo Mobility'];
const TITLES = ['SDR', 'Account Executive', 'Head of Sales', 'VP Sales', 'RevOps Manager', 'Marketing Manager', 'Growth Lead', 'Founder', 'CEO', 'CTO', 'Demand Gen Lead', 'Sales Operations'];
const INDUSTRIES = ['SaaS', 'Fintech', 'E-commerce', 'Healthtech', 'Logistics', 'Cybersecurity'];
const LOCATIONS = ['San Francisco, US', 'New York, US', 'London, UK', 'Paris, FR', 'Berlin, DE', 'Toronto, CA', 'Singapore, SG', 'Sydney, AU', 'Austin, US', 'Amsterdam, NL'];

function generateContacts(n = 240) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = 'c' + i;
    const first = pick(FIRST, 'f' + s);
    const last = pick(LAST, 'l' + s + i);
    const company = pick(COMPANIES, 'co' + s + i);
    const title = pick(TITLES, 't' + s + i);
    const industry = pick(INDUSTRIES, 'in' + s + company);
    const location = pick(LOCATIONS, 'loc' + s + i);
    const domain = domainFromCompany(company);
    const size = 20 + (hashString('sz' + company) % 4980);
    out.push({
      id: id('ct'),
      fullName: `${first} ${last}`,
      firstName: first,
      lastName: last,
      title,
      company,
      domain,
      industry,
      location,
      employees: size,
      linkedinUrl: `https://www.linkedin.com/in/${slug(first + last)}${i}`,
      // contact details are intentionally hidden until enriched
      email: null,
      phone: null,
    });
  }
  return out;
}

export function searchContacts(filters = {}, page = 1, pageSize = 20) {
  const d = load();
  const q = (filters.q || '').toLowerCase();
  let rows = d.contacts.filter((c) => {
    if (q && !`${c.fullName} ${c.company} ${c.title}`.toLowerCase().includes(q)) return false;
    if (filters.title && !c.title.toLowerCase().includes(filters.title.toLowerCase())) return false;
    if (filters.industry && c.industry !== filters.industry) return false;
    if (filters.location && !c.location.toLowerCase().includes(filters.location.toLowerCase())) return false;
    if (filters.minEmployees && c.employees < Number(filters.minEmployees)) return false;
    if (filters.maxEmployees && c.employees > Number(filters.maxEmployees)) return false;
    return true;
  });
  const total = rows.length;
  const start = (page - 1) * pageSize;
  const items = rows.slice(start, start + pageSize).map((c) => ({
    ...c,
    // mask details in search results — enrichment reveals them
    emailMasked: c.email ? maskEmail(c.email) : '•••••@' + c.domain,
    phoneMasked: c.phone ? '••• ••• ••' + c.phone.slice(-2) : '••• ••• ••••',
  }));
  return { total, page, pageSize, items, facets: facets(d.contacts) };
}

function facets(contacts) {
  const by = (key) => {
    const m = {};
    for (const c of contacts) m[c[key]] = (m[c[key]] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ value: k, count: v }));
  };
  return { industry: by('industry'), title: by('title'), location: by('location') };
}

function maskEmail(e) {
  const [u, d] = e.split('@');
  return u.slice(0, 2) + '•••@' + d;
}

export function getContact(cid) {
  return load().contacts.find((c) => c.id === cid) || null;
}
