// FullEnrich rebuild — app dashboard client. Vanilla JS, no build step.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
function busy(btn, on) {
  if (!btn) return;
  if (on) { btn._html = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Working…'; }
  else { btn.disabled = false; btn.innerHTML = btn._html; }
}

// ---- Navigation ----
$$('.nav-item').forEach((item) => item.addEventListener('click', () => {
  $$('.nav-item').forEach((n) => n.classList.remove('active'));
  $$('.page').forEach((p) => p.classList.remove('active'));
  item.classList.add('active');
  $('#page-' + item.dataset.page).classList.add('active');
  if (item.dataset.page === 'analytics') loadAnalytics();
  if (item.dataset.page === 'sequences') loadSequences();
}));

// ---- Credits / account ----
async function refreshAccount() {
  const a = await api('/api/app/account');
  const total = a.creditsTotal + a.creditsRolloverFrom;
  const used = a.creditsUsed;
  $('#cr-text').textContent = `${a.creditsRemaining} / ${total}`;
  $('#cr-bar').style.width = Math.max(2, Math.round(((total - used) / total) * 100)) + '%';
  $('#cr-plan').textContent = `${a.plan} plan · email ${a.emailCost} cr · mobile ${a.phoneCost} cr`;
  $('#api-key').textContent = a.apiKey;
}

function verifyPill(v) {
  if (!v) return '';
  const map = { valid: ['s-valid', 'bg-valid', 'verified'], catch_all: ['s-catch', 'bg-catch', 'catch-all'], risky: ['s-bad', 'bg-bad', 'risky'] };
  const [cls, bg, label] = map[v.status] || map.risky;
  return `<span class="pill"><span class="dot ${bg}"></span> ${label} · ${v.confidence}%</span>`;
}

function renderEnrichResult(r) {
  if (r.status === 'insufficient_credits') return `<div class="card"><strong class="s-bad">Insufficient credits.</strong></div>`;
  const found = r.email || r.phone;
  return `<div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <strong>${esc(r.input.fullName || 'Contact')}</strong>
      <span class="pill">${found ? r.creditsUsed + ' credits' : 'no charge'}</span>
    </div>
    <table style="margin-top:.6rem;">
      <tr><td style="width:90px;">Email</td><td>${r.email ? `<span class="mono">${esc(r.email)}</span> ${verifyPill(r.emailVerification)} <span class="hint">via ${esc(r.emailProvider)}</span>` : '<span class="muted">not found</span>'}</td></tr>
      <tr><td>Mobile</td><td>${r.phone ? `<span class="mono">${esc(r.phone)}</span> <span class="hint">via ${esc(r.phoneProvider)}</span>` : '<span class="muted">not found</span>'}</td></tr>
    </table>
    <details style="margin-top:.6rem;"><summary class="hint" style="cursor:pointer;">Waterfall trace (${r.providersTried} providers tried)</summary>
      <div class="bars" style="margin-top:.5rem;">${(r.trace || []).map((t) => `<div class="b"><span>${esc(t.name)}</span><span class="track"></span><span>${t.email ? '✉️' : ''}${t.phone ? '📞' : ''}</span></div>`).join('')}</div>
    </details>
  </div>`;
}

// ---- Enrich ----
$('#e-run').addEventListener('click', async (e) => {
  busy(e.target, true);
  try {
    const r = await api('/api/app/enrich', { method: 'POST', body: JSON.stringify({
      fullName: $('#e-name').value, company: $('#e-company').value,
      domain: $('#e-domain').value, linkedinUrl: $('#e-li').value,
      wantEmail: $('#e-email').checked, wantPhone: $('#e-phone').checked,
    }) });
    $('#e-result').innerHTML = renderEnrichResult(r);
    if (r.phone) { $('#d-name').value = r.input.fullName; $('#d-phone').value = r.phone; }
    refreshAccount();
  } catch (err) { toast(err.message); }
  busy(e.target, false);
});

const SAMPLE_CSV = `fullName,company,domain
Jordan Patel,Northstar Labs,
Casey Nguyen,Brightwave,brightwave.com
Morgan Garcia,Quanta Systems,
Riley Kim,Lumen GTM,
Avery Singh,Cedar Analytics,`;
$('#b-sample').addEventListener('click', () => { $('#b-file')._sample = SAMPLE_CSV; toast('Sample list ready — click Enrich list'); });
$('#b-run').addEventListener('click', async (e) => {
  busy(e.target, true);
  try {
    let data;
    if ($('#b-file').files[0]) {
      const fd = new FormData(); fd.append('file', $('#b-file').files[0]);
      const res = await fetch('/api/app/enrich/bulk', { method: 'POST', body: fd });
      data = await res.json();
    } else if ($('#b-file')._sample) {
      const rows = SAMPLE_CSV.split('\n').slice(1).map((l) => { const [fullName, company, domain] = l.split(','); return { fullname: fullName, company, domain }; });
      data = await api('/api/app/enrich/bulk', { method: 'POST', body: JSON.stringify({ rows }) });
    } else { toast('Choose a CSV or use the sample list'); busy(e.target, false); return; }
    $('#b-result').innerHTML = `<div class="card"><strong>${data.enriched}/${data.total} enriched (${data.hitRate}% hit rate)</strong> · ${data.creditsUsed} credits
      <table style="margin-top:.6rem;"><thead><tr><th>Name</th><th>Email</th><th>Mobile</th></tr></thead><tbody>
      ${data.results.map((r) => `<tr><td>${esc(r.input.fullName)}</td><td class="mono">${r.email ? esc(r.email) : '<span class="muted">—</span>'}</td><td class="mono">${r.phone ? esc(r.phone) : '<span class="muted">—</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
    refreshAccount();
  } catch (err) { toast(err.message); }
  busy(e.target, false);
});

// ---- Search ----
async function loadFacets() {
  const d = await api('/api/app/search?pageSize=1');
  const sel = $('#s-industry');
  d.facets.industry.forEach((f) => { const o = document.createElement('option'); o.value = f.value; o.textContent = `${f.value} (${f.count})`; sel.appendChild(o); });
}
async function runSearch() {
  const qs = new URLSearchParams({ q: $('#s-q').value, title: $('#s-title').value, industry: $('#s-industry').value, location: $('#s-location').value, pageSize: 25 });
  const d = await api('/api/app/search?' + qs);
  $('#s-count').textContent = `${d.total} contacts`;
  $('#s-table tbody').innerHTML = d.items.map((c) => `<tr>
    <td><strong>${esc(c.fullName)}</strong></td><td>${esc(c.title)}</td><td>${esc(c.company)}</td><td>${esc(c.industry)}</td><td>${esc(c.location)}</td>
    <td>${c.email ? `<span class="mono">${esc(c.email)}</span>` : `<button class="btn btn-ghost btn-sm" data-reveal="${c.id}">Reveal</button>`}</td>
  </tr>`).join('');
  $$('#s-table [data-reveal]').forEach((b) => b.addEventListener('click', async () => {
    busy(b, true);
    try {
      const r = await api('/api/app/search/reveal', { method: 'POST', body: JSON.stringify({ id: b.dataset.reveal }) });
      b.closest('td').innerHTML = `<span class="mono">${esc(r.email || '—')}</span> ${verifyPill(r.emailVerification)}<br><span class="mono hint">${esc(r.phone || '')}</span>`;
      refreshAccount();
    } catch (err) { toast(err.message); busy(b, false); }
  }));
}
$('#s-run').addEventListener('click', runSearch);

// ---- Sequences ----
async function loadSequences() {
  const d = await api('/api/app/sequences');
  $('#seq-list').innerHTML = d.items.length ? d.items.map((s) => `<div class="card" style="margin-bottom:.7rem;">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <strong>${esc(s.name)}</strong><span class="pill">${s.steps.length} steps</span>
    </div>
    <div class="hint" style="margin:.4rem 0;">Enrolled ${s.stats.enrolled} · sent ${s.stats.sent} · opened ${s.stats.opened} · replied ${s.stats.replied}</div>
    <button class="btn btn-ghost btn-sm" data-enroll="${s.id}">Enroll 5 sample</button>
    <button class="btn btn-primary btn-sm" data-advance="${s.id}">Advance sends</button>
  </div>`).join('') : '<p class="hint">No sequences yet.</p>';
  $$('#seq-list [data-enroll]').forEach((b) => b.addEventListener('click', async () => {
    const sd = await api('/api/app/search?pageSize=5');
    const contacts = sd.items.map((c) => ({ id: c.id, fullName: c.fullName, firstName: c.firstName, company: c.company, email: `${c.firstName.toLowerCase()}@${c.domain}` }));
    await api(`/api/app/sequences/${b.dataset.enroll}/enroll`, { method: 'POST', body: JSON.stringify({ contacts }) });
    toast('Enrolled 5 contacts'); loadSequences();
  }));
  $$('#seq-list [data-advance]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api(`/api/app/sequences/${b.dataset.advance}/advance`, { method: 'POST', body: JSON.stringify({}) });
    toast(`Sent ${r.sent} emails`); loadSequences();
  }));
}
$('#seq-create').addEventListener('click', async (e) => {
  busy(e.target, true);
  try { await api('/api/app/sequences', { method: 'POST', body: JSON.stringify({ name: $('#seq-name').value || 'New sequence' }) }); toast('Sequence created'); loadSequences(); }
  catch (err) { toast(err.message); }
  busy(e.target, false);
});

// ---- Dialer ----
$('#d-call').addEventListener('click', async (e) => {
  if (!$('#d-phone').value) { toast('Enter or enrich a phone number first'); return; }
  busy(e.target, true);
  try {
    const c = await api('/api/app/dialer/call', { method: 'POST', body: JSON.stringify({ contact: { fullName: $('#d-name').value, phone: $('#d-phone').value } }) });
    const colors = { connected: 's-valid', voicemail: 's-catch', no_answer: 's-bad' };
    $('#d-log').insertAdjacentHTML('afterbegin', `<div class="card" style="margin-bottom:.5rem;"><strong>${esc(c.fullName || 'Contact')}</strong> <span class="mono hint">${esc(c.phone)}</span> → <span class="${colors[c.outcome]}">${c.outcome.replace('_', ' ')}</span>${c.durationSec ? ` · ${c.durationSec}s` : ''}</div>`);
  } catch (err) { toast(err.message); }
  busy(e.target, false);
});

// ---- AI Research ----
$$('.ai-preset').forEach((b) => b.addEventListener('click', () => { $('#ai-q').value = b.textContent; }));
$('#ai-run').addEventListener('click', async (e) => {
  busy(e.target, true);
  try {
    const r = await api('/api/app/ai-research', { method: 'POST', body: JSON.stringify({
      contact: { fullName: $('#ai-name').value, company: $('#ai-company').value, title: $('#ai-title').value }, question: $('#ai-q').value,
    }) });
    $('#ai-out').innerHTML = `<div class="card"><span class="badge">${esc(r.source)}</span><p style="margin:.6rem 0 0;">${esc(r.answer)}</p>${r.structured ? `<pre class="out" style="margin-top:.6rem;">${esc(JSON.stringify(r.structured, null, 2))}</pre>` : ''}</div>`;
  } catch (err) { toast(err.message); }
  busy(e.target, false);
});

