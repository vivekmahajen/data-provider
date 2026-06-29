// Verifier interface (stage 6, pluggable). A verifier takes a contact value
// plus the person context and returns a verification verdict:
//   { status: valid|catch_all|risky|invalid|unverified, confidence: 0-100 }
//
// IMPORTANT compliance boundary: a verifier may only report on a value's
// validity. It must NOT return new contact values to be stored as resellable —
// discovering values is the enrichment stage's job, and those are flagged
// non-resellable. This keeps third-party providers (Apollo, etc.) in a
// "verify/enrich for your own use" lane, never a "resell their data" lane.

export class Verifier {
  name = 'base';
  // eslint-disable-next-line no-unused-vars
  async verify(kind, value, ctx) {
    throw new Error('verify() not implemented');
  }
}
