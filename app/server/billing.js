// Billing & metering for the Data API — how you charge customers for the data
// you built. Each API customer has a key, a plan with included credits, and a
// usage ledger. Delivering a real contact record (a PII value) costs credits;
// previews (masked) are free. Backed by the same provider DB as the pipeline.
//
// This is intentionally a usage-metering layer, not a payment processor: wire
// Stripe to `topUp()` / plan changes when you take real money.

import { db, get, all, run, id, now } from '../pipeline/lib/db.js';
import { randomBytes } from 'node:crypto';

// Monthly included credits per plan. Period reset is handled by maybeResetPeriod.
export const PLANS = {
  free: { credits: 100 },
  starter: { credits: 1000 },
  pro: { credits: 10000 },
  scale: { credits: 100000 },
};

// Price list (credits) for metered actions.
export const PRICES = {
  record: 1,   // one delivered contact point (email or phone)
};

const PERIOD_MS = 30 * 86400000;

export function ensureBilling(defaultKey) {
  db().exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      plan TEXT NOT NULL,
      credits_included INTEGER NOT NULL,
      credits_used INTEGER NOT NULL DEFAULT 0,
      period_start INTEGER NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      endpoint TEXT NOT NULL,
      units INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_customer ON usage_events(customer_id, ts);
  `);
  // Seed the admin/demo customer using the app's existing API key so current
  // flows (and the app's "try people search") keep working out of the box.
  if (defaultKey && !get('SELECT 1 x FROM customers WHERE api_key = :k', { k: defaultKey })) {
    run(
      `INSERT INTO customers (id, name, api_key, plan, credits_included, credits_used, period_start, is_admin, created_at)
       VALUES (:id, 'Demo (admin)', :key, 'pro', :credits, 0, :ts, 1, :ts)`,
      { id: id(), key: defaultKey, credits: PLANS.pro.credits, ts: now() }
    );
  }
}

export function getCustomerByKey(key) {
  if (!key) return null;
  const c = get('SELECT * FROM customers WHERE api_key = :k', { k: key });
  if (c) maybeResetPeriod(c);
  return c ? get('SELECT * FROM customers WHERE id = :id', { id: c.id }) : null;
}

function maybeResetPeriod(c) {
  if (now() - c.period_start >= PERIOD_MS) {
    run('UPDATE customers SET credits_used = 0, period_start = :ts WHERE id = :id', { ts: now(), id: c.id });
  }
}

export function remaining(c) {
  return Math.max(0, c.credits_included - c.credits_used);
}

// Check + charge atomically (SQLite is synchronous). Returns
// { ok, charged, remaining } or { ok:false, needed, remaining }.
export function charge(customer, endpoint, units, meta = {}) {
  const cust = get('SELECT * FROM customers WHERE id = :id', { id: customer.id });
  const rem = remaining(cust);
  if (units > 0 && rem < units) {
    return { ok: false, needed: units, remaining: rem };
  }
  if (units > 0) {
    run('UPDATE customers SET credits_used = credits_used + :u WHERE id = :id', { u: units, id: cust.id });
    run(`INSERT INTO usage_events (id, customer_id, endpoint, units, ts, meta) VALUES (:id, :cid, :ep, :u, :ts, :meta)`,
      { id: id(), cid: cust.id, ep: endpoint, u: units, ts: now(), meta: JSON.stringify(meta) });
  }
  return { ok: true, charged: units, remaining: remaining(get('SELECT * FROM customers WHERE id = :id', { id: cust.id })) };
}

export function createCustomer({ name, plan = 'free' }) {
  if (!PLANS[plan]) throw new Error(`unknown plan: ${plan}`);
  const key = 'fe_cust_' + randomBytes(12).toString('hex');
  const cid = id();
  run(
    `INSERT INTO customers (id, name, api_key, plan, credits_included, credits_used, period_start, is_admin, created_at)
     VALUES (:id, :name, :key, :plan, :credits, 0, :ts, 0, :ts)`,
    { id: cid, name: name || 'Customer', key, plan, credits: PLANS[plan].credits, ts: now() }
  );
  return get('SELECT * FROM customers WHERE id = :id', { id: cid });
}

export function usageSummary(customer) {
  const c = get('SELECT * FROM customers WHERE id = :id', { id: customer.id });
  const events = all('SELECT endpoint, units, ts, meta FROM usage_events WHERE customer_id = :id ORDER BY ts DESC LIMIT 25', { id: c.id });
  const byEndpoint = all('SELECT endpoint, SUM(units) units, COUNT(*) calls FROM usage_events WHERE customer_id = :id GROUP BY endpoint', { id: c.id });
  return {
    customer: { name: c.name, plan: c.plan, isAdmin: !!c.is_admin },
    creditsIncluded: c.credits_included,
    creditsUsed: c.credits_used,
    creditsRemaining: remaining(c),
    byEndpoint,
    recent: events.map((e) => ({ ...e, meta: safeParse(e.meta) })),
    prices: PRICES,
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
