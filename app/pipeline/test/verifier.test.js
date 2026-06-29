// Verifier selection + Apollo verifier mapping tests (offline — Apollo path is
// exercised against a stub server, no real API calls / credits).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { getVerifier, resetVerifier } from '../verifiers/index.js';
import { SimulatedVerifier } from '../verifiers/simulated.js';
import { ApolloVerifier } from '../verifiers/apollo.js';

afterEach(() => {
  resetVerifier();
  delete process.env.VERIFIER;
  delete process.env.APOLLO_API_KEY;
  delete process.env.APOLLO_BASE_URL;
});

test('defaults to simulated verifier with no key', () => {
  assert.equal(getVerifier().name, 'simulated');
});

test('selects Apollo when APOLLO_API_KEY is set', () => {
  process.env.APOLLO_API_KEY = 'test-key';
  resetVerifier();
  assert.equal(getVerifier().name, 'apollo');
});

test('VERIFIER=apollo without key falls back to simulated', () => {
  process.env.VERIFIER = 'apollo';
  resetVerifier();
  assert.equal(getVerifier().name, 'simulated');
});

test('Apollo verifier maps email_status and phone presence (stub server)', async () => {
  // stub Apollo /people/match
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        person: {
          email: 'jordan.patel@northstarlabs.com',
          email_status: 'verified',
          phone_numbers: [{ sanitized_number: '+14155550142' }],
        },
      }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const port = server.address().port;
    process.env.APOLLO_BASE_URL = `http://127.0.0.1:${port}/match`;

    const v = new ApolloVerifier('test-key');
    const ctx = { fullName: 'Jordan Patel', firstName: 'Jordan', lastName: 'Patel', domain: 'northstarlabs.com' };

    const emailVerdict = await v.verify('email', 'jordan.patel@northstarlabs.com', ctx);
    assert.equal(emailVerdict.status, 'valid');
    assert.ok(emailVerdict.confidence >= 90);

    // a different email than Apollo holds → capped / risky
    const mismatch = await v.verify('email', 'wrong@northstarlabs.com', ctx);
    assert.ok(['risky', 'catch_all', 'unverified', 'invalid'].includes(mismatch.status));
    assert.ok(mismatch.confidence <= 45);

    const phoneVerdict = await v.verify('phone', '+14155550142', ctx);
    assert.equal(phoneVerdict.status, 'valid');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('Apollo verifier treats no-match as unverified', async () => {
  const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ person: null })); });
  await new Promise((r) => server.listen(0, r));
  try {
    process.env.APOLLO_BASE_URL = `http://127.0.0.1:${server.address().port}/match`;
    const v = new ApolloVerifier('test-key');
    const verdict = await v.verify('email', 'someone@acme.com', { fullName: 'Some One', domain: 'acme.com' });
    assert.equal(verdict.status, 'unverified');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
