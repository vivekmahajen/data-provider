// Serving layer for the canonical provider database built by the pipeline.
// This is the "offer data to others" surface: key-protected endpoints that
// query the deduped/verified contacts in app/data/provider.db and return ONLY
// resale-safe data (resale_ok + verified + not suppressed) unless an internal
// caller explicitly opts out of that filter.
//
// Mounted by server/index.js. Reuses the pipeline's DB layer so what you
// ingest is exactly what you serve.

import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { open, all, get } from '../pipeline/lib/db.js';
import { suppress } from '../pipeline/lib/compliance.js';
import { ingest } from '../pipeline/lib/pipeline.js';
import { CSVConnector } from '../pipeline/connectors/csv.js';
import { getCustomerByKey, charge, usageSummary, createCustomer, PRICES } from './billing.js';
import { createCheckout, completeCheckout, handleStripeWebhook, provider, CREDIT_PACKS, PLAN_PRICES } from './payments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ensure the provider DB exists and has data so the endpoints are live out of
// the box. If empty, ingest the sample dataset once (first-party, resale-safe).
export async function bootstrapProviderDB() {
  open();
  const count = get('SELECT COUNT(*) n FROM people').n;
  if (count === 0) {
    const sample = resolve(__dirname, '../pipeline/data/sample-leads.csv');
    if (existsSync(sample)) {
      const conn = new CSVConnector(sample, { type: 'first_party', resaleAllowed: true });
      await ingest(conn.records(), conn.source, { enrich: false });
    }
  }
}

// Build the contact-point sub-query. Resale-safe by default.
function contactPointsFor(personId, { resaleOnly }) {
  const safe = `resale_ok = 1 AND status IN ('valid','catch_all') AND value NOT IN (SELECT value FROM suppressions)`;
  return all(
    `SELECT kind, value, status, confidence FROM contact_points
      WHERE person_id = :pid ${resaleOnly ? 'AND ' + safe : ''}
      ORDER BY confidence DESC`,
    { pid: personId }
  );
}

