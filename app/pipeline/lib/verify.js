// Stage 6 — verification. Independent of sourcing: given a contact value,
// return a status + confidence. Email verification simulates a triple-verifier
// (syntax + MX + SMTP/catch-all); phone simulates an HLR/line-type lookup.
// Deterministic per value so re-runs are stable. Swap these bodies for real
// verifier APIs (e.g. ZeroBounce / NeverBounce / Twilio Lookup) in production.

import { seededUnit } from '../../server/lib/util.js';

export function verifyEmail(email) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { status: 'invalid', confidence: 0 };
  const u = seededUnit('verify:' + email);
  if (u < 0.72) return { status: 'valid', confidence: Math.round(85 + u * 14) };
  if (u < 0.9) return { status: 'catch_all', confidence: Math.round(55 + u * 20) };
  return { status: 'risky', confidence: Math.round(30 + u * 20) };
}

export function verifyPhone(phone) {
  if (!phone || phone.replace(/\D/g, '').length < 8) return { status: 'invalid', confidence: 0 };
  const u = seededUnit('verifyphone:' + phone);
  if (u < 0.8) return { status: 'valid', confidence: Math.round(80 + u * 19) };
  return { status: 'risky', confidence: Math.round(40 + u * 20) };
}

export function verifyValue(kind, value) {
  return kind === 'email' ? verifyEmail(value) : verifyPhone(value);
}
