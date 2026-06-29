// Stage 7 — confidence scoring for a contact point. Combines:
//   - verification status (a verified email beats an unverified one)
//   - source reputation (first-party/licensed > public web)
//   - agreement: how many distinct sources independently reported this value
//   - recency: freshly verified values score higher (data decays)
// Returns 0-100.

import { all } from './db.js';

const SOURCE_WEIGHT = { first_party: 1.0, licensed: 0.9, third_party_verify: 0.8, public_web: 0.6 };
const STATUS_WEIGHT = { valid: 1.0, catch_all: 0.7, unverified: 0.5, risky: 0.3, invalid: 0.0 };

export function scoreContactPoint({ status, sourceType, value, verifiedAt, nowTs }) {
  const sw = SOURCE_WEIGHT[sourceType] ?? 0.6;
  const stw = STATUS_WEIGHT[status] ?? 0.5;

  // agreement: count distinct sources that have observed this value
  const rows = all(
    `SELECT COUNT(DISTINCT source_id) AS n FROM provenance WHERE field IN ('email','phone') AND value = :v`,
    { v: value }
  );
  const agreement = Math.min(1, (rows[0]?.n || 1) / 3); // saturates at 3 sources

  // recency: full credit if verified "recently" in our monotonic clock terms
  const ageMs = verifiedAt ? Math.max(0, (nowTs || verifiedAt) - verifiedAt) : Infinity;
  const recency = verifiedAt ? Math.max(0.4, 1 - ageMs / (90 * 86400000)) : 0.5; // ~90d decay

  const score = 100 * (0.45 * stw + 0.25 * sw + 0.2 * agreement + 0.1 * recency);
  return Math.round(Math.max(0, Math.min(100, score)));
}
