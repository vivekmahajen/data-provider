// Stage 4 — identity resolution & dedup. Maps a normalized record onto a
// canonical company and person, creating or merging as needed. Without this
// step a data provider's DB fills with near-duplicate rows and becomes
// worthless. Matching strategy (cheapest reliable signals first):
//   company: by domain
//   person:  by linkedin_url, else by (nameKey + company_id)

import { get, run, id, now, recordProvenance } from './db.js';

export async function resolveCompany(rec, sourceId) {
  if (!rec.domain && !rec.company) return null;
  let row = rec.domain ? await get('SELECT * FROM companies WHERE domain = :d', { d: rec.domain }) : null;
  if (!row && rec.company && !rec.domain) {
    row = await get('SELECT * FROM companies WHERE name = :n', { n: rec.company });
  }
  if (row) {
    // enrich missing fields only (don't overwrite good data)
    const patch = {};
    if (!row.name && rec.company) patch.name = rec.company;
    if (!row.location && rec.location) patch.location = rec.location;
    if (Object.keys(patch).length) {
      await run(`UPDATE companies SET name = COALESCE(:name, name), location = COALESCE(:loc, location), updated_at = :ts WHERE id = :id`,
        { name: patch.name ?? null, loc: patch.location ?? null, ts: now(), id: row.id });
    }
    return get('SELECT * FROM companies WHERE id = :id', { id: row.id });
  }
  const cid = id();
  await run(`INSERT INTO companies (id, domain, name, location, created_at, updated_at)
       VALUES (:id, :domain, :name, :loc, :ts, :ts)`,
    { id: cid, domain: rec.domain, name: rec.company, loc: rec.location, ts: now() });
  if (rec.domain) await recordProvenance('company', cid, 'domain', rec.domain, sourceId);
  return get('SELECT * FROM companies WHERE id = :id', { id: cid });
}

export async function resolvePerson(rec, company, sourceId) {
  let row = null;
  if (rec.linkedinUrl) {
    row = await get('SELECT * FROM people WHERE linkedin_url = :u', { u: rec.linkedinUrl });
  }
  if (!row && rec.nameKey && company) {
    // match same name at same company
    row = await get(
      `SELECT p.* FROM people p WHERE p.company_id = :cid AND lower(replace(p.full_name, ' ', '')) = :nk`,
      { cid: company.id, nk: rec.nameKey }
    );
  }
  if (row) {
    await run(`UPDATE people SET
            full_name = COALESCE(full_name, :fn),
            first_name = COALESCE(first_name, :first),
            last_name = COALESCE(last_name, :last),
            title = COALESCE(:title, title),
            linkedin_url = COALESCE(linkedin_url, :li),
            company_id = COALESCE(company_id, :cid),
            location = COALESCE(:loc, location),
            region = COALESCE(:region, region),
            updated_at = :ts
         WHERE id = :id`,
      { fn: rec.fullName, first: rec.firstName, last: rec.lastName, title: rec.title,
        li: rec.linkedinUrl, cid: company?.id ?? null, loc: rec.location, region: rec.region, ts: now(), id: row.id });
    return { person: await get('SELECT * FROM people WHERE id = :id', { id: row.id }), created: false };
  }
  const pid = id();
  await run(`INSERT INTO people (id, full_name, first_name, last_name, linkedin_url, company_id, title, location, region, created_at, updated_at)
       VALUES (:id, :fn, :first, :last, :li, :cid, :title, :loc, :region, :ts, :ts)`,
    { id: pid, fn: rec.fullName, first: rec.firstName, last: rec.lastName, li: rec.linkedinUrl,
      cid: company?.id ?? null, title: rec.title, loc: rec.location, region: rec.region, ts: now() });
  await recordProvenance('person', pid, 'full_name', rec.fullName, sourceId);
  if (rec.linkedinUrl) await recordProvenance('person', pid, 'linkedin_url', rec.linkedinUrl, sourceId);
  return { person: await get('SELECT * FROM people WHERE id = :id', { id: pid }), created: true };
}
