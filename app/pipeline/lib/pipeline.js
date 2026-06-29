// The orchestrator. Runs a connector's records through stages 2–9:
//   land raw → normalize → compliance gate → resolve identity →
//   upsert contact points (with provenance) → [optional] enrich → verify+score.
//
// Compliance rule enforced here: a contact VALUE is resellable only if it came
// from a resale-permitted source. Values discovered via third-party enrichment
// are stored (useful for YOUR outreach) but flagged resale_ok = 0, so they
// never appear in the resale export. That distinction is the whole ballgame.

import { get, run, all, id, now, ensureSource, recordProvenance } from './db.js';
import { normalizeRecord } from './normalize.js';
import { gateRecord, isSuppressed } from './compliance.js';
import { resolveCompany, resolvePerson } from './identity.js';
import { scoreContactPoint } from './scoring.js';
import { getVerifier } from '../verifiers/index.js';
import { enrichContact } from '../../server/lib/enrichment.js';

async function upsertContactPoint(personId, kind, value, source) {
  if (!value || (await isSuppressed(value))) return { added: false };
  const existing = await get(
    'SELECT * FROM contact_points WHERE person_id = :pid AND kind = :k AND value = :v',
    { pid: personId, k: kind, v: value }
  );
  // provenance is recorded for every observation (drives agreement scoring)
  if (existing) {
    await recordProvenance('contact_point', existing.id, kind, value, source.id);
    return { added: false, id: existing.id };
  }
  const cpid = id();
  await run(
    `INSERT INTO contact_points (id, person_id, kind, value, status, confidence, source_id, resale_ok, first_seen)
     VALUES (:id, :pid, :kind, :value, 'unverified', 0, :sid, :resale, :ts)`,
    { id: cpid, pid: personId, kind, value, sid: source.id, resale: source.resale_allowed, ts: now() }
  );
  await recordProvenance('contact_point', cpid, kind, value, source.id);
  return { added: true, id: cpid };
}

async function verifyAndScore(cpId, verifier) {
  const cp = await get('SELECT * FROM contact_points WHERE id = :id', { id: cpId });
  if (!cp) return;
  const src = await get('SELECT type FROM sources WHERE id = :id', { id: cp.source_id });
  // person context lets real verifiers (e.g. Apollo match) identify the record
  const person = await get(
    `SELECT p.full_name, p.first_name, p.last_name, p.linkedin_url, c.name AS company, c.domain
       FROM people p LEFT JOIN companies c ON c.id = p.company_id WHERE p.id = :id`,
    { id: cp.person_id }
  );
  const ctx = person
    ? { fullName: person.full_name, firstName: person.first_name, lastName: person.last_name,
        company: person.company, domain: person.domain, linkedinUrl: person.linkedin_url }
    : {};
  const v = await verifier.verify(cp.kind, cp.value, ctx);
  const ts = now();
  const confidence = await scoreContactPoint({
    status: v.status, sourceType: src?.type, value: cp.value, verifiedAt: ts, nowTs: ts,
  });
  await run(`UPDATE contact_points SET status = :s, confidence = :c, verified_at = :ts WHERE id = :id`,
    { s: v.status, c: confidence, ts, id: cpId });
  return { status: v.status, confidence };
}

export async function ingest(connectorRecords, source, { enrich = false } = {}) {
  // connectorRecords: iterable/async-iterable of raw records; source: {name,type,...}
  const src = await ensureSource(source);
  const verifier = getVerifier();
  const enrichSrc = enrich
    ? await ensureSource({ name: 'waterfall-enrichment', type: 'third_party_verify', license: 'provider APIs — verify/enrich only, NOT resellable', resaleAllowed: false })
    : null;

  const stats = { landed: 0, rejected: 0, peopleCreated: 0, peopleMatched: 0, contactsAdded: 0, enrichedAdded: 0, verified: 0 };
  for await (const raw of connectorRecords) {
    // 2. land raw (immutable)
    const rawId = id();
    await run(`INSERT INTO raw_records (id, source_id, payload, ingested_at, status) VALUES (:id, :sid, :p, :ts, 'landed')`,
      { id: rawId, sid: src.id, p: JSON.stringify(raw), ts: now() });
    stats.landed++;

    // 3. normalize
    const rec = normalizeRecord(raw);

    // 8. compliance gate (early)
    const gate = await gateRecord(rec);
    if (!gate.allowed) {
      await run(`UPDATE raw_records SET status = 'rejected' WHERE id = :id`, { id: rawId });
      stats.rejected++;
      continue;
    }

    // 4. identity resolution
    const company = await resolveCompany(rec, src.id);
    const { person, created } = await resolvePerson(rec, company, src.id);
    created ? stats.peopleCreated++ : stats.peopleMatched++;

    // store + verify the values that came WITH the record (resale per source)
    const newCps = [];
    for (const [kind, value] of [['email', rec.email], ['phone', rec.phone]]) {
      const r = await upsertContactPoint(person.id, kind, value, src);
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
        const r = await upsertContactPoint(person.id, kind, value, enrichSrc);
        if (r.added) { stats.enrichedAdded++; newCps.push(r.id); }
      }
    }

    // 6/7. verify + score the new contact points
    for (const cpId of newCps) { await verifyAndScore(cpId, verifier); stats.verified++; }
  }
  stats.verifier = verifier.name;
  return stats;
}

// Re-verification: pick the N oldest verified contacts and re-check them
// (data decay defense). Returns how many were refreshed.
export async function reverifyStale(limit = 50) {
  const verifier = getVerifier();
  const rows = await all(
    `SELECT id FROM contact_points WHERE status IN ('valid','catch_all','unverified')
      ORDER BY COALESCE(verified_at, 0) ASC LIMIT :limit`,
    { limit }
  );
  for (const r of rows) await verifyAndScore(r.id, verifier);
  return rows.length;
}
