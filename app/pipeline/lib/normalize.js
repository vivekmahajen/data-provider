// Stage 3 — normalization. Turns a raw connector record into a clean,
// canonical shape (standard name casing, bare domain, E.164-ish phone,
// lowercased email, coarse region for compliance gating).

import { slug, domainFromCompany } from '../../server/lib/util.js';

const EU = new Set(['FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'IE', 'PT', 'AT', 'SE', 'DK', 'FI', 'PL', 'UK', 'GB']);

export function normalizeDomain(input) {
  if (!input) return null;
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
  return d || null;
}

export function normalizeEmail(input) {
  if (!input) return null;
  const e = String(input).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

// Best-effort E.164. Keeps a leading +, strips formatting; defaults to +1 for
// 10-digit North-American numbers. Real systems should use libphonenumber.
export function normalizePhone(input) {
  if (!input) return null;
  let p = String(input).trim();
  const hasPlus = p.startsWith('+');
  p = p.replace(/[^\d]/g, '');
  if (!p) return null;
  if (hasPlus) return '+' + p;
  if (p.length === 10) return '+1' + p;
  if (p.length === 11 && p.startsWith('1')) return '+' + p;
  return '+' + p;
}

function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();
}

function regionFromLocation(loc) {
  if (!loc) return null;
  const tail = String(loc).split(',').pop().trim().toUpperCase();
  if (EU.has(tail)) return 'EU';
  if (['US', 'USA', 'CA', 'CANADA'].includes(tail)) return 'NA';
  return tail || null;
}

// Field access tolerant of header casing/separators. CSV headers arrive
// lowercased (e.g. "linkedinurl"); JSON sources may use camelCase or snake_case.
// We index the record by a key stripped to lowercase alphanumerics and read by
// any of the given aliases.
function field(raw, ...aliases) {
  const map = {};
  for (const k of Object.keys(raw)) map[k.toLowerCase().replace(/[^a-z0-9]/g, '')] = raw[k];
  for (const a of aliases) {
    const v = map[a.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

export function normalizeRecord(raw) {
  const fullRaw = field(raw, 'fullName', 'full_name', 'name');
  const first = titleCase(field(raw, 'firstName', 'first_name', 'first') || fullRaw.split(/\s+/)[0]);
  const last = titleCase(field(raw, 'lastName', 'last_name', 'last') || fullRaw.split(/\s+/).slice(1).join(' '));
  const fullName = titleCase(fullRaw || `${first} ${last}`).trim();
  const company = field(raw, 'company', 'organization', 'org');
  const domain = normalizeDomain(field(raw, 'domain', 'website', 'companyDomain')) || domainFromCompany(company) || null;
  const location = field(raw, 'location', 'city', 'country') || null;
  return {
    fullName: fullName || null,
    firstName: first || null,
    lastName: last || null,
    title: field(raw, 'title', 'job_title', 'jobTitle') || null,
    company: company || null,
    domain,
    location,
    region: regionFromLocation(location),
    linkedinUrl: field(raw, 'linkedinUrl', 'linkedin_url', 'linkedin') || null,
    email: normalizeEmail(field(raw, 'email', 'work_email', 'workEmail')),
    phone: normalizePhone(field(raw, 'phone', 'mobile', 'phone_number', 'mobilePhone')),
    // a stable key for identity resolution when no LinkedIn URL exists
    nameKey: slug(fullName),
  };
}
