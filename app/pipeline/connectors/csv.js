// CSV connector — the workhorse for first-party and licensed-feed ingestion.
// Point it at a file you OWN or have a resale license for; mark resaleAllowed
// accordingly. Columns are flexible (see normalize.js for accepted aliases).

import { readFileSync } from 'node:fs';
import { Connector } from './base.js';
import { parseCSV } from '../../server/lib/util.js';

export class CSVConnector extends Connector {
  /**
   * @param {string} filePath
   * @param {{name?:string,type?:string,license?:string,resaleAllowed?:boolean}} [source]
   */
  constructor(filePath, source = {}) {
    super({
      name: source.name || `csv:${filePath.split('/').pop()}`,
      type: source.type || 'first_party',
      license: source.license || 'owned / first-party opt-in',
      // first-party and licensed feeds are resellable; default true here, but a
      // caller importing a public-web scrape should pass resaleAllowed:false.
      resaleAllowed: source.resaleAllowed !== undefined ? source.resaleAllowed : true,
    });
    this.filePath = filePath;
  }

  async *records() {
    const rows = parseCSV(readFileSync(this.filePath, 'utf8'));
    for (const r of rows) yield r;
  }
}