// ---- Workflows ----
$('#wf-run').addEventListener('click', async (e) => {
  busy(e.target, true);
  try {
    const sd = await api('/api/app/search?pageSize=6');
    const rows = sd.items.map((c) => ({ fullName: c.fullName, company: c.company, domain: c.domain, title: c.title, industry: c.industry }));
    const wf = await api('/api/app/workflows', { method: 'POST', body: JSON.stringify({
      name: 'Sample workflow', rows,
      columns: [
        { key: 'domain', type: 'find_domain' },
        { key: 'email', type: 'enrich_email' },
        { key: 'mobile', type: 'enrich_phone' },
        { key: 'ai', type: 'ai_research', config: { question: $('#wf-q').value } },
      ],
    }) });
    const run = await api(`/api/app/workflows/${wf.id}/run`, { method: 'POST', body: JSON.stringify({}) });
    $('#wf-out').innerHTML = `<div class="card"><strong>Ran ${run.rows.length} rows</strong> · ${run.lastRun.creditsUsed} credits · ${run.lastRun.enriched} enrichments
      <table style="margin-top:.6rem;"><thead><tr><th>Name</th><th>Domain</th><th>Email</th><th>Mobile</th><th>AI research</th></tr></thead><tbody>
      ${run.rows.map((row) => `<tr>
        <td><strong>${esc(row.fullName)}</strong><br><span class="hint">${esc(row.title)}</span></td>
        <td class="mono">${esc(row._cells.domain || '—')}</td>
        <td class="mono">${row._cells.email?.email ? esc(row._cells.email.email) : '<span class="muted">—</span>'}</td>
        <td class="mono">${row._cells.mobile?.phone ? esc(row._cells.mobile.phone) : '<span class="muted">—</span>'}</td>
        <td style="max-width:320px;">${esc(row._cells.ai || '')}</td>
      </tr>`).join('')}
      </tbody></table></div>`;
    refreshAccount();
  } catch (err) { toast(err.message); }
  busy(e.target, false);
});

// ---- Analytics ----
async function loadAnalytics() {
  const a = await api('/api/app/analytics');
  $('#an-kpis').innerHTML = [
    ['Hit rate', a.hitRate + '%'], ['Attempts', a.attempts], ['Emails found', a.emails], ['Mobiles found', a.phones],
    ['Credits used', a.creditsUsed], ['Calls', a.calls],
  ].map(([l, n]) => `<div class="card kpi"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
  const max = Math.max(1, ...a.providerWins.map((p) => p.wins));
  $('#an-providers').innerHTML = a.providerWins.map((p) => `<div class="b"><span>${esc(p.provider)}</span><span class="track"><i style="width:${(p.wins / max) * 100}%"></i></span><span>${p.wins}</span></div>`).join('');
  $('#an-empty').textContent = a.providerWins.length ? '' : 'Run some enrichments to populate provider wins.';
  const sMax = Math.max(1, ...a.series.map((s) => s.credits));
  $('#an-series').innerHTML = a.series.slice(-12).map((s) => `<div class="b"><span>#${s.t}</span><span class="track"><i style="width:${(s.credits / sMax) * 100}%"></i></span><span>${s.credits}</span></div>`).join('') || '<span class="hint">No usage yet.</span>';
}
$('#an-refresh').addEventListener('click', loadAnalytics);

// ---- API page ----
async function setupApi() {
  const a = await api('/api/app/account');
  $('#api-curl').textContent = `curl -X POST ${location.origin}/api/v1/enrich \\
  -H "X-API-Key: ${a.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"fullName":"Jordan Patel","company":"Northstar Labs"}'`;
  $('#api-try').addEventListener('click', async (e) => {
    busy(e.target, true);
    try {
      const r = await api('/api/v1/enrich', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': a.apiKey }, body: JSON.stringify({ fullName: 'Jordan Patel', company: 'Northstar Labs' }) });
      $('#api-out').innerHTML = `<pre class="out">${esc(JSON.stringify({ email: r.email, phone: r.phone, status: r.status, creditsUsed: r.creditsUsed }, null, 2))}</pre>`;
      refreshAccount();
    } catch (err) { toast(err.message); }
    busy(e.target, false);
  });
  $('#api-search').addEventListener('click', async (e) => {
    busy(e.target, true);
    try {
      const r = await api('/api/v1/people/search?q=Sales&limit=3', { headers: { 'x-api-key': a.apiKey } });
      $('#api-search-out').innerHTML = `<pre class="out">${esc(JSON.stringify(r, null, 2))}</pre>`;
    } catch (err) { toast(err.message); }
    busy(e.target, false);
  });
}

// ---- Init ----
(async function init() {
  try { await refreshAccount(); await loadFacets(); await runSearch(); await setupApi(); }
  catch (err) { toast('Init error: ' + err.message); }
})();
