// Default offline verifier — deterministic, no network, no keys. Used in tests
// and whenever no real provider is configured.
import { Verifier } from './base.js';
import { verifyValue } from '../lib/verify.js';

export class SimulatedVerifier extends Verifier {
  name = 'simulated';
  async verify(kind, value) {
    return verifyValue(kind, value);
  }
}
