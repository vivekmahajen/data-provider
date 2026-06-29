// Minimal durable job queue for the re-verification scheduler. Backed by the
// jobs table so scheduled work survives restarts. In production swap for
// pg-boss / BullMQ / Temporal — same enqueue/runDue shape.

import { run, all, id, now } from './db.js';
import { reverifyStale } from './pipeline.js';

export function enqueue(kind, payload = {}, delayMs = 0) {
  run(`INSERT INTO jobs (id, kind, payload, run_after, status, attempts) VALUES (:id, :k, :p, :ra, 'queued', 0)`,
    { id: id(), k: kind, p: JSON.stringify(payload), ra: now() + delayMs });
}

// Schedule a recurring-style re-verification sweep.
export function scheduleReverify(delayMs = 0, batch = 50) {
  enqueue('reverify_sweep', { batch }, delayMs);
}

// Run all jobs whose run_after has passed. Returns a summary.
export function runDue() {
  const due = all(`SELECT * FROM jobs WHERE status = 'queued' AND run_after <= :t ORDER BY run_after ASC`, { t: now() });
  const summary = { ran: 0, reverified: 0 };
  for (const job of due) {
    let ok = true;
    let n = 0;
    try {
      if (job.kind === 'reverify_sweep') {
        n = reverifyStale(JSON.parse(job.payload).batch || 50);
        summary.reverified += n;
      }
    } catch {
      ok = false;
    }
    run(`UPDATE jobs SET status = :s, attempts = attempts + 1 WHERE id = :id`,
      { s: ok ? 'done' : 'failed', id: job.id });
    summary.ran++;
  }
  return summary;
}
