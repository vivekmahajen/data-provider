// Payments tests — simulated provider (no Stripe keys), in-memory DB.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { open } from '../lib/db.js';
import { ensureBilling, createCustomer, getCustomerByKey, remaining, PLANS } from '../../server/billing.js';
import { createCheckout, completeCheckout, handleStripeWebhook, provider, CREDIT_PACKS } from '../../server/payments.js';

before(async () => {
  await open(':memory:');
  await ensureBilling('admin-key');
});

test('provider defaults to simulated without STRIPE_SECRET_KEY', () => {
  assert.equal(provider(), 'simulated');
});

test('credit-pack checkout grants credits on completion', async () => {
  const c = await createCustomer({ name: 'Buyer', plan: 'free' });
  const before = remaining(await getCustomerByKey(c.api_key));
  const session = await createCheckout(c, { kind: 'credits', target: 'pack_1k' });
  assert.equal(session.provider, 'simulated');
  assert.ok(session.url.includes(session.paymentId));

  const done = await completeCheckout(session.paymentId);
  assert.equal(done.ok, true);
  assert.equal(done.applied, true);
  const after = remaining(await getCustomerByKey(c.api_key));
  assert.equal(after, before + CREDIT_PACKS.pack_1k.credits);
});

test('completing twice is idempotent (no double credit)', async () => {
  const c = await createCustomer({ name: 'Once', plan: 'free' });
  const session = await createCheckout(c, { kind: 'credits', target: 'pack_5k' });
  await completeCheckout(session.paymentId);
  const afterFirst = remaining(await getCustomerByKey(c.api_key));
  const second = await completeCheckout(session.paymentId);
  assert.ok(second.alreadyApplied);
  assert.equal(remaining(await getCustomerByKey(c.api_key)), afterFirst);
});

test('plan checkout upgrades the plan and allotment', async () => {
  const c = await createCustomer({ name: 'Upgrader', plan: 'free' });
  const session = await createCheckout(c, { kind: 'plan', target: 'pro' });
  await completeCheckout(session.paymentId);
  const updated = await getCustomerByKey(c.api_key);
  assert.equal(updated.plan, 'pro');
  assert.equal(updated.credits_included, PLANS.pro.credits);
});

test('unknown pack/plan is rejected', async () => {
  const c = await createCustomer({ name: 'Bad', plan: 'free' });
  await assert.rejects(() => createCheckout(c, { kind: 'credits', target: 'nope' }));
  await assert.rejects(() => createCheckout(c, { kind: 'plan', target: 'nope' }));
});

test('webhook (no secret configured) applies a completed checkout', async () => {
  const c = await createCustomer({ name: 'Hooked', plan: 'free' });
  const before = remaining(await getCustomerByKey(c.api_key));
  const session = await createCheckout(c, { kind: 'credits', target: 'pack_1k' });
  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { metadata: { paymentId: session.paymentId } } } });
  const out = await handleStripeWebhook(Buffer.from(event), null);
  assert.equal(out.ok, true);
  assert.equal(remaining(await getCustomerByKey(c.api_key)), before + CREDIT_PACKS.pack_1k.credits);
});
