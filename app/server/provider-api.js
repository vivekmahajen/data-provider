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

export function providerRouter() {
  const r = express.Router();

  // GET /api/v1/people/search — filterable directory query.
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
    const items = rows.map((p) => ({
      ...p,
      contacts: contactPointsFor(p.id, { resaleOnly }).filter((cp) => cp.confidence >= minConf),
    }));
    res.json({ total, limit, offset, resaleOnly, items });
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
    const provenance = all(
      `SELECT pr.field, pr.value, s.name AS source, s.type, pr.observed_at
         FROM provenance pr JOIN sources s ON s.id = pr.source_id
        WHERE pr.entity_type = 'person' AND pr.entity_id = :id
        ORDER BY pr.observed_at`,
      { id: p.id }
    );
    res.json({ ...p, contacts, provenance });
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
    res.setHeader('content-type', 'text/csv');
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

  return r;
}

function csv(s) {
  if (s == null) return '';
  const v = String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
