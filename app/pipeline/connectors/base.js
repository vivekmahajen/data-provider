// Source-connector interface. A connector knows (a) how to describe its source
// — including the all-important resale_allowed flag — and (b) how to yield raw
// records one at a time (async iterator, so big sources stream rather than load
// into memory). Add a new source by subclassing this.

export class Connector {
  /** @param {{name:string,type:string,license?:string,resaleAllowed?:boolean}} source */
  constructor(source) {
    if (!source?.name || !source?.type) throw new Error('connector source needs { name, type }');
    this.source = {
      name: source.name,
      type: source.type, // first_party | licensed | public_web | third_party_verify
      license: source.license || null,
      resaleAllowed: !!source.resaleAllowed,
    };
  }

  // Override: yield plain objects (raw records).
  // eslint-disable-next-line require-yield
  async *records() {
    throw new Error('records() not implemented');
  }
}
