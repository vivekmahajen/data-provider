// The orchestrator. Runs a connector's records through stages 2–9:
//   land raw → normalize → compliance gate → resolve identity →
//   upsert contact points (with provenance) → [optional] enrich → verify+score.
//
// Compliance rule enforced here: a contact VALUE is resellable only if it came
// from a resale-permitted source. Values discovered via third-party enrichment
// are stored (useful for YOUR outreach) but flagged resale_ok = 0, so they
// never appear in the resale export. That distinction is the whole ballgame.

import { db, get, run, all, id, now, ensureSource, recordProvenance } from './db.js';
import { normalizeRecord } from './normalize.js';
import { gateRecord, isSuppressed } from './compliance.js';
import { resolveCompany, resolvePerson } from './identity.js';
import { verifyValue } from './verify.js';
import { scoreContactPoint } from './scoring.js';
import { enrichContact } from '../../server/lib/enrichment.js';

function upsertContactPoint(personId, kind, value, source) {
  if (!value || isSuppressed(value)) return { added: false };
  const existing = get(
    'SELECT * FROM contact_points WHERE person_id = :pid AND kind = :k AND value = :v',
    { pid: personId, k: kind, v: value }
  );
  // provenance is recorded for every observation (drives agreement scoring)
  if (existing) {
    recordProvenance('contact_point', existing.id, kind, value, source.id);
    return { added: false, id: existing.id };
  }
  const cpid = id();
  run(
    `INSERT INTO contact_points (id, person_id, kind, value, status, confidence, source_id, resale_ok, first_seen)
     VALUES (:id, :pid, :kind, :value, 'unverified', 0, :sid, :resale, :ts)`,
    { id: cpid, pid: personId, kind, value, sid: source.id, resale: source.resale_allowed, ts: now() }
  );
  recordProvenance('contact_point', cpid, kind, value, source.id);
  return { added: true, id: cpid };
}

function verifyAndScore(cpId) {
  const cp = get('SELECT * FROM contact_points WHERE id = :id', { id: cpId });
  if (!cp) return;
  const src = get('SELECT type FROM sources WHERE id = :id', { id: cp.source_id });
  const v = verifyValue(cp.kind, cp.value);
  const ts = now();
  const confidence = scoreContactPoint({
    status: v.status, sourceType: src?.type, value: cp.value, verifiedAt: ts, nowTs: ts,
  });
  run(`UPDATE contact_points SET status = :s, confidence = :c, verified_at = :ts WHERE id = :id`,
    { s: v.status, c: confidence, ts, id: cpId });
  return { status: v.status, confidence };
}

export function ingest(connectorRecords, source, { enrich = false } = {}) {
  // connectorRecords: iterable/async-iterable of raw records; source: {name,type,...}
  const src = ensureSource(source);
  const enrichSrc = enrich
    ? ensureSource({ name: 'waterfall-enrichment', type: 'third_party_verify', license: 'provider APIs — verify/enrich only, NOT resellable', resaleAllowed: false })
    : null;

  const stats = { landed: 0, rejected: 0, peopleCreated: 0, peopleMatched: 0, contactsAdded: 0, enrichedAdded: 0, verified: 0 };
  return (async () => {
    for await (const raw of connectorRecords) {
      // 2. land raw (immutable)
      const rawId = id();
      run(`INSERT INTO raw_records (id, source_id, payload, ingested_at, status) VALUES (:id, :sid, :p, :ts, 'landed')`,
        { id: rawId, sid: src.id, p: JSON.stringify(raw), ts: now() });
      stats.landed++;

      // 3. normalize
      const rec = normalizeRecord(raw);

      // 8. compliance gate (early)
      const gate = gateRecord(rec);
      if (!gate.allowed) {
        run(`UPDATE raw_records SET status = 'rejected' WHERE id = :id`, { id: rawId });
        stats.rejected++;
        continue;
      }

      // 4. identity resolution
      const company = resolveCompany(rec, src.id);
      const { person, created } = resolvePerson(rec, company, src.id);
      created ? stats.peopleCreated++ : stats.peopleMatched++;

      // store + verify the values that came WITH the record (resale per source)
      const newCps = [];
      for (const [kind, value] of [['email', rec.email], ['phone', rec.phone]]) {
        const r = upsertContactPoint(person.id, kind, value, src);
        if (r.added) { stats.contactsAdded++; newCps.push(r.id); }
      }

      // 5. optional enrichment — fills gaps but marks values non-resellable
      if (enrich && (!rec.email || !rec.phone)) {
        const out = enrichContact(
          { fullName: rec.fullName, company: rec.company, domain: rec.domain, linkedinUrl: rec.linkedinUrl },
          { wantEmail: !rec.email, wantPhone: !rec.phone }
        );
        for (const [kind, value] of [['email', out.email], ['phone', out.phone]]) {
          if (!value) continue;
          const r = upsertContactPoint(person.id, kind, value, enrichSrc);
          if (r.added) { stats.enrichedAdded++; newCps.push(r.id); }
        }
      }

      // 6/7. verify + score the new contact points
      for (const cpId of newCps) { verifyAndScore(cpId); stats.verified++; }
    }
    return stats;
  })();
}

// Re-verification: pick the N oldest verified contacts and re-check them
// (data decay defense). Returns how many were refreshed.
export function reverifyStale(limit = 50) {
  const rows = all(
    `SELECT id FROM contact_points WHERE status IN ('valid','catch_all','unverified')
      ORDER BY COALESCE(verified_at, 0) ASC LIMIT :limit`,
    { limit }
  );
  for (const r of rows) verifyAndScore(r.id);
  return rows.length;
}
