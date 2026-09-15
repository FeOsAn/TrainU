import { eq } from "drizzle-orm";
import { db } from "./db";
import { outcomeLog } from "@shared/schema";
import { computeCalibrationReport, type CalibrationRecord, type CalibrationReport } from "@shared/calibrationReport";

/** Only prediction kinds that carry a goalProbability are meaningful for probability calibration — plan/strength/body-comp outcomes need their own comparison logic, not a shared one forced onto them. */
const PROBABILITY_KINDS = new Set(["prediction:run", "prediction:triathlon", "prediction:hyrox"]);

export class OutcomeNotFoundError extends Error {}

/** actual must include `achieved: boolean` for a probability-kind prediction to ever feed the calibration report — anything else is stored but simply won't be counted. */
export function recordOutcome(id: string, actual: unknown): void {
  const row = db.select().from(outcomeLog).where(eq(outcomeLog.id, id)).get();
  if (!row) throw new OutcomeNotFoundError(`No outcome logged with id ${id}`);
  db.update(outcomeLog)
    .set({ actualJson: JSON.stringify(actual), observedAt: new Date().toISOString() })
    .where(eq(outcomeLog.id, id))
    .run();
}

export function getCalibrationReport(): CalibrationReport {
  const rows = db.select().from(outcomeLog).all();
  const records: CalibrationRecord[] = [];

  for (const row of rows) {
    if (!row.actualJson || !PROBABILITY_KINDS.has(row.kind)) continue;
    try {
      const prediction = JSON.parse(row.predictionJson);
      const actual = JSON.parse(row.actualJson);
      if (typeof prediction?.goalProbability !== "number" || typeof actual?.achieved !== "boolean") continue;
      const confidence = prediction.confidence;
      const confidenceRatio = confidence?.totalCount > 0 ? confidence.verifiedCount / confidence.totalCount : 0;
      records.push({ confidenceRatio, predictedProbability: prediction.goalProbability, actualSuccess: actual.achieved });
    } catch {
      continue; // a malformed row is skipped, not fatal to the whole report
    }
  }

  return computeCalibrationReport(records);
}

/** What predictRunRace/predictTriathlon/predictHyrox should multiply their base band by right now. */
export function getCalibrationMultiplier(): number {
  return getCalibrationReport().recommendedMultiplier;
}
