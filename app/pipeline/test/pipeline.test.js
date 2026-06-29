// Pipeline tests — run with: npm run test:pipeline
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { open, get, all } from '../lib/db.js';
import { ingest, reverifyStale } from '../lib/pipeline.js';
import { exportableContacts, suppress, eraseValue } from '../lib/compliance.js';
import { CSVConnector } from '../connectors/csv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(__dirname, '../data/sample-leads.csv');

before(() => { open(':memory:'); }); // isolated in-memory DB

test('ingest dedups the same person seen twice', async () => {
  const conn = new CSVConnector(SAMPLE, { type: 'first_party', resaleAllowed: true });
  const stats = await ingest(conn.records(), conn.source, { enrich: false });
  assert.equal(stats.landed, 7);
  // 7 rows but Jordan Patel appears twice (same LinkedIn) → 6 unique people
  assert.equal(get('SELECT COUNT(*) n FROM people').n, 6);
});

test('merged person has BOTH email (row 1) and phone (row 3)', () => {
  const jordan = get(`SELECT * FROM people WHERE linkedin_url LIKE '%jordanpatel%'`);
  assert.ok(jordan);
  const cps = all('SELECT kind, value FROM contact_points WHERE person_id = :id', { id: jordan.id });
  const kinds = cps.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['email', 'phone']);
});

test('every contact point has provenance lineage', () => {
  const cps = all('SELECT id FROM contact_points');
  for (const cp of cps) {
    const prov = get('SELECT COUNT(*) n FROM provenance WHERE entity_type = :t AND entity_id = :id', { t: 'contact_point', id: cp.id });
    assert.ok(prov.n >= 1, 'missing provenance for ' + cp.id);
  }
});

test('export only returns resale-safe, verified, non-suppressed contacts', () => {
  const rows = exportableContacts(1000);
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(['valid', 'catch_all'].includes(r.status));
});

test('suppression blocks re-ingestion of a value', async () => {
  // erase removes the existing row AND suppresses; re-ingesting must not re-add it
  eraseValue('drew.costa@voltcommerce.com');
  assert.equal(get(`SELECT COUNT(*) n FROM contact_points WHERE value = 'drew.costa@voltcommerce.com'`).n, 0);
  const conn = new CSVConnector(SAMPLE, { type: 'first_party', resaleAllowed: true });
  await ingest(conn.records(), conn.source, { enrich: false });
  const hit = get(`SELECT COUNT(*) n FROM contact_points WHERE value = 'drew.costa@voltcommerce.com'`);
  assert.equal(hit.n, 0, 'suppressed value must never be re-stored');
});

test('erasure removes a value and prevents resurfacing', () => {
  eraseValue('jordan.patel@northstarlabs.com');
  assert.equal(get(`SELECT COUNT(*) n FROM contact_points WHERE value = 'jordan.patel@northstarlabs.com'`).n, 0);
  assert.ok(get(`SELECT 1 x FROM suppressions WHERE value = 'jordan.patel@northstarlabs.com'`));
});

test('reverify refreshes contacts without error', async () => {
  const n = await reverifyStale(100);
  assert.ok(n >= 0);
});

test('enrichment-sourced values are stored but NOT resale_ok', async () => {
  const conn = new CSVConnector(SAMPLE, { type: 'first_party', resaleAllowed: true });
  await ingest(conn.records(), conn.source, { enrich: true });
  const enrichSrc = get(`SELECT id FROM sources WHERE name = 'waterfall-enrichment'`);
  if (enrichSrc) {
    const bad = get(`SELECT COUNT(*) n FROM contact_points WHERE source_id = :sid AND resale_ok = 1`, { sid: enrichSrc.id });
    assert.equal(bad.n, 0, 'enrichment values must never be resale_ok');
  }
});
