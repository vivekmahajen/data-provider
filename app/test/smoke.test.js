// Smoke tests for the enrichment engine, workflow runner and sequence engine.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enrichContact, EMAIL_CREDIT_COST, PHONE_CREDIT_COST } from '../server/lib/enrichment.js';
import { newWorkflow, addColumn, runWorkflow } from '../server/lib/workflows.js';
import { newSequence, enroll, advance, placeCall } from '../server/lib/sequences.js';
import { aiResearch } from '../server/lib/airesearch.js';
import { parseCSV, domainFromCompany } from '../server/lib/util.js';

test('enrichment is deterministic for the same input', () => {
  const a = enrichContact({ fullName: 'Jordan Patel', company: 'Northstar Labs' });
  const b = enrichContact({ fullName: 'Jordan Patel', company: 'Northstar Labs' });
  assert.deepEqual(a.email, b.email);
  assert.deepEqual(a.phone, b.phone);
});

test('credit cost matches what was found', () => {
  const r = enrichContact({ fullName: 'Casey Nguyen', company: 'Brightwave', domain: 'brightwave.com' });
  const expected = (r.email ? EMAIL_CREDIT_COST : 0) + (r.phone ? PHONE_CREDIT_COST : 0);
  assert.equal(r.creditsUsed, expected);
});

test('email-only request never returns a phone or phone credits', () => {
  const r = enrichContact({ fullName: 'Morgan Garcia', company: 'Quanta Systems' }, { wantEmail: true, wantPhone: false });
  assert.equal(r.phone, null);
  assert.ok(r.creditsUsed <= EMAIL_CREDIT_COST);
});

test('domain derived from company', () => {
  assert.equal(domainFromCompany('Northstar Labs'), 'northstarlabs.com');
});

test('CSV parser handles quoted commas', () => {
  const rows = parseCSV('fullName,company\n"Patel, Jordan","North, Inc"\nCasey,Bright');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fullname, 'Patel, Jordan');
  assert.equal(rows[0].company, 'North, Inc');
});

test('workflow runs all columns over all rows', async () => {
  const wf = newWorkflow('t', [{ fullName: 'Riley Kim', company: 'Lumen GTM' }]);
  addColumn(wf, { key: 'domain', type: 'find_domain' });
  addColumn(wf, { key: 'email', type: 'enrich_email' });
  addColumn(wf, { key: 'ai', type: 'ai_research', config: { question: 'ICP fit?' } });
  await runWorkflow(wf);
  assert.equal(wf.rows[0]._cells.domain, 'lumengtm.com');
  assert.ok('ai' in wf.rows[0]._cells);
  assert.ok(wf.lastRun.rows === 1);
});

test('sequence enroll + advance produces a schedule and sends', () => {
  const seq = newSequence('t');
  enroll(seq, { id: 'x', fullName: 'Avery Singh', firstName: 'Avery', company: 'Cedar', email: 'a@cedar.com' });
  assert.equal(seq.enrollments.length, 1);
  assert.ok(seq.enrollments[0].schedule.length >= 3);
  const r = advance(seq);
  assert.ok(r.sent >= 1);
});

test('dialer returns a valid outcome', () => {
  const c = placeCall({ id: 'x', fullName: 'Avery Singh', phone: '+1 (415) 555-0142' });
  assert.ok(['connected', 'voicemail', 'no_answer'].includes(c.outcome));
});

test('ai research returns an answer (heuristic offline)', async () => {
  const r = await aiResearch({ fullName: 'Jordan Patel', company: 'Northstar Labs' }, 'ICP fit?');
  assert.ok(r.ok);
  assert.ok(r.answer.length > 0);
});
