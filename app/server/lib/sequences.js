// Outreach sequences + dialer — the Apollo-style capability FullEnrich lacks.
// A sequence is an ordered list of steps (email / wait / call). Contacts are
// enrolled and the engine computes a concrete schedule per contact. The dialer
// records click-to-call attempts with simulated outcomes.

import { id, nextTs, pick, seededUnit } from './util.js';
import { logEvent } from './store.js';

const DAY = 86400000;

export function newSequence(name, steps = []) {
  return {
    id: undefined,
    name: name || 'Untitled sequence',
    steps: steps.length ? steps : defaultSteps(),
    enrollments: [], // { contactId, fullName, email, status, schedule: [...] }
    stats: { enrolled: 0, sent: 0, opened: 0, replied: 0 },
  };
}

function defaultSteps() {
  return [
    { type: 'email', dayOffset: 0, subject: 'Quick question, {{firstName}}', body: 'Hi {{firstName}}, saw you lead at {{company}} — worth a chat?' },
    { type: 'wait', dayOffset: 2 },
    { type: 'email', dayOffset: 2, subject: 'Re: Quick question', body: 'Bumping this up, {{firstName}} — open to 15 min?' },
    { type: 'call', dayOffset: 4, note: 'Cold call — reference the two emails' },
  ];
}

export function enroll(seq, contact) {
  const base = nextTs();
  const schedule = seq.steps.map((s) => ({
    type: s.type,
    at: base + (s.dayOffset || 0) * DAY,
    subject: s.subject ? render(s.subject, contact) : undefined,
    body: s.body ? render(s.body, contact) : undefined,
    note: s.note,
    status: 'scheduled',
  }));
  const enrollment = {
    id: id('enr'),
    contactId: contact.id || null,
    fullName: contact.fullName || '',
    email: contact.email || null,
    phone: contact.phone || null,
    status: 'active',
    schedule,
  };
  seq.enrollments.push(enrollment);
  seq.stats.enrolled = seq.enrollments.length;
  logEvent('sequence_enroll', { sequence: seq.name, contact: enrollment.fullName });
  return enrollment;
}

// Simulate sending the next due email step for every active enrollment.
export function advance(seq) {
  let sent = 0;
  for (const e of seq.enrollments) {
    const next = e.schedule.find((s) => s.status === 'scheduled' && s.type === 'email');
    if (!next) continue;
    next.status = 'sent';
    sent++;
    const u = seededUnit('open' + e.id + next.subject);
    if (u < 0.55) { next.opened = true; seq.stats.opened++; }
    if (u < 0.18) { next.replied = true; seq.stats.replied++; e.status = 'replied'; }
  }
  seq.stats.sent += sent;
  logEvent('sequence_send', { sequence: seq.name, sent });
  return { sent };
}

function render(tpl, c) {
  return String(tpl)
    .replace(/\{\{\s*firstName\s*\}\}/g, c.firstName || (c.fullName || '').split(' ')[0] || 'there')
    .replace(/\{\{\s*company\s*\}\}/g, c.company || 'your team')
    .replace(/\{\{\s*fullName\s*\}\}/g, c.fullName || '');
}

// ---- Dialer ----------------------------------------------------------------

export function placeCall(contact) {
  const u = seededUnit('call' + (contact.id || contact.phone || contact.fullName));
  const outcome = u < 0.35 ? 'connected' : u < 0.6 ? 'voicemail' : 'no_answer';
  const durationSec = outcome === 'connected' ? 60 + Math.floor(u * 600) : 0;
  const call = {
    id: id('call'),
    contactId: contact.id || null,
    fullName: contact.fullName || '',
    phone: contact.phone || null,
    outcome,
    durationSec,
    ts: nextTs(),
  };
  logEvent('call', { outcome, durationSec, contact: call.fullName });
  return call;
}
