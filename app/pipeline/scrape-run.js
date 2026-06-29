#!/usr/bin/env node
// Run your web-scrape connector through the pipeline.
//   node pipeline/scrape-run.js https://site.com/team https://site.com/about
//
// Scraped data is stored for YOUR use but is non-resellable (see the connector),
// so `node pipeline/run.js export` will not include it — that's intentional.
import { open, close } from './lib/db.js';
import { ingest } from './lib/pipeline.js';
import { WebScrapeConnector } from './connectors/web-scrape.js';

const seedUrls = process.argv.slice(2);
if (!seedUrls.length) {
  console.error('usage: node pipeline/scrape-run.js <url> [url...]');
  process.exit(1);
}

await open();
const conn = new WebScrapeConnector(seedUrls, { politeDelayMs: 2000 });
const stats = await ingest(conn.records(), conn.source, { enrich: false });
console.log('Scrape ingest complete:', JSON.stringify(stats, null, 2));
await close();
