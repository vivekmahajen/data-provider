// FullEnrich rebuild — Express server.
// Preserves the original product (waterfall enrichment, bulk CSV, REST API,
// credits, contact search) and adds every gap found vs. Clay / Apollo /
// BetterContact: Sequences, Dialer, AI Research, Workflow builder, Analytics.

import express from 'express';
import multer from 'multer';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCSV } from './lib/util.js';
import { enrichContact, PROVIDERS, EMAIL_CREDIT_COST, PHONE_CREDIT_COST } from './lib/enrichment.js';
import { aiResearch } from './lib/airesearch.js';
import {
  getDB, save, creditsRemaining, chargeCredits, logEvent, nextTs,
  searchContacts, getContact,
} from './lib/store.js';
import { newWorkflow, addColumn, runWorkflow, COLUMN_TYPES } from './lib/workflows.js';
import { newSequence, enroll, advance, placeCall } from './lib/sequences.js';
import { id } from './lib/util.js';
import { providerRouter, bootstrapProviderDB } from './provider-api.js';
import { ensureBilling } from './billing.js';
import { signupCandidate, withdrawConsent, registryStats, findPersonByEmail, CONSENT_TEXT, ROLES, QUALIFICATIONS } from './registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '../public');
const PORT = process.env.PORT || 3000;