// Identify the calling customer by API key (billing + auth in one).
function requireCustomer(req, res, next) {
  const key = req.header('x-api-key') || (req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  const customer = getCustomerByKey(key);
  if (!customer) return res.status(401).json({ error: 'invalid_api_key' });
  req.customer = customer;
  next();
}

function maskValue(kind, value) {
  if (kind === 'email') {
    const [u, d] = String(value).split('@');
    return (u || '').slice(0, 2) + '•••@' + (d || '');
  }
  return '••• ••• ' + String(value).slice(-2);
}

export function providerRouter() {
  const r = express.Router();

  // Stripe webhook — must be BEFORE requireCustomer (Stripe has no API key) and
  // uses the raw body captured by express.json's verify hook (see index.js).
  r.post('/billing/webhook', (req, res) => {
    const out = handleStripeWebhook(req.rawBody || Buffer.from(JSON.stringify(req.body || {})), req.header('stripe-signature'));
    res.status(out.ok ? 200 : (out.status || 400)).json(out);
  });

  r.use(requireCustomer); // every other Data API route is authenticated + billable

  // GET /api/v1/people/search — filterable directory query.
  // Delivering real values costs PRICES.record per contact; ?preview=true masks
  // values and is free.
  r.get('/people/search', (req, res) => {
    const { q, title, industry, location, domain, region, minConfidence } = req.query;
    const resaleOnly = req.query.resaleOnly !== 'false';
    const limit = Math.min(Number(req.query.limit) || 25, 200);
    const offset = Number(req.query.offset) || 0;

    const where = [];
    const params = {};
    if (q) { where.push(`(p.full_name LIKE :q OR c.name LIKE :q OR p.title LIKE :q)`); params.q = `%${q}%`; }
    if (title) { where.push(`p.title LIKE :title`); params.title = `%${title}%`; }
    if (industry) { where.push(`c.industry = :industry`); params.industry = industry; }
    if (location) { where.push(`p.location LIKE :location`); params.location = `%${location}%`; }
    if (domain) { where.push(`c.domain = :domain`); params.domain = String(domain).toLowerCase(); }
    if (region) { where.push(`p.region = :region`); params.region = String(region).toUpperCase(); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = get(
      `SELECT COUNT(*) n FROM people p LEFT JOIN companies c ON c.id = p.company_id ${clause}`, params
    ).n;
    const rows = all(
      `SELECT p.id, p.full_name, p.title, p.location, p.region,
              c.name AS company, c.domain, c.industry, c.size
         FROM people p LEFT JOIN companies c ON c.id = p.company_id
         ${clause}
         ORDER BY p.full_name LIMIT :limit OFFSET :offset`,
      { ...params, limit, offset }
    );
    const minConf = Number(minConfidence) || 0;
    const preview = req.query.preview === 'true';
    const items = rows.map((p) => ({
      ...p,
      contacts: contactPointsFor(p.id, { resaleOnly }).filter((cp) => cp.confidence >= minConf),
    }));

    // meter: one credit per delivered contact value (free when previewing masked)
    const deliverable = items.reduce((n, it) => n + it.contacts.length, 0);
    const units = preview ? 0 : deliverable * PRICES.record;
    const bill = charge(req.customer, 'people/search', units, { results: items.length, delivered: deliverable });
    if (!bill.ok) return res.status(402).json({ error: 'insufficient_credits', needed: bill.needed, remaining: bill.remaining });
    if (preview) items.forEach((it) => it.contacts.forEach((cp) => { cp.value = maskValue(cp.kind, cp.value); cp.preview = true; }));

    res.set('X-Credits-Charged', String(bill.charged || 0));
    res.set('X-Credits-Remaining', String(bill.remaining));
    res.json({ total, limit, offset, resaleOnly, preview, creditsCharged: bill.charged || 0, creditsRemaining: bill.remaining, items });
  });

  // GET /api/v1/people/:id — single canonical record with provenance.
  r.get('/people/:id', (req, res) => {
    const resaleOnly = req.query.resaleOnly !== 'false';
    const p = get(
      `SELECT p.*, c.name AS company, c.domain, c.industry, c.size
         FROM people p LEFT JOIN companies c ON c.id = p.company_id WHERE p.id = :id`,
      { id: req.params.id }
    );
    if (!p) return res.status(404).json({ error: 'not_found' });
    const contacts = contactPointsFor(p.id, { resaleOnly });
    const preview = req.query.preview === 'true';
    const bill = charge(req.customer, 'people/get', preview ? 0 : contacts.length * PRICES.record, { personId: p.id });
    if (!bill.ok) return res.status(402).json({ error: 'insufficient_credits', needed: bill.needed, remaining: bill.remaining });
    if (preview) contacts.forEach((cp) => { cp.value = maskValue(cp.kind, cp.value); cp.preview = true; });
    const provenance = all(
      `SELECT pr.field, pr.value, s.name AS source, s.type, pr.observed_at
         FROM provenance pr JOIN sources s ON s.id = pr.source_id
        WHERE pr.entity_type = 'person' AND pr.entity_id = :id
        ORDER BY pr.observed_at`,
      { id: p.id }
    );
    res.set('X-Credits-Charged', String(bill.charged || 0));
    res.set('X-Credits-Remaining', String(bill.remaining));
    res.json({ ...p, contacts, provenance, creditsCharged: bill.charged || 0, creditsRemaining: bill.remaining });
  });

  // GET /api/v1/export.csv — bulk resale-safe export.
  r.get('/export.csv', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 1000, 50000);
    const rows = all(
      `SELECT cp.kind, cp.value, cp.status, cp.confidence, p.full_name, p.title, c.name AS company, c.domain
         FROM contact_points cp
         JOIN people p ON p.id = cp.person_id
         LEFT JOIN companies c ON c.id = p.company_id
        WHERE cp.resale_ok = 1 AND cp.status IN ('valid','catch_all')
          AND cp.value NOT IN (SELECT value FROM suppressions)
        ORDER BY cp.confidence DESC LIMIT :limit`,
      { limit }
    );
    // meter the full export up front; reject (don't partially bill) if short
    const bill = charge(req.customer, 'export.csv', rows.length * PRICES.record, { rows: rows.length });
    if (!bill.ok) return res.status(402).json({ error: 'insufficient_credits', needed: bill.needed, remaining: bill.remaining });
    res.setHeader('content-type', 'text/csv');
    res.set('X-Credits-Charged', String(bill.charged || 0));
    res.set('X-Credits-Remaining', String(bill.remaining));
    res.write('kind,value,status,confidence,full_name,title,company,domain\n');
    for (const r2 of rows) {
      res.write([r2.kind, r2.value, r2.status, r2.confidence, csv(r2.full_name), csv(r2.title), csv(r2.company), r2.domain].join(',') + '\n');
    }
    res.end();
  });

  // GET /api/v1/stats — dataset coverage.
  r.get('/stats', (req, res) => {
    res.json({
      companies: get('SELECT COUNT(*) n FROM companies').n,
      people: get('SELECT COUNT(*) n FROM people').n,
      contacts: get('SELECT COUNT(*) n FROM contact_points').n,
      resaleSafe: get(`SELECT COUNT(*) n FROM contact_points WHERE resale_ok = 1 AND status IN ('valid','catch_all')`).n,
      suppressed: get('SELECT COUNT(*) n FROM suppressions').n,
    });
  });

  // POST /api/v1/suppress — honor an opt-out / DSAR over the API.
  r.post('/suppress', (req, res) => {
    const { value, reason } = req.body || {};
    if (!value) return res.status(400).json({ error: 'value required' });
    suppress(value, reason || 'opt_out');
    res.json({ suppressed: String(value).toLowerCase(), reason: reason || 'opt_out' });
  });

  // GET /api/v1/billing/usage — the caller's plan, balance and usage ledger.
  r.get('/billing/usage', (req, res) => res.json(usageSummary(req.customer)));

  // POST /api/v1/billing/customers — provision a new customer + key (admin only).
  r.post('/billing/customers', (req, res) => {
    if (!req.customer.is_admin) return res.status(403).json({ error: 'admin_key_required' });
    try {
      const c = createCustomer({ name: req.body?.name, plan: req.body?.plan || 'free' });
      res.json({ id: c.id, name: c.name, apiKey: c.api_key, plan: c.plan, creditsIncluded: c.credits_included });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // GET /api/v1/billing/catalog — buyable credit packs & plan prices.
  r.get('/billing/catalog', (req, res) => res.json({ provider: provider(), creditPacks: CREDIT_PACKS, planPrices: PLAN_PRICES }));

  // POST /api/v1/billing/checkout — start a purchase (credit pack or plan).
  r.post('/billing/checkout', async (req, res) => {
    try {
      const out = await createCheckout(req.customer, {
        kind: req.body?.kind, target: req.body?.target,
        successUrl: req.body?.successUrl, cancelUrl: req.body?.cancelUrl,
      });
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST /api/v1/billing/checkout/:id/complete — simulated-mode payment success.
  // (In Stripe mode, completion arrives via the webhook instead.)
  r.post('/billing/checkout/:id/complete', (req, res) => {
    const out = completeCheckout(req.params.id);
    res.status(out.ok ? 200 : 400).json(out);
  });

  return r;
}

function csv(s) {
  if (s == null) return '';
  const v = String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
