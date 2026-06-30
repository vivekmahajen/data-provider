// Billing & metering for the Data API — how you charge customers for the data
// you built. Each API customer has a key, a plan with included credits, and a
// usage ledger. Delivering a real contact record (a PII value) costs credits;
// previews (masked) are free. Tables live in the schema; this module is logic.
//
// This is intentionally a usage-metering layer, not a payment processor: wire
// Stripe to topUp() / plan changes when you take real money (see payments.js).

import { get, all, run, id, now } from '../pipeline/lib/db.js';
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

export async function ensureBilling(defaultKey) {
  // Seed the admin/demo customer using the app's existing API key so current
  // flows (and the app's "try people search") keep working out of the box.
  if (defaultKey && !(await get('SELECT 1 x FROM customers WHERE api_key = :k', { k: defaultKey }))) {
    await run(
      `INSERT INTO customers (id, name, api_key, plan, credits_included, credits_used, period_start, is_admin, created_at)
       VALUES (:id, 'Demo (admin)', :key, 'pro', :credits, 0, :ts, 1, :ts)`,
      { id: id(), key: defaultKey, credits: PLANS.pro.credits, ts: now() }
    );
  }
}

export async function getCustomerByKey(key) {
  if (!key) return null;
  const c = await get('SELECT * FROM customers WHERE api_key = :k', { k: key });
  if (!c) return null;
  await maybeResetPeriod(c);
  return get('SELECT * FROM customers WHERE id = :id', { id: c.id });
}

async function maybeResetPeriod(c) {
  if (now() - c.period_start >= PERIOD_MS) {
    await run('UPDATE customers SET credits_used = 0, period_start = :ts WHERE id = :id', { ts: now(), id: c.id });
  }
}

// Pure: remaining balance for a loaded customer row.
export function remaining(c) {
  return Math.max(0, c.credits_included - c.credits_used);
}

// Check + charge. Returns { ok, charged, remaining } or { ok:false, needed, remaining }.
export async function charge(customer, endpoint, units, meta = {}) {
  const cust = await get('SELECT * FROM customers WHERE id = :id', { id: customer.id });
  const rem = remaining(cust);
  if (units > 0 && rem < units) {
    return { ok: false, needed: units, remaining: rem };
  }
  if (units > 0) {
    await run('UPDATE customers SET credits_used = credits_used + :u WHERE id = :id', { u: units, id: cust.id });
    await run(`INSERT INTO usage_events (id, customer_id, endpoint, units, ts, meta) VALUES (:id, :cid, :ep, :u, :ts, :meta)`,
      { id: id(), cid: cust.id, ep: endpoint, u: units, ts: now(), meta: JSON.stringify(meta) });
  }
  const after = await get('SELECT * FROM customers WHERE id = :id', { id: cust.id });
  return { ok: true, charged: units, remaining: remaining(after) };
}

export async function createCustomer({ name, plan = 'free' }) {
  if (!PLANS[plan]) throw new Error(`unknown plan: ${plan}`);
  const key = 'fe_cust_' + randomBytes(12).toString('hex');
  const cid = id();
  await run(
    `INSERT INTO customers (id, name, api_key, plan, credits_included, credits_used, period_start, is_admin, created_at)
     VALUES (:id, :name, :key, :plan, :credits, 0, :ts, 0, :ts)`,
    { id: cid, name: name || 'Customer', key, plan, credits: PLANS[plan].credits, ts: now() }
  );
  return get('SELECT * FROM customers WHERE id = :id', { id: cid });
}

// Grant purchased credits (called after a successful payment).
export async function topUp(customer, credits, meta = {}) {
  if (credits > 0) {
    await run('UPDATE customers SET credits_included = credits_included + :c WHERE id = :id', { c: credits, id: customer.id });
    await run(`INSERT INTO usage_events (id, customer_id, endpoint, units, ts, meta) VALUES (:id, :cid, 'topup', :u, :ts, :meta)`,
      { id: id(), cid: customer.id, u: -credits, ts: now(), meta: JSON.stringify(meta) });
  }
  return get('SELECT * FROM customers WHERE id = :id', { id: customer.id });
}

// Move a customer to a new plan: set the included allotment and start a fresh period.
export async function changePlan(customer, plan) {
  if (!PLANS[plan]) throw new Error(`unknown plan: ${plan}`);
  await run('UPDATE customers SET plan = :p, credits_included = :c, credits_used = 0, period_start = :ts WHERE id = :id',
    { p: plan, c: PLANS[plan].credits, ts: now(), id: customer.id });
  return get('SELECT * FROM customers WHERE id = :id', { id: customer.id });
}

// Admin: list all customers with balances (for the operator's admin panel).
export async function listCustomers() {
  const rows = await all('SELECT * FROM customers ORDER BY is_admin DESC, created_at ASC');
  return rows.map((c) => ({
    id: c.id, name: c.name, apiKey: c.api_key, plan: c.plan, isAdmin: !!c.is_admin,
    creditsIncluded: c.credits_included, creditsUsed: c.credits_used, creditsRemaining: remaining(c),
  }));
}

export async function usageSummary(customer) {
  const c = await get('SELECT * FROM customers WHERE id = :id', { id: customer.id });
  const events = await all('SELECT endpoint, units, ts, meta FROM usage_events WHERE customer_id = :id ORDER BY ts DESC LIMIT 25', { id: c.id });
  const byEndpoint = await all('SELECT endpoint, SUM(units) units, COUNT(*) calls FROM usage_events WHERE customer_id = :id GROUP BY endpoint', { id: c.id });
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
