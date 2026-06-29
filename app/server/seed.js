// Seeds the JSON store (generates the searchable contact database, resets
// credits) so a fresh checkout has data. Safe to run repeatedly.
import { getDB, save } from './lib/store.js';

const db = getDB();
db.account.creditsUsed = 0;
db.jobs = [];
db.events = [];
db.calls = [];
db.sequences = [];
db.workflows = [];
save();
console.log(`Seeded ${db.contacts.length} contacts. Credits reset to ${db.account.creditsTotal}.`);
