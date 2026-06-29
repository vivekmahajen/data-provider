// Billing/metering tests (in-memory DB, no HTTP).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { open } from '../lib/db.js';
import { ensureBilling, getCustomerByKey, charge, createCustomer, usageSummary, remaining, PLANS } from '../../server/billing.js';

before(() => {
  open(':memory:');
  ensureBilling('admin-key');
});

test('admin/demo customer is seeded with the app key', () => {
  const c = getCustomerByKey('admin-key');
  assert.ok(c);
  assert.equal(c.is_admin, 1);
  assert.equal(remaining(c), PLANS.pro.credits);
});

test('charging deducts credits and writes a usage event', () => {
  const c = getCustomerByKey('admin-key');
  const before = remaining(c);
  const bill = charge(c, 'people/search', 5, { delivered: 5 });
  assert.equal(bill.ok, true);
  assert.equal(bill.charged, 5);
  assert.equal(bill.remaining, before - 5);
  const sum = usageSummary(getCustomerByKey('admin-key'));
  assert.equal(sum.creditsUsed, 5);
  assert.ok(sum.recent.length >= 1);
});

test('preview/zero-cost charge does not deduct', () => {
  const c = getCustomerByKey('admin-key');
  const before = remaining(c);
  const bill = charge(c, 'people/search', 0, {});
  assert.equal(bill.ok, true);
  assert.equal(bill.remaining, before);
});

test('new free customer gets its own key and 100 credits', () => {
  const cust = createCustomer({ name: 'Acme', plan: 'free' });
  assert.match(cust.api_key, /^fe_cust_/);
  assert.equal(cust.credits_included, PLANS.free.credits);
  assert.equal(cust.is_admin, 0);
});

test('charge beyond balance is refused without deducting', () => {
  const cust = createCustomer({ name: 'Small', plan: 'free' });
  const bill = charge(cust, 'export.csv', PLANS.free.credits + 50, { rows: 150 });
  assert.equal(bill.ok, false);
  assert.equal(bill.needed, PLANS.free.credits + 50);
  assert.equal(bill.remaining, PLANS.free.credits); // untouched
});
