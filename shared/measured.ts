/**
 * Every physiological/performance input this app uses must carry its own
 * confidence, not just a value. This is the standard the two sibling apps
 * (sub5-dashboard, HyroxNga) arrived at ONLY for a couple of fields each
 * (sub5: ftpVerified bolted onto the predictor; HyroxNga: calibration.ts's
 * provenance strings, but only for running pace) after the gap caused a real
 * problem — an assumed bike aero position swinging a race prediction ~15
 * minutes with no indication it was a guess, and a defaulted
 * strengthEnduranceIndex (the single highest-leverage HYROX parameter per
 * that codebase's own comments) silently feeding a probability with full
 * apparent confidence.
 *
 * Here it's the type every input carries from day one, not a fix applied
 * field-by-field after something feels "off." Any predictor or plan
 * generator that reads a Measured<T> can (and should) factor `verified` into
 * the confidence it shows, instead of reinventing its own ad hoc flag.
 */

export interface Measured<T> {
  value: T;
  /** True only when backed by a real test, logged effort, or synced measurement — never a typed-in guess or an unmet default. */
  verified: boolean;
  /** Plain language: where this came from. "1 km time trial, 12 Oct" or "seed — not yet measured", never blank. */
  source: string;
  /** ISO date this value was last confirmed, if known. */
  asOf?: string;
}

export function measured<T>(value: T, source: string, asOf?: string): Measured<T> {
  return { value, verified: true, source, asOf };
}

export function seeded<T>(value: T, source = "seed — not yet measured"): Measured<T> {
  return { value, verified: false, source };
}

export function valueOf<T>(m: Measured<T>): T {
  return m.value;
}

export interface Confidence {
  verifiedCount: number;
  totalCount: number;
  /** Field names backing this prediction that are still guesses. Surface these in the UI, don't just widen a number silently. */
  unverifiedFields: string[];
}

export function assessConfidence(inputs: Record<string, Measured<unknown>>): Confidence {
  const entries = Object.entries(inputs);
  const unverified = entries.filter(([, m]) => !m.verified);
  return {
    verifiedCount: entries.length - unverified.length,
    totalCount: entries.length,
    unverifiedFields: unverified.map(([field]) => field),
  };
}

/**
 * Widen a base uncertainty band in proportion to how much of a prediction's
 * input is still guessed. A predictor built entirely on verified inputs gets
 * `base` back unchanged; one leaning on defaults gets a band wide enough to
 * stop the point estimate from reading as false precision.
 *
 * `calibrationMultiplier` is the Phase 6 feedback hook: shared/calibrationReport.ts
 * computes it from logged predictions-vs-actual-outcomes (was "confident"
 * actually right more often than not?) and the server threads it through —
 * this file stays a pure function with no DB access, so it takes the number
 * as a parameter rather than fetching it itself. Defaults to 1 (no
 * adjustment) so every existing caller is unaffected until it opts in.
 */
export function widenForConfidence(base: number, confidence: Confidence, calibrationMultiplier = 1): number {
  if (confidence.totalCount === 0) return Math.round(base * calibrationMultiplier);
  const guessedFraction = 1 - confidence.verifiedCount / confidence.totalCount;
  return Math.round(base * (1 + guessedFraction * 1.5) * calibrationMultiplier);
}
