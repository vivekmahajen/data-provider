#!/usr/bin/env node
// CLI for the data pipeline.
//
//   node pipeline/run.js ingest <file.csv> [--type first_party|licensed|public_web] [--no-resale] [--enrich]
//   node pipeline/run.js stats
//   node pipeline/run.js export [limit]          # resale-safe contacts only
//   node pipeline/run.js reverify [batch]        # re-verify stale contacts
//   node pipeline/run.js suppress <value> [reason]
//   node pipeline/run.js erase <value>           # GDPR/CCPA erasure
//
import { open, all, get, close } from './lib/db.js';
import { ingest, reverifyStale } from './lib/pipeline.js';
import { exportableContacts, suppress, eraseValue } from './lib/compliance.js';
import { CSVConnector } from './connectors/csv.js';

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def;
}

async function main() {
  open();
  const cmd = process.argv[2];

  if (cmd === 'ingest') {
    const file = process.argv[3];
    if (!file) throw new Error('usage: ingest <file.csv>');
    const type = arg('--type', 'first_party');
    const resaleAllowed = arg('--no-resale', false) ? false : true;
    const enrich = !!arg('--enrich', false);
    const conn = new CSVConnector(file, { type, resaleAllowed });
    const stats = await ingest(conn.records(), conn.source, { enrich });
    console.log('Ingest complete:', JSON.stringify(stats, null, 2));
  } else if (cmd === 'stats') {
    printStats();
  } else if (cmd === 'export') {
    const rows = exportableContacts(Number(process.argv[3]) || 1000);
    console.log(`# ${rows.length} resale-safe contacts (verified, resale_ok, not suppressed)`);
    console.log('kind,value,status,confidence,full_name,title,company,domain');
    for (const r of rows) console.log([r.kind, r.value, r.status, r.confidence, r.full_name, r.title, r.company, r.domain].map((x) => x ?? '').join(','));
  } else if (cmd === 'reverify') {
    const n = await reverifyStale(Number(process.argv[3]) || 50);
    console.log(`Re-verified ${n} contacts.`);
  } else if (cmd === 'suppress') {
    suppress(process.argv[3], process.argv[4] || 'opt_out');
    console.log(`Suppressed ${process.argv[3]}.`);
  } else if (cmd === 'erase') {
    console.log(eraseValue(process.argv[3]));
  } else {
    console.log('commands: ingest <csv> [--type T] [--no-resale] [--enrich] | stats | export [n] | reverify [n] | suppress <v> [reason] | erase <v>');
  }
  close();
}

function printStats() {
  const counts = {
    sources: get('SELECT COUNT(*) n FROM sources').n,
    companies: get('SELECT COUNT(*) n FROM companies').n,
    people: get('SELECT COUNT(*) n FROM people').n,
    contacts: get('SELECT COUNT(*) n FROM contact_points').n,
    resaleSafe: get(`SELECT COUNT(*) n FROM contact_points WHERE resale_ok = 1 AND status IN ('valid','catch_all')`).n,
    suppressed: get('SELECT COUNT(*) n FROM suppressions').n,
    raw: get('SELECT COUNT(*) n FROM raw_records').n,
    rejected: get(`SELECT COUNT(*) n FROM raw_records WHERE status = 'rejected'`).n,
  };
  console.log('Database stats:', JSON.stringify(counts, null, 2));
  const byStatus = all('SELECT status, COUNT(*) n FROM contact_points GROUP BY status ORDER BY n DESC');
  console.log('Contacts by status:', byStatus.map((r) => `${r.status}=${r.n}`).join(', '));
  const bySource = all(`SELECT s.name, s.type, s.resale_allowed, COUNT(cp.id) n
                          FROM sources s LEFT JOIN contact_points cp ON cp.source_id = s.id
                         GROUP BY s.id ORDER BY n DESC`);
  console.log('Contacts by source:', bySource.map((r) => `${r.name}[${r.type},resale=${r.resale_allowed}]=${r.n}`).join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });
