// Verifier selection. Choose with VERIFIER=apollo|simulated; defaults to apollo
// when APOLLO_API_KEY is present, otherwise the offline simulated verifier.
// Falls back to simulated if the chosen provider can't initialise.

import { SimulatedVerifier } from './simulated.js';
import { ApolloVerifier } from './apollo.js';

let _cached = null;

export function getVerifier() {
  if (_cached) return _cached;
  const choice = (process.env.VERIFIER || '').toLowerCase();
  const wantApollo = choice === 'apollo' || (choice === '' && !!process.env.APOLLO_API_KEY);
  if (wantApollo) {
    try { _cached = new ApolloVerifier(); return _cached; }
    catch { /* no key → fall through */ }
  }
  _cached = new SimulatedVerifier();
  return _cached;
}

// Test/CLI helper to reset the memoised verifier (e.g. after changing env).
export function resetVerifier() { _cached = null; }
