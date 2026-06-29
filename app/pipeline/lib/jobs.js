// Minimal durable job queue for the re-verification scheduler. Backed by the
// jobs table so scheduled work survives restarts. In production swap for
// pg-boss / BullMQ / Temporal — same enqueue/runDue shape.

import { run, all, id, now } from './db.js';
import { reverifyStale } from './pipeline.js';

export async function enqueue(kind, payload = {}, delayMs = 0) {
  await run(`INSERT INTO jobs (id, kind, payload, run_after, status, attempts) VALUES (:id, :k, :p, :ra, 'queued', 0)`,
    { id: id(), k: kind, p: JSON.stringify(payload), ra: now() + delayMs });
}

// Schedule a recurring-style re-verification sweep.
export async function scheduleReverify(delayMs = 0, batch = 50) {
  await enqueue('reverify_sweep', { batch }, delayMs);
}

// Run all jobs whose run_after has passed. Returns a summary.
export async function runDue() {
  const due = await all(`SELECT * FROM jobs WHERE status = 'queued' AND run_after <= :t ORDER BY run_after ASC`, { t: now() });
  const summary = { ran: 0, reverified: 0 };
  for (const job of due) {
    let ok = true;
    let n = 0;
    try {
      if (job.kind === 'reverify_sweep') {
        n = await reverifyStale(JSON.parse(job.payload).batch || 50);
        summary.reverified += n;
      }
    } catch {
      ok = false;
    }
    await run(`UPDATE jobs SET status = :s, attempts = attempts + 1 WHERE id = :id`,
      { s: ok ? 'done' : 'failed', id: job.id });
    summary.ran++;
  }
  return summary;
}
