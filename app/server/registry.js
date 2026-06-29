// Candidate registry — opt-in intake for job-seekers who CONSENT to be listed
// for university hiring (Dean, Director of Admissions, Registrar, etc.).
//
// Lawful basis (India DPDP): we only store a candidate when they give explicit
// consent; the exact consent text + timestamp are recorded, and consent is
// written to the provenance log so the basis is auditable. The contact itself
// is routed through the normal pipeline (dedup + verify + provenance); the
// candidate-specific fields live in candidate_profiles.

import { get, run, all, id, now, recordProvenance } from '../pipeline/lib/db.js';
import { ingest } from '../pipeline/lib/pipeline.js';
import { normalizeEmail, normalizePhone } from '../pipeline/lib/normalize.js';

export const CONSENT_TEXT =
  'I consent to my profile and contact details being shared with Indian universities ' +
  'and their authorized recruiters for the purpose of hiring for academic and ' +
  'administrative roles. I understand I can withdraw this consent at any time.';

export const ROLES = [
  'Vice-Chancellor', 'Pro Vice-Chancellor', 'Dean', 'Director of Admissions',
  'Registrar', 'Controller of Examinations', 'Head of Department',
  'Director (Administration)', 'Finance Officer', 'Professor',
];
export const QUALIFICATIONS = ['PhD', 'Post-Doc', 'Masters', 'MPhil', 'Bachelors', 'Other'];

const SOURCE = { name: 'candidate-registry', type: 'first_party', license: 'opt-in candidate consent', resaleAllowed: true };

export async function signupCandidate(payload = {}) {
  const consent = payload.consent === true || payload.consent === 'true' || payload.consent === 'on';
  if (!consent) return { ok: false, status: 400, error: 'consent_required' };
  if (!payload.fullName || (!payload.email && !payload.phone)) {
    return { ok: false, status: 400, error: 'fullName and (email or phone) are required' };
  }

  // 1) route the base contact through the pipeline (dedup + verify + provenance)
  const record = {
    fullName: payload.fullName,
    email: payload.email,
    phone: payload.phone,
    company: payload.currentInstitution,   // store institution as the person's org
    title: payload.currentTitle,
    location: payload.location,
    linkedinUrl: payload.linkedinUrl,
  };
  async function* one() { yield record; }
  await ingest(one(), SOURCE, { enrich: false });

  // 2) find the resolved person
  const person = await findPerson(record);
  if (!person) return { ok: false, status: 500, error: 'could_not_store_contact' };

  // 3) upsert the candidate profile
  const roles = Array.isArray(payload.desiredRoles) ? payload.desiredRoles.join(', ') : (payload.desiredRoles || '');
  const fields = {
    roles: roles || null,
    ct: payload.currentTitle || null,
    ci: payload.currentInstitution || null,
    exp: Number.isFinite(Number(payload.yearsExperience)) ? Number(payload.yearsExperience) : null,
    qual: payload.highestQualification || null,
    cv: payload.cvUrl || null,
    ts: now(),
  };
  const existing = await get('SELECT * FROM candidate_profiles WHERE person_id = :pid', { pid: person.id });
  if (existing) {
    await run(`UPDATE candidate_profiles SET desired_roles=:roles, current_title=:ct, current_institution=:ci,
                 years_experience=:exp, highest_qualification=:qual, cv_url=:cv, available=1,
                 consent=1, consent_text=:txt, consent_at=:ts, updated_at=:ts WHERE person_id=:pid`,
      { ...fields, txt: CONSENT_TEXT, pid: person.id });
  } else {
    await run(`INSERT INTO candidate_profiles
                 (id, person_id, desired_roles, current_title, current_institution, years_experience,
                  highest_qualification, cv_url, available, consent, consent_text, consent_at, created_at, updated_at)
               VALUES (:id, :pid, :roles, :ct, :ci, :exp, :qual, :cv, 1, 1, :txt, :ts, :ts, :ts)`,
      { id: id(), pid: person.id, ...fields, txt: CONSENT_TEXT });
  }

  // 4) record consent in the provenance log (auditable lawful basis)
  const src = await get(`SELECT id FROM sources WHERE name = 'candidate-registry'`);
  if (src) await recordProvenance('person', person.id, 'consent', 'granted', src.id);

  return { ok: true, personId: person.id };
}

async function findPerson(record) {
  if (record.linkedinUrl) {
    const p = await get('SELECT * FROM people WHERE linkedin_url = :u', { u: record.linkedinUrl });
    if (p) return p;
  }
  const email = normalizeEmail(record.email);
  if (email) {
    const p = await get(
      `SELECT p.* FROM people p JOIN contact_points cp ON cp.person_id = p.id WHERE cp.value = :v LIMIT 1`,
      { v: email }
    );
    if (p) return p;
  }
  const phone = normalizePhone(record.phone);
  if (phone) {
    const p = await get(
      `SELECT p.* FROM people p JOIN contact_points cp ON cp.person_id = p.id WHERE cp.value = :v LIMIT 1`,
      { v: phone }
    );
    if (p) return p;
  }
  return null;
}

// Withdraw consent (DPDP right): mark unavailable, clear consent, and suppress
// the contact values so they stop being served/sold.
export async function withdrawConsent(personId) {
  await run('UPDATE candidate_profiles SET available = 0, consent = 0, updated_at = :ts WHERE person_id = :pid', { ts: now(), pid: personId });
  const cps = await all('SELECT value FROM contact_points WHERE person_id = :pid', { pid: personId });
  for (const cp of cps) {
    await run(`INSERT INTO suppressions (value, reason, created_at)
               SELECT :v, 'consent_withdrawn', :ts WHERE NOT EXISTS (SELECT 1 FROM suppressions WHERE value = :v)`,
      { v: String(cp.value).toLowerCase(), ts: now() });
  }
  return { ok: true, withdrawn: personId };
}

export async function findPersonByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  return get(`SELECT p.* FROM people p JOIN contact_points cp ON cp.person_id = p.id WHERE cp.value = :v LIMIT 1`, { v: e });
}

export async function registryStats() {
  const total = (await get('SELECT COUNT(*) n FROM candidate_profiles WHERE consent = 1 AND available = 1')).n;
  const byRole = await all(`SELECT desired_roles, COUNT(*) n FROM candidate_profiles WHERE available = 1 GROUP BY desired_roles`);
  return { consentedAvailable: total, byRole };
}
