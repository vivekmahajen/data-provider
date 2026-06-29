// Candidate registry tests — consent enforcement, profile storage, withdrawal.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { open, get } from '../lib/db.js';
import { signupCandidate, withdrawConsent, registryStats } from '../../server/registry.js';

before(async () => { await open(':memory:'); });

test('signup without consent is refused', async () => {
  const out = await signupCandidate({ fullName: 'No Consent', email: 'x@y.com', consent: false });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'consent_required');
});

test('signup with consent stores person + profile + records consent', async () => {
  const out = await signupCandidate({
    fullName: 'Dr. Asha Verma', email: 'asha.verma@example.ac.in',
    currentInstitution: 'Pune Institute of Tech', currentTitle: 'Associate Dean',
    yearsExperience: 15, highestQualification: 'PhD',
    desiredRoles: ['Dean', 'Director of Admissions'], location: 'Pune, IN', consent: true,
  });
  assert.equal(out.ok, true);
  const prof = await get('SELECT * FROM candidate_profiles WHERE person_id = :id', { id: out.personId });
  assert.equal(prof.consent, 1);
  assert.ok(prof.consent_at > 0);
  assert.match(prof.desired_roles, /Dean/);
  assert.equal(prof.highest_qualification, 'PhD');
  // consent recorded in provenance (auditable lawful basis)
  const prov = await get(`SELECT * FROM provenance WHERE entity_id = :id AND field = 'consent'`, { id: out.personId });
  assert.ok(prov);
});

test('registry stats counts consented + available candidates', async () => {
  const s = await registryStats();
  assert.ok(s.consentedAvailable >= 1);
});

test('withdrawing consent suppresses the contact and marks unavailable', async () => {
  const out = await signupCandidate({ fullName: 'Ravi Menon', email: 'ravi.menon@example.ac.in', desiredRoles: ['Registrar'], consent: true });
  await withdrawConsent(out.personId);
  const prof = await get('SELECT * FROM candidate_profiles WHERE person_id = :id', { id: out.personId });
  assert.equal(prof.available, 0);
  assert.equal(prof.consent, 0);
  const supp = await get(`SELECT 1 x FROM suppressions WHERE value = 'ravi.menon@example.ac.in'`);
  assert.ok(supp, 'withdrawn contact must be suppressed');
});
