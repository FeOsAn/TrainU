/**
 * Turns logged predictions-vs-actual-outcomes into a calibration verdict:
 * when this app said "confident," was it actually right more often than
 * when it said "unsure"? This is the mechanism the whole "moat" discussion
 * was about — it only means anything once real outcomes accumulate, which
 * is why it's a pure function taking records rather than reading the DB
 * itself (server/calibrationService.ts extracts records from outcomeLog and
 * calls this — keeps the math testable with synthetic data today, before
 * there's a single real athlete's worth of history to check it against).
 */

export interface CalibrationRecord {
  /** Fraction (0-1) of the prediction's inputs that were actually verified, not guessed. */
  confidenceRatio: number;
  /** The predicted probability of success, 0-100. */
  predictedProbability: number;
  actualSuccess: boolean;
}

export interface ConfidenceBucket {
  label: string;
  count: number;
  /** Fraction of this bucket where the predicted favorite side (probability >= 50) matched what actually happened. */
  accuracy: number;
  meanPredictedProbability: number;
}

export interface CalibrationReport {
  sampleSize: number;
  /** Mean squared error between probability/100 and the actual 0/1 outcome — 0 is perfect, lower is better. */
  brierScore: number | null;
  buckets: ConfidenceBucket[];
  /**
   * Multiply future confidence bands by this. >1 widens (historically
   * overconfident — accuracy came in below what the stated probabilities
   * implied), <1 narrows (historically underconfident), 1 = no adjustment
   * (not enough data yet, or already well-calibrated).
   */
  recommendedMultiplier: number;
  note: string;
}

/** Below this many resolved predictions, a calibration adjustment is more likely to be noise than signal. */
const MIN_SAMPLE_SIZE = 20;
/** A gap this small between implied and actual accuracy isn't worth reacting to. */
const CALIBRATION_GAP_THRESHOLD = 0.1;

function round(n: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function computeBuckets(records: CalibrationRecord[]): ConfidenceBucket[] {
  const defs: Array<{ label: string; test: (r: CalibrationRecord) => boolean }> = [
    { label: "mostly guessed inputs", test: (r) => r.confidenceRatio < 0.5 },
    { label: "mostly measured inputs", test: (r) => r.confidenceRatio >= 0.5 },
  ];
  const buckets: ConfidenceBucket[] = [];
  for (const { label, test } of defs) {
    const group = records.filter(test);
    if (group.length === 0) continue;
    const correct = group.filter((r) => (r.predictedProbability >= 50) === r.actualSuccess).length;
    buckets.push({
      label,
      count: group.length,
      accuracy: round(correct / group.length),
      meanPredictedProbability: round(
        group.reduce((s, r) => s + r.predictedProbability, 0) / group.length,
        1,
      ),
    });
  }
  return buckets;
}

export function computeCalibrationReport(records: CalibrationRecord[]): CalibrationReport {
  if (records.length === 0) {
    return { sampleSize: 0, brierScore: null, buckets: [], recommendedMultiplier: 1, note: "No resolved predictions yet." };
  }

  const brierScore = round(records.reduce((sum, r) => sum + (r.predictedProbability / 100 - (r.actualSuccess ? 1 : 0)) ** 2, 0) / records.length);
  const buckets = computeBuckets(records);

  if (records.length < MIN_SAMPLE_SIZE) {
    return {
      sampleSize: records.length,
      brierScore,
      buckets,
      recommendedMultiplier: 1,
      note: `Only ${records.length} resolved prediction${records.length === 1 ? "" : "s"} — need at least ${MIN_SAMPLE_SIZE} before trusting a calibration adjustment.`,
    };
  }

  // "Confident" = the model called it strongly one way or the other, not a coin flip.
  const confident = records.filter((r) => r.predictedProbability >= 70 || r.predictedProbability <= 30);
  if (confident.length < MIN_SAMPLE_SIZE) {
    return {
      sampleSize: records.length,
      brierScore,
      buckets,
      recommendedMultiplier: 1,
      note: `${records.length} resolved predictions, but only ${confident.length} were confident calls — need ${MIN_SAMPLE_SIZE} of those before adjusting bands.`,
    };
  }

  const correct = confident.filter((r) => (r.predictedProbability >= 50) === r.actualSuccess).length;
  const actualAccuracy = correct / confident.length;
  const impliedAccuracy = confident.reduce((s, r) => s + Math.max(r.predictedProbability, 100 - r.predictedProbability) / 100, 0) / confident.length;
  const gap = impliedAccuracy - actualAccuracy; // positive = overconfident (claimed more certainty than it delivered)

  let recommendedMultiplier = 1;
  let note = `Confident calls were right ${Math.round(actualAccuracy * 100)}% of the time, matching the implied ${Math.round(impliedAccuracy * 100)}% — well-calibrated, no adjustment.`;
  if (gap > CALIBRATION_GAP_THRESHOLD) {
    recommendedMultiplier = round(1 + gap, 2);
    note = `Confident calls were right only ${Math.round(actualAccuracy * 100)}% of the time vs. an implied ${Math.round(impliedAccuracy * 100)}% — widening future bands.`;
  } else if (gap < -CALIBRATION_GAP_THRESHOLD) {
    recommendedMultiplier = Math.max(0.5, round(1 + gap, 2));
    note = `Confident calls were right ${Math.round(actualAccuracy * 100)}% of the time, more than the implied ${Math.round(impliedAccuracy * 100)}% — narrowing future bands.`;
  }

  return { sampleSize: records.length, brierScore, buckets, recommendedMultiplier, note };
}
