#!/usr/bin/env node
// Apply the schema to whichever backend is configured and report what's there.
//   SQLite (default):  node pipeline/migrate.js
//   Postgres:          DATABASE_URL=postgres://user:pass@host/db node pipeline/migrate.js
//
// open() applies the dialect-appropriate schema (schema.sql / schema.postgres.sql)
// on connect, so this is both the migration runner and a connectivity check.
import { open, dialect, get, close } from './lib/db.js';

await open();
console.log(`Connected. dialect = ${dialect()}`);
const tables = ['sources', 'companies', 'people', 'contact_points', 'provenance', 'suppressions', 'customers', 'payments'];
for (const t of tables) {
  const n = (await get(`SELECT COUNT(*) n FROM ${t}`)).n;
  console.log(`  ${t.padEnd(16)} ${n}`);
}
console.log('Schema is up to date.');
await close();
