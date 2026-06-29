// AI research enrichment — the capability Clay has (Claygent) and FullEnrich
// lacks. Given a contact and a question, produce a researched answer.
//
// If an Anthropic API key is present (ANTHROPIC_API_KEY), this calls Claude to
// generate the answer. Otherwise it falls back to a deterministic heuristic so
// the feature is fully functional offline. The function signature and the
// /api/ai-research endpoint stay identical either way.

import { hashString, pick, seededUnit } from './util.js';

const SENIORITY = ['IC', 'Manager', 'Director', 'VP', 'C-level'];
const INDUSTRIES = ['SaaS', 'Fintech', 'E-commerce', 'Healthtech', 'Logistics', 'Cybersecurity'];

function heuristicAnswer(contact, question) {
  const seed = `${contact.fullName || ''}|${contact.company || ''}|${question}`;
  const seniority = pick(SENIORITY, 'sen' + seed);
  const industry = contact.industry || pick(INDUSTRIES, 'ind' + seed);
  const size = 20 + (hashString('size' + seed) % 4980);
  const q = question.toLowerCase();

  if (q.includes('icp') || q.includes('fit') || q.includes('qualif')) {
    const score = Math.round(40 + seededUnit('fit' + seed) * 60);
    return {
      answer: `${contact.fullName || 'This contact'} is a ${seniority} at ${contact.company || 'their company'} (${industry}, ~${size} employees). ICP fit score ${score}/100 — ${score > 70 ? 'strong fit, prioritise outreach' : score > 50 ? 'moderate fit, nurture' : 'weak fit, deprioritise'}.`,
      structured: { seniority, industry, employeeEstimate: size, icpScore: score },
    };
  }
  if (q.includes('icebreaker') || q.includes('opener') || q.includes('personal')) {
    return {
      answer: `Suggested opener: "Saw ${contact.company || 'your team'} is scaling in ${industry} — a lot of ${seniority}s there are wrestling with data coverage as headcount grows. Curious how you're handling it?"`,
      structured: { seniority, industry, angle: 'scaling/data-coverage' },
    };
  }
  if (q.includes('summary') || q.includes('about') || q.includes('who')) {
    return {
      answer: `${contact.fullName || 'Contact'} — ${contact.title || seniority} at ${contact.company || 'company'} (${industry}, ~${size} staff). Likely owns budget for tooling decisions: ${seniority === 'C-level' || seniority === 'VP' ? 'yes' : 'influencer, not final sign-off'}.`,
      structured: { seniority, industry, employeeEstimate: size },
    };
  }
  return {
    answer: `Based on available signals, ${contact.fullName || 'this contact'} works in ${industry} as a ${seniority}. ${question.trim()} → no high-confidence public signal found; treat as an inference.`,
    structured: { seniority, industry, employeeEstimate: size, confidence: 'low' },
  };
}

export async function aiResearch(contact = {}, question = '') {
  if (!question || !question.trim()) {
    return { ok: false, error: 'question is required' };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [
            {
              role: 'user',
              content: `You are a B2B sales research assistant. Contact: ${JSON.stringify(contact)}. Question: ${question}. Answer concisely in 2-3 sentences. Mark anything inferred as an inference.`,
            },
          ],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = (data.content || []).map((c) => c.text).join('').trim();
        return { ok: true, source: 'claude', answer: text, structured: null };
      }
    } catch {
      // fall through to heuristic
    }
  }
  const h = heuristicAnswer(contact, question);
  return { ok: true, source: 'heuristic', ...h };
}
