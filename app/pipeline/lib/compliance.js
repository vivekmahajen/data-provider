// Stage 8 — the compliance gate. The legal backbone of a resale business.
//   - suppression: never store/sell an opted-out / erased / bounced value
//   - region policy: optionally exclude regions where you lack lawful basis
//   - export filter: only resale_ok values leave the building
// Configure region policy via PIPELINE_BLOCK_REGIONS (comma list, e.g. "EU").

import { get, run, all, id, now } from './db.js';

const BLOCKED_REGIONS = new Set(
  (process.env.PIPELINE_BLOCK_REGIONS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
);

export async function isSuppressed(value) {
  if (!value) return false;
  return !!(await get('SELECT 1 AS x FROM suppressions WHERE value = :v', { v: String(value).toLowerCase() }));
}

export async function suppress(value, reason = 'opt_out') {
  if (!value) return;
  const v = String(value).toLowerCase();
  // portable upsert (no dialect-specific INSERT OR IGNORE / ON CONFLICT)
  if (!(await get('SELECT 1 AS x FROM suppressions WHERE value = :v', { v }))) {
    await run(`INSERT INTO suppressions (value, reason, created_at) VALUES (:v, :r, :ts)`, { v, r: reason, ts: now() });
  }
}

export function regionAllowed(region) {
  if (!region) return true;
  return !BLOCKED_REGIONS.has(String(region).toUpperCase());
}

// Decide whether a normalized record may enter the canonical store at all.
export async function gateRecord(rec) {
  if (!regionAllowed(rec.region)) return { allowed: false, reason: `region_blocked:${rec.region}` };
  if (rec.email && (await isSuppressed(rec.email))) return { allowed: false, reason: 'suppressed_email' };
  if (rec.phone && (await isSuppressed(rec.phone))) return { allowed: false, reason: 'suppressed_phone' };
  if (rec.domain && (await isSuppressed(rec.domain))) return { allowed: false, reason: 'suppressed_domain' };
  return { allowed: true };
}

// GDPR / CCPA erasure: remove a value everywhere and suppress it permanently so
// it can never be re-ingested.
export async function eraseValue(value, reason = 'gdpr_erasure') {
  const v = String(value).toLowerCase();
  await run('DELETE FROM contact_points WHERE lower(value) = :v', { v });
  await suppress(v, reason);
  return { erased: v, reason };
}

// Export-time guarantee: only verified, resale-permitted, non-suppressed rows.
export async function exportableContacts(limit = 1000) {
  return all(
    `SELECT cp.kind, cp.value, cp.status, cp.confidence, p.full_name, p.title, c.name AS company, c.domain
       FROM contact_points cp
       JOIN people p ON p.id = cp.person_id
       LEFT JOIN companies c ON c.id = p.company_id
      WHERE cp.resale_ok = 1
        AND cp.status IN ('valid','catch_all')
        AND cp.value NOT IN (SELECT value FROM suppressions)
      ORDER BY cp.confidence DESC
      LIMIT :limit`,
    { limit }
  );
}