const app = express();
// Capture the raw body so the Stripe webhook can verify its signature.
app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// One-time initialization (apply schema, seed admin). Runs lazily on the first
// request so it works both as a long-running server and as a serverless
// function (Vercel), where there is no single startup. Memoized; retried if it
// fails so a transient DB hiccup doesn't wedge the process.
let _bootPromise = null;
function ensureBoot() {
  if (!_bootPromise) {
    _bootPromise = bootstrapProviderDB()
      .then(() => ensureBilling(getDB().account.apiKey))
      .catch((e) => { _bootPromise = null; throw e; });
  }
  return _bootPromise;
}
app.use((req, res, next) => {
  ensureBoot().then(() => next()).catch((e) => res.status(500).json({ error: 'init_failed: ' + e.message }));
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Tiny API-key auth for /api/v1/* (the public REST surface). The in-app routes
// under /api/app/* are open for the demo UI.
function requireApiKey(req, res, next) {
  const key = req.header('x-api-key') || (req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (key && key === getDB().account.apiKey) return next();
  res.status(401).json({ error: 'invalid_api_key', hint: 'send X-API-Key header (see Settings)' });
}

// ----------------------------------------------------------------------------
// Account / credits
// ----------------------------------------------------------------------------
app.get('/api/app/account', (req, res) => {
  const a = getDB().account;
  res.json({ ...a, creditsRemaining: creditsRemaining(), emailCost: EMAIL_CREDIT_COST, phoneCost: PHONE_CREDIT_COST });
});

// ----------------------------------------------------------------------------
// Core: single + bulk waterfall enrichment
// ----------------------------------------------------------------------------
function doEnrich(input, opts) {
  const res = enrichContact(input, opts);
  if (res.creditsUsed > 0 && !chargeCredits(res.creditsUsed)) {
    return { ...res, status: 'insufficient_credits', email: null, phone: null, creditsUsed: 0 };
  }
  const job = { id: id('job'), type: 'single', ts: nextTs(), ...res };
  getDB().jobs.push(job);
  logEvent('enrich', { status: res.status, creditsUsed: res.creditsUsed, email: !!res.email, phone: !!res.phone });
  save();
  return job;
}

app.post('/api/app/enrich', (req, res) => {
  const { wantEmail, wantPhone, ...input } = req.body || {};
  if (!input.fullName && !input.firstName && !input.linkedinUrl) {
    return res.status(400).json({ error: 'provide fullName (or firstName/lastName) and company/domain, or a linkedinUrl' });
  }
  res.json(doEnrich(input, { wantEmail, wantPhone }));
});

app.post('/api/app/enrich/bulk', upload.single('file'), (req, res) => {
  let rows = [];
  if (req.file) rows = parseCSV(req.file.buffer.toString('utf8'));
  else if (Array.isArray(req.body?.rows)) rows = req.body.rows;
  if (!rows.length) return res.status(400).json({ error: 'no rows — upload a CSV file or POST { rows: [...] }' });

  const wantEmail = req.body?.wantEmail !== 'false';
  const wantPhone = req.body?.wantPhone !== 'false';
  const results = [];
  let creditsUsed = 0;
  let enriched = 0;
  for (const r of rows.slice(0, 1000)) {
    const input = {
      fullName: r.fullname || r.full_name || [r.firstname || r.first_name, r.lastname || r.last_name].filter(Boolean).join(' '),
      company: r.company || r.organization,
      domain: r.domain || r.website,
      linkedinUrl: r.linkedinurl || r.linkedin_url || r.linkedin,
    };
    const out = enrichContact(input, { wantEmail, wantPhone });
    if (out.creditsUsed > 0 && chargeCredits(out.creditsUsed)) creditsUsed += out.creditsUsed;
    else if (out.creditsUsed > 0) { out.status = 'insufficient_credits'; out.email = null; out.phone = null; out.creditsUsed = 0; }
    if (out.status === 'enriched') enriched++;
    results.push(out);
  }
  const job = { id: id('job'), type: 'bulk', ts: nextTs(), total: results.length, enriched, creditsUsed, results };
  getDB().jobs.push(job);
  logEvent('bulk_enrich', { total: results.length, enriched, creditsUsed });
  save();
  res.json({ jobId: job.id, total: results.length, enriched, creditsUsed, hitRate: results.length ? Math.round((enriched / results.length) * 100) : 0, results });
});

// ----------------------------------------------------------------------------
// GAP: searchable B2B contact database
// ----------------------------------------------------------------------------
app.get('/api/app/search', (req, res) => {
  const { q, title, industry, location, minEmployees, maxEmployees, page = 1, pageSize = 20 } = req.query;
  res.json(searchContacts({ q, title, industry, location, minEmployees, maxEmployees }, Number(page), Number(pageSize)));
});

app.post('/api/app/search/reveal', (req, res) => {
  const c = getContact(req.body?.id);
  if (!c) return res.status(404).json({ error: 'contact not found' });
  const out = enrichContact(c, { wantEmail: true, wantPhone: req.body?.wantPhone !== false });
  if (out.creditsUsed > 0 && !chargeCredits(out.creditsUsed)) return res.status(402).json({ error: 'insufficient_credits' });
  c.email = out.email; c.phone = out.phone;
  logEvent('reveal', { creditsUsed: out.creditsUsed, email: !!out.email, phone: !!out.phone });
  save();
  res.json({ id: c.id, email: out.email, phone: out.phone, emailVerification: out.emailVerification, creditsUsed: out.creditsUsed });
});

// ----------------------------------------------------------------------------
// GAP: AI research
// ----------------------------------------------------------------------------
app.post('/api/app/ai-research', async (req, res) => {
  const { contact = {}, question } = req.body || {};
  const out = await aiResearch(contact, question || '');
  if (out.ok) logEvent('ai_research', { source: out.source });
  res.status(out.ok ? 200 : 400).json(out);
});

// ----------------------------------------------------------------------------
// GAP: programmable workflow / table builder
// ----------------------------------------------------------------------------
app.get('/api/app/workflows', (req, res) => res.json({ items: getDB().workflows, columnTypes: COLUMN_TYPES }));

app.post('/api/app/workflows', (req, res) => {
  const { name, rows = [], columns = [] } = req.body || {};
  const wf = newWorkflow(name, rows);
  wf.id = id('wf');
  for (const c of columns) { try { addColumn(wf, c); } catch (e) { return res.status(400).json({ error: e.message }); } }
  getDB().workflows.push(wf);
  save();
  res.json(wf);
});

app.post('/api/app/workflows/:id/run', async (req, res) => {
  const wf = getDB().workflows.find((w) => w.id === req.params.id);
  if (!wf) return res.status(404).json({ error: 'workflow not found' });
  await runWorkflow(wf);
  save();
  res.json(wf);
});

// ----------------------------------------------------------------------------
// GAP: outreach sequences + dialer
// ----------------------------------------------------------------------------
app.get('/api/app/sequences', (req, res) => res.json({ items: getDB().sequences }));

app.post('/api/app/sequences', (req, res) => {
  const seq = newSequence(req.body?.name, req.body?.steps || []);
  seq.id = id('seq');
  getDB().sequences.push(seq);
  save();
  res.json(seq);
});

app.post('/api/app/sequences/:id/enroll', (req, res) => {
  const seq = getDB().sequences.find((s) => s.id === req.params.id);
  if (!seq) return res.status(404).json({ error: 'sequence not found' });
  const contacts = req.body?.contacts || (req.body?.contact ? [req.body.contact] : []);
  const enrolled = contacts.map((c) => enroll(seq, c));
  save();
  res.json({ enrolled });
});

app.post('/api/app/sequences/:id/advance', (req, res) => {
  const seq = getDB().sequences.find((s) => s.id === req.params.id);
  if (!seq) return res.status(404).json({ error: 'sequence not found' });
  const out = advance(seq);
  save();
  res.json({ ...out, stats: seq.stats });
});

app.post('/api/app/dialer/call', (req, res) => {
  const contact = req.body?.contact || {};
  if (!contact.phone) return res.status(400).json({ error: 'contact.phone required (enrich the contact first)' });
  const call = placeCall(contact);
  getDB().calls.push(call);
  save();
  res.json(call);
});

// ----------------------------------------------------------------------------
// GAP: analytics dashboard
// ----------------------------------------------------------------------------
app.get('/api/app/analytics', (req, res) => {
  const d = getDB();
  const enrichEvents = d.events.filter((e) => e.type === 'enrich' || e.type === 'bulk_enrich' || e.type === 'reveal');
  let emails = 0, phones = 0, attempts = 0, found = 0, credits = 0;
  for (const e of d.events) {
    if (e.email) emails++;
    if (e.phone) phones++;
    if (e.creditsUsed) credits += e.creditsUsed;
  }
  for (const j of d.jobs) {
    if (j.type === 'single') { attempts++; if (j.status === 'enriched') found++; }
    if (j.type === 'bulk') { attempts += j.total; found += j.enriched; }
  }
  // provider win distribution
  const providerWins = {};
  for (const j of d.jobs) {
    const traces = j.type === 'single' ? [j] : (j.results || []);
    for (const t of traces) {
      if (t.emailProvider) providerWins[t.emailProvider] = (providerWins[t.emailProvider] || 0) + 1;
      if (t.phoneProvider) providerWins[t.phoneProvider] = (providerWins[t.phoneProvider] || 0) + 1;
    }
  }
  // credit usage over time (bucketed by event order)
  const series = d.events
    .filter((e) => e.creditsUsed)
    .map((e, i) => ({ t: i + 1, credits: e.creditsUsed }));
  res.json({
    hitRate: attempts ? Math.round((found / attempts) * 100) : 0,
    attempts, found, emails, phones,
    creditsUsed: getDB().account.creditsUsed,
    creditsRemaining: creditsRemaining(),
    providerWins: Object.entries(providerWins).map(([k, v]) => ({ provider: k, wins: v })).sort((a, b) => b.wins - a.wins),
    calls: d.calls.length,
    sequences: d.sequences.length,
    workflows: d.workflows.length,
    series,
    providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name })),
  });
});

// ----------------------------------------------------------------------------
// Public REST API v1 (key-protected) — mirrors FullEnrich's "automate via API"
// ----------------------------------------------------------------------------
app.post('/api/v1/enrich', requireApiKey, (req, res) => {
  const { wantEmail, wantPhone, ...input } = req.body || {};
  res.json(doEnrich(input, { wantEmail, wantPhone }));
});
app.get('/api/v1/credits', requireApiKey, (req, res) => res.json({ remaining: creditsRemaining() }));

// Serving layer over the canonical provider DB built by the pipeline. These
// routes do their own per-customer auth + billing (see provider-api.js), so the
// global requireApiKey is intentionally not applied here.
app.use('/api/v1', providerRouter());

// ----------------------------------------------------------------------------
// Candidate registry (opt-in, consent-based) — public intake for job-seekers.
// ----------------------------------------------------------------------------
app.get('/api/registry/meta', (req, res) => res.json({ consentText: CONSENT_TEXT, roles: ROLES, qualifications: QUALIFICATIONS }));

app.post('/api/registry/signup', async (req, res) => {
  try {
    const out = await signupCandidate(req.body || {});
    res.status(out.ok ? 200 : (out.status || 400)).json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/registry/withdraw', async (req, res) => {
  try {
    const { email, personId } = req.body || {};
    let pid = personId;
    if (!pid && email) {
      const row = await findPersonByEmail(email);
      pid = row?.id;
    }
    if (!pid) return res.status(404).json({ error: 'candidate not found' });
    res.json(await withdrawConsent(pid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/registry/stats', async (req, res) => {
  try { res.json(await registryStats()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------------------------------
// Static site + health
// ----------------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use(express.static(PUBLIC_DIR));
app.get('/app', (req, res) => res.sendFile(resolve(PUBLIC_DIR, 'app.html')));
app.get('/registry', (req, res) => res.sendFile(resolve(PUBLIC_DIR, 'registry.html')));
app.get('/universities', (req, res) => res.sendFile(resolve(PUBLIC_DIR, 'universities.html')));
app.get('/privacy', (req, res) => res.sendFile(resolve(PUBLIC_DIR, 'privacy.html')));
app.get('/admin', (req, res) => res.sendFile(resolve(PUBLIC_DIR, 'admin.html')));

// Listen only when running as a normal server (local, Render, Fly, Docker).
// On Vercel the app is imported as a serverless handler and must NOT listen.
if (!process.env.VERCEL) {
  ensureBoot()
    .catch((e) => console.error('provider DB bootstrap failed:', e.message))
    .finally(() => {
      app.listen(PORT, () => {
        // eslint-disable-next-line no-console
        console.log(`FullEnrich rebuild running → http://localhost:${PORT}  (marketing: /, app: /app)`);
      });
    });
}

export default app;
