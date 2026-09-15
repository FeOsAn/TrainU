/**
 * Turn logged evidence into Measured<T> athlete numbers. Adapted from
 * HyroxNga's calibration.ts — the one module in either sibling app that
 * already tracked provenance properly, just narrowly (running pace only).
 * Generalized here two ways:
 *
 *  1. Every output is a Measured<T> (shared/measured.ts) instead of an ad
 *     hoc {value, provenance} pair, so it composes with assessConfidence
 *     and every predictor's band-widening for free.
 *  2. calibrateBenchmark() replaces what would otherwise be eight near-
 *     identical per-station functions (or a per-1RM, per-CSS, per-FTP
 *     function) with one function parameterized by test id — any named,
 *     timed effort calibrates the same way.
 *
 * Nothing here is typed in. A value only becomes verified when there's a
 * real test or a hard effort behind it; until then the seed stands and says
 * so, which is the whole point.
 */

import { type Measured, measured, seeded } from "./measured";

export interface RunEvidence {
  date: string;
  sport: string;
  distanceKm: number | null;
  durationMinutes: number;
  avgPaceSecPerKm: number | null;
  avgHeartRate: number | null;
  maxHeartRate?: number | null;
  rpe: number | string | null;
}

export interface TestEvidence {
  testId: string;
  date: string;
  /** Seconds per km for run tests; seconds for a timed benchmark; kg for a strength test. */
  value: number;
}

export interface CalibratedRunning {
  runThresholdSecPerKm: Measured<number>;
  runEasySecPerKm: Measured<number>;
  run5kSecPerKm: Measured<number>;
  lthrBpm: Measured<number>;
  maxHrBpm: Measured<number>;
}

