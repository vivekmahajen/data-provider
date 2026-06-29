// Programmable enrichment workflow ("table") — the Clay-style capability that
// FullEnrich lacks. A workflow is a set of input rows plus an ordered list of
// columns. Each column is an operation applied to every row; later columns can
// read the output of earlier ones. Running the workflow executes the cascade
// per row, charging credits via the store.

import { enrichContact } from './enrichment.js';
import { aiResearch } from './airesearch.js';
import { domainFromCompany } from './util.js';
import { chargeCredits, logEvent } from './store.js';

export const COLUMN_TYPES = {
  find_domain: 'Derive company domain',
  enrich_email: 'Waterfall: find verified email',
  enrich_phone: 'Waterfall: find verified mobile',
  ai_research: 'AI research (answer a question per row)',
};

export function newWorkflow(name, rows = []) {
  return {
    id: undefined, // assigned by caller
    name: name || 'Untitled workflow',
    rows: rows.map((r, i) => ({ _id: i + 1, ...r, _cells: {} })),
    columns: [],
    lastRun: null,
  };
}

export function addColumn(wf, col) {
  if (!COLUMN_TYPES[col.type]) throw new Error(`unknown column type: ${col.type}`);
  wf.columns.push({
    key: col.key || col.type + '_' + (wf.columns.length + 1),
    type: col.type,
    config: col.config || {},
  });
  return wf;
}

export async function runWorkflow(wf) {
  let creditsUsed = 0;
  let enriched = 0;
  for (const row of wf.rows) {
    row._cells = row._cells || {};
    for (const col of wf.columns) {
      const out = await runCell(col, row);
      row._cells[col.key] = out.value;
      if (out.credits) {
        if (!chargeCredits(out.credits)) {
          row._cells[col.key] = { error: 'insufficient_credits' };
        } else {
          creditsUsed += out.credits;
        }
      }
      if (out.enriched) enriched++;
    }
  }
  wf.lastRun = { creditsUsed, enriched, rows: wf.rows.length };
  logEvent('workflow_run', { workflow: wf.name, creditsUsed, enriched, rows: wf.rows.length });
  return wf;
}

async function runCell(col, row) {
  const cells = row._cells || {};
  switch (col.type) {
    case 'find_domain': {
      const domain = row.domain || domainFromCompany(row.company);
      return { value: domain || null };
    }
    case 'enrich_email': {
      const res = enrichContact(
        { fullName: row.fullName || `${row.firstname || ''} ${row.lastname || ''}`.trim(), company: row.company, domain: row.domain, linkedinUrl: row.linkedinurl || row.linkedinUrl },
        { wantEmail: true, wantPhone: false }
      );
      return {
        value: res.email ? { email: res.email, provider: res.emailProvider, verification: res.emailVerification } : null,
        credits: res.creditsUsed,
        enriched: !!res.email,
      };
    }
    case 'enrich_phone': {
      const res = enrichContact(
        { fullName: row.fullName || `${row.firstname || ''} ${row.lastname || ''}`.trim(), company: row.company, domain: row.domain, linkedinUrl: row.linkedinurl || row.linkedinUrl },
        { wantEmail: false, wantPhone: true }
      );
      return {
        value: res.phone ? { phone: res.phone, provider: res.phoneProvider } : null,
        credits: res.creditsUsed,
        enriched: !!res.phone,
      };
    }
    case 'ai_research': {
      const question = (col.config && col.config.question) || 'Summarise this contact';
      const ans = await aiResearch(
        { fullName: row.fullName, company: row.company, title: row.title, industry: row.industry },
        question
      );
      return { value: ans.ok ? ans.answer : { error: ans.error } };
    }
    default:
      return { value: null };
  }
}
