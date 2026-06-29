// Payments — turns the metering ledger into real money. Customers buy credit
// packs or upgrade plans via Stripe Checkout; on payment success we grant
// credits (billing.topUp) or switch the plan (billing.changePlan).
//
// Provider selection mirrors the verifier pattern: real Stripe when
// STRIPE_SECRET_KEY is set, otherwise a 'simulated' provider so the whole flow
// works in the demo with no keys (checkout → complete → credits applied).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { get, run, id, now } from '../pipeline/lib/db.js';
import { topUp, changePlan, getCustomerByKey } from './billing.js';

// Catalog (amounts are whole USD for the demo).
export const CREDIT_PACKS = {
  pack_1k: { credits: 1000, amountUsd: 29 },
  pack_5k: { credits: 5000, amountUsd: 99 },
  pack_25k: { credits: 25000, amountUsd: 399 },
};
export const PLAN_PRICES = {
  starter: { amountUsd: 29 },
  pro: { amountUsd: 99 },
  scale: { amountUsd: 499 },
};

export function provider() {
  return process.env.STRIPE_SECRET_KEY ? 'stripe' : 'simulated';
}

function resolveItem(kind, target) {
  if (kind === 'credits') {
    const pack = CREDIT_PACKS[target];
    if (!pack) throw new Error(`unknown credit pack: ${target}`);
    return { credits: pack.credits, amountUsd: pack.amountUsd, label: `${pack.credits} credits` };
  }
  if (kind === 'plan') {
    const price = PLAN_PRICES[target];
    if (!price) throw new Error(`unknown plan: ${target}`);
    return { credits: 0, amountUsd: price.amountUsd, label: `${target} plan` };
  }
  throw new Error(`unknown checkout kind: ${kind}`);
}

// Create a checkout session. Returns { provider, paymentId, url, sessionId }.
export async function createCheckout(customer, { kind, target, successUrl, cancelUrl } = {}) {
  const item = resolveItem(kind, target);
  const paymentId = id();
  const prov = provider();
  let sessionId = `sim_${paymentId}`;
  let url = `/api/v1/billing/checkout/${paymentId}/complete`; // simulated: customer "pays" by POSTing here

  if (prov === 'stripe') {
    const session = await createStripeSession(customer, item, paymentId, { successUrl, cancelUrl });
    sessionId = session.id;
    url = session.url;
  }

  await run(
    `INSERT INTO payments (id, customer_id, kind, target, credits, amount_usd, provider, session_id, status, created_at)
     VALUES (:id, :cid, :kind, :target, :credits, :amount, :prov, :sid, 'open', :ts)`,
    { id: paymentId, cid: customer.id, kind, target, credits: item.credits, amount: item.amountUsd, prov, sid: sessionId, ts: now() }
  );
  return { provider: prov, paymentId, sessionId, url, amountUsd: item.amountUsd, item: item.label };
}

// Apply a paid payment exactly once (idempotent). Grants credits / changes plan.
async function applyPayment(payment) {
  if (payment.status === 'paid') return { alreadyApplied: true };
  const customer = await get('SELECT * FROM customers WHERE id = :id', { id: payment.customer_id });
  if (payment.kind === 'credits') await topUp(customer, payment.credits, { paymentId: payment.id });
  else if (payment.kind === 'plan') await changePlan(customer, payment.target);
  await run(`UPDATE payments SET status = 'paid' WHERE id = :id`, { id: payment.id });
  const updated = await get('SELECT * FROM customers WHERE id = :id', { id: payment.customer_id });
  return { applied: true, plan: updated.plan, creditsIncluded: updated.credits_included, creditsUsed: updated.credits_used };
}

// Simulated-mode "the customer paid" hook (no real Stripe).
export async function completeCheckout(paymentId) {
  const payment = await get('SELECT * FROM payments WHERE id = :id', { id: paymentId });
  if (!payment) return { ok: false, error: 'payment_not_found' };
  if (payment.provider !== 'simulated') return { ok: false, error: 'use_stripe_webhook' };
  return { ok: true, ...(await applyPayment(payment)) };
}

// ---- Real Stripe ----------------------------------------------------------

async function createStripeSession(customer, item, paymentId, { successUrl, cancelUrl } = {}) {
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('success_url', successUrl || 'https://example.com/billing/success');
  body.set('cancel_url', cancelUrl || 'https://example.com/billing/cancel');
  body.set('client_reference_id', paymentId);
  body.set('metadata[paymentId]', paymentId);
  body.set('line_items[0][quantity]', '1');
  body.set('line_items[0][price_data][currency]', 'usd');
  body.set('line_items[0][price_data][unit_amount]', String(item.amountUsd * 100));
  body.set('line_items[0][price_data][product_data][name]', item.label);

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`stripe checkout failed: ${res.status}`);
  return res.json();
}

// Stripe webhook receiver. Verifies the signature (if STRIPE_WEBHOOK_SECRET is
// set) then applies the payment on checkout.session.completed.
export async function handleStripeWebhook(rawBody, signatureHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (secret && !verifyStripeSignature(rawBody, signatureHeader, secret)) {
    return { ok: false, status: 400, error: 'invalid_signature' };
  }
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch { return { ok: false, status: 400, error: 'bad_json' }; }
  if (event.type !== 'checkout.session.completed') return { ok: true, ignored: event.type };
  const paymentId = event.data?.object?.metadata?.paymentId || event.data?.object?.client_reference_id;
  const payment = paymentId && (await get('SELECT * FROM payments WHERE id = :id', { id: paymentId }));
  if (!payment) return { ok: false, status: 404, error: 'payment_not_found' };
  return { ok: true, ...(await applyPayment(payment)) };
}

// Stripe signs with: t=timestamp,v1=HMAC_SHA256(`${t}.${rawBody}`, secret)
function verifyStripeSignature(rawBody, header, secret) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  if (!parts.t || !parts.v1) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody.toString('utf8')}`).digest('hex');
  try { return timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1)); } catch { return false; }
}

export { getCustomerByKey };