const RIEGEL = 0.06;
const FRESH_WINDOW_DAYS = 56;
const EASY_WINDOW_DAYS = 42;
const FIVE_K_WINDOW_DAYS = 84;
const HR_WINDOW_DAYS = 84;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function niceDate(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function fmtPace(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}/km`;
}

function paceOf(r: RunEvidence): number | null {
  if (r.avgPaceSecPerKm && r.avgPaceSecPerKm > 0) return r.avgPaceSecPerKm;
  if (r.distanceKm && r.distanceKm > 0 && r.durationMinutes > 0) return (r.durationMinutes * 60) / r.distanceKm;
  return null;
}

function rpeOf(r: RunEvidence): number | null {
  const n = typeof r.rpe === "string" ? parseFloat(r.rpe) : r.rpe;
  return n != null && Number.isFinite(n) ? n : null;
}

function isHard(r: RunEvidence, lthr: number): boolean {
  if (r.avgHeartRate && r.avgHeartRate > 0 && lthr > 0) return r.avgHeartRate >= 0.92 * lthr;
  const rpe = rpeOf(r);
  return rpe != null && rpe >= 8;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function calibrateRunning(
  seedThresholdSecPerKm: number,
  seedLthrBpm: number,
  seedMaxHrBpm: number,
  tests: TestEvidence[],
  runs: RunEvidence[],
  today: string,
): CalibratedRunning {
  const ageDays = (date: string) => daysBetween(date, today);
  const runsOnly = runs.filter((r) => r.sport === "run" && r.durationMinutes > 0);

  // ── Max and threshold heart rate first: the pace rules read them ─────────
  let maxHrBpm: Measured<number> = seeded(seedMaxHrBpm, "profile");
  for (const r of runsOnly) {
    if (ageDays(r.date) > HR_WINDOW_DAYS) continue;
    const peak = r.maxHeartRate ?? null;
    if (peak && peak > maxHrBpm.value && peak <= 230) {
      maxHrBpm = measured(Math.round(peak), `peak seen on ${niceDate(r.date)}`, r.date);
    }
  }

  let lthrBpm: Measured<number> = seeded(seedLthrBpm, "profile");
  const hardByHr = runsOnly.filter(
    (r) =>
      ageDays(r.date) <= HR_WINDOW_DAYS &&
      r.durationMinutes >= 20 &&
      r.avgHeartRate != null &&
      r.avgHeartRate > 0 &&
      isHard(r, lthrBpm.value),
  );
  if (hardByHr.length > 0) {
    const best = hardByHr.reduce((a, b) => (b.avgHeartRate! > a.avgHeartRate! ? b : a));
    const observed = Math.round(best.avgHeartRate!);
    // One hard run proves the threshold is AT LEAST what it averaged, never that it's lower.
    const candidate = hardByHr.length >= 2 ? observed : Math.max(lthrBpm.value, observed);
    if (candidate !== lthrBpm.value) {
      lthrBpm = measured(Math.min(candidate, Math.round(maxHrBpm.value * 0.95)), `${best.durationMinutes} min hard run on ${niceDate(best.date)}`, best.date);
    }
  }

  // ── The fresh kilometre ────────────────────────────────────────────────
  type Candidate = { secPerKm: number; date: string; note: string };
  const candidates: Candidate[] = [];
  for (const t of tests) {
    if (t.testId === "run_1k_tt" && t.value > 0) {
      candidates.push({ secPerKm: t.value, date: t.date, note: `1 km time trial, ${niceDate(t.date)}` });
    }
  }
  for (const r of runsOnly) {
    const pace = paceOf(r);
    if (!pace || !r.distanceKm || r.distanceKm < 1 || r.distanceKm > 15) continue;
    if (!isHard(r, lthrBpm.value)) continue;
    candidates.push({
      secPerKm: pace * Math.pow(r.distanceKm, -RIEGEL),
      date: r.date,
      note: `${Math.round(r.distanceKm * 10) / 10} km at ${fmtPace(pace)} on ${niceDate(r.date)}, projected to 1 km`,
    });
  }

  let runThresholdSecPerKm: Measured<number> = seeded(seedThresholdSecPerKm, "seed — not yet measured");
  const recent = candidates.filter((c) => ageDays(c.date) <= FRESH_WINDOW_DAYS);
  const pick = (pool: Candidate[]) => pool.reduce((a, b) => (b.secPerKm < a.secPerKm ? b : a));
  if (recent.length > 0) {
    const best = pick(recent);
    runThresholdSecPerKm = measured(Math.round(best.secPerKm), best.note, best.date);
  } else if (candidates.length > 0) {
    const latest = candidates.reduce((a, b) => (b.date > a.date ? b : a));
    runThresholdSecPerKm = measured(Math.round(latest.secPerKm), `${latest.note} (older than eight weeks — retest)`, latest.date);
  }

  // ── Easy pace ──────────────────────────────────────────────────────────
  const easyRuns = runsOnly.filter((r) => {
    if (ageDays(r.date) > EASY_WINDOW_DAYS || r.durationMinutes < 25 || !paceOf(r)) return false;
    if (r.avgHeartRate && r.avgHeartRate > 0) {
      const f = r.avgHeartRate / lthrBpm.value;
      return f >= 0.65 && f <= 0.8;
    }
    const rpe = rpeOf(r);
    return rpe != null && rpe <= 4;
  });
  let runEasySecPerKm: Measured<number> = measured(Math.round(runThresholdSecPerKm.value * 1.36), "derived from the kilometre");
  if (easyRuns.length >= 2) {
    runEasySecPerKm = measured(Math.round(median(easyRuns.map((r) => paceOf(r)!))), `median of ${easyRuns.length} easy runs in the last six weeks`);
  }

  // ── 5 km pace ──────────────────────────────────────────────────────────
  let run5kSecPerKm: Measured<number> = measured(Math.round(runThresholdSecPerKm.value * Math.pow(5, RIEGEL)), "derived from the kilometre");
  const fiveK = tests
    .filter((t) => t.testId === "run_5k_tt" && t.value > 0 && ageDays(t.date) <= FIVE_K_WINDOW_DAYS)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (fiveK) {
    run5kSecPerKm = measured(Math.round(fiveK.value), `5 km time trial, ${niceDate(fiveK.date)}`, fiveK.date);
  }

  return { runThresholdSecPerKm, runEasySecPerKm, run5kSecPerKm, lthrBpm, maxHrBpm };
}

/**
 * Generic replacement for a bespoke calibrateX() per named benchmark
 * (a HYROX station, an FTP test, a swim CSS test, a 1RM). Best recent
 * evidence wins; older-but-only evidence stands with a retest note; no
 * evidence at all leaves the caller's seed untouched.
 */
export function calibrateBenchmark(
  testId: string,
  seedValue: number,
  tests: TestEvidence[],
  today: string,
  windowDays = 84,
  betterIsLower = true,
): Measured<number> {
  const matches = tests.filter((t) => t.testId === testId && Number.isFinite(t.value) && t.value > 0);
  if (matches.length === 0) return seeded(seedValue, "seed — not yet measured");

  const ageDays = (date: string) => daysBetween(date, today);
  const recent = matches.filter((t) => ageDays(t.date) <= windowDays);
  const better = (a: TestEvidence, b: TestEvidence) => (betterIsLower ? (b.value < a.value ? b : a) : b.value > a.value ? b : a);

  if (recent.length > 0) {
    const best = recent.reduce(better);
    return measured(best.value, `measured, ${niceDate(best.date)}`, best.date);
  }
  const latest = matches.reduce((a, b) => (b.date > a.date ? b : a));
  return measured(latest.value, `measured, ${niceDate(latest.date)} (older than ${windowDays} days — retest)`, latest.date);
}
