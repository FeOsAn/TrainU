/**
 * CTL / ATL / TSB — the Banister impulse-response model, Coggan's Performance
 * Manager formulation. Ported from sub5-dashboard/HyroxNga's identical
 * engines (both apps independently converged on the same math), generalized
 * to the shared Sport union so one engine serves every goal type instead of
 * a triathlon copy and a HYROX copy that could drift apart.
 *
 *   CTL "fitness" = 42-day exponentially weighted average of daily TSS
 *   ATL "fatigue" =  7-day exponentially weighted average of daily TSS
 *   TSB "form"    = CTL − ATL
 *
 * Strength is excluded from the aerobic PMC (it doesn't produce the
 * adaptation CTL measures) but included in weekly/monthly total-work
 * figures. Hybrid/race/station efforts are priced from RPE first, not heart
 * rate — HR lags badly through a station and systematically underprices
 * exactly the sessions that hurt the most the next day (HyroxNga's finding).
 */

import { type AthleteParams, numericParams } from "./athlete";
import type { Sport } from "./session";

const CTL_TC = 42;
const ATL_TC = 7;
const CTL_DECAY = 1 - 1 / CTL_TC;
const ATL_DECAY = 1 - 1 / ATL_TC;

export interface DailyLoad {
  date: string;
  tss: number;
  ctl: number;
  atl: number;
  tsb: number;
}

export interface TrainingLoadSummary {
  currentCtl: number;
  currentAtl: number;
  currentTsb: number;
  tsbStatus: "peak" | "fresh" | "neutral" | "tired" | "overreached";
  tsbStatusLabel: string;
  rampRate: number;
  rampRateWarning: boolean;
  history: DailyLoad[];
  weeklyTss: number;
  monthlyTss: number;
  sportCtl: Record<Sport, number>;
  acwr: number;
  acwrStatus: "underloading" | "optimal" | "caution" | "high-risk";
}

const FRIEL_TSS_PER_HOUR: Record<string, number> = { Z1: 30, Z2: 55, Z3: 70, Z4: 90, Z5: 110 };

const SPORT_FALLBACK_PER_MIN: Record<Sport, number> = {
  run: 0.85,
  bike: 0.7,
  swim: 0.5,
  brick: 0.85,
  strength: 0.4,
  hybrid: 1.15,
  race: 1.5,
  station: 0.8,
  other: 0.6,
};

const ALL_SPORTS: Sport[] = ["run", "bike", "swim", "brick", "strength", "hybrid", "race", "station", "other"];

export interface SessionForTss {
  sport: Sport;
  durationMinutes: number;
  tss?: number | null;
  avgHeartRate?: number | null;
  avgPaceSecPerKm?: number | null;
  avgPaceSecPer100m?: number | null;
  avgPowerWatts?: number | null;
  normalizedPower?: number | null;
  hrZonesJson?: string | null;
  rpe?: number | string | null;
}

export function zoneWeightedHrTss(hrZonesJson: string | null | undefined): number | null {
  if (!hrZonesJson) return null;
  try {
    const zones = JSON.parse(hrZonesJson);
    if (!Array.isArray(zones) || zones.length === 0) return null;
    let tss = 0;
    let zonedSecs = 0;
    for (const z of zones) {
      const secs = Number(z?.secs_in_zone);
      const weight = FRIEL_TSS_PER_HOUR[String(z?.zone).toUpperCase()];
      if (!Number.isFinite(secs) || secs <= 0 || weight == null) continue;
      tss += (secs / 3600) * weight;
      zonedSecs += secs;
    }
    if (zonedSecs < 300) return null; // under 5 min zoned = the strap dropped out, not a signal
    return Math.round(tss);
  } catch {
    return null;
  }
}

/** Session-RPE (Foster), anchored at RPE 7 ≈ threshold (100/h). Flattens above 7 — an hour at RPE 10 is not twice threshold. */
export function rpeTssPerHour(rpe: number): number {
  if (rpe <= 7) return (rpe / 7) * (rpe / 7) * 100;
  return 100 + (rpe - 7) * 7;
}

export function estimateSessionTss(session: SessionForTss, athlete: AthleteParams): number {
  if (session.tss && session.tss > 0) return Math.round(session.tss);

  const { lthrBpm, runThresholdSecPerKm, ftpWatts, cssSecPer100m } = numericParams(athlete);
  const dur = session.durationMinutes;
  const durSec = dur * 60;
  const sport = session.sport;

  const hrTss = (): number | null => {
    const zoned = zoneWeightedHrTss(session.hrZonesJson);
    if (zoned != null) return zoned;
    if (session.avgHeartRate && session.avgHeartRate > 0) {
      const hr = session.avgHeartRate;
      return Math.round(((durSec * hr * hr) / (lthrBpm * lthrBpm * 3600)) * 100);
    }
    return null;
  };

  const rpeTss = (): number | null => {
    const r = typeof session.rpe === "string" ? parseFloat(session.rpe) : session.rpe;
    if (r == null || !Number.isFinite(r) || r < 1 || r > 10) return null;
    return Math.round((dur / 60) * rpeTssPerHour(r));
  };

  if (sport === "strength") {
    // Deliberately not hrTss: gym heart rate tracks rest intervals, not mechanical work.
    return Math.round(dur * SPORT_FALLBACK_PER_MIN.strength);
  }

  if (sport === "bike") {
    if (session.normalizedPower && ftpWatts > 0) {
      const np = session.normalizedPower;
      const ifactor = np / ftpWatts;
      return Math.round(((durSec * np * ifactor) / (ftpWatts * 3600)) * 100);
    }
    if (session.avgPowerWatts && ftpWatts > 0) {
      const np = session.avgPowerWatts * 1.05;
      const ifactor = np / ftpWatts;
      return Math.round(((durSec * np * ifactor) / (ftpWatts * 3600)) * 100);
    }
    const h = hrTss();
    if (h != null) return h;
    return rpeTss() ?? Math.round(dur * SPORT_FALLBACK_PER_MIN.bike);
  }

  if (sport === "run") {
    const h = hrTss();
    if (h != null) return h;
    if (session.avgPaceSecPerKm && runThresholdSecPerKm) {
      const paceRatio = runThresholdSecPerKm / session.avgPaceSecPerKm;
      return Math.round((dur / 60) * paceRatio * paceRatio * 100);
    }
    return rpeTss() ?? Math.round(dur * SPORT_FALLBACK_PER_MIN.run);
  }

  if (sport === "swim") {
    // Never heart rate: wrist-optical HR in water is known-bad (motion artifact + cold-water vasoconstriction).
    if (session.avgPaceSecPer100m && session.avgPaceSecPer100m > 0 && cssSecPer100m > 0) {
      const IF = cssSecPer100m / session.avgPaceSecPer100m;
      return Math.round((durSec / 3600) * IF * IF * 100);
    }
    return rpeTss() ?? Math.round(dur * SPORT_FALLBACK_PER_MIN.swim);
  }

  if (sport === "hybrid" || sport === "race") {
    // Reported effort beats heart rate here: HR lags badly through a station,
    // systematically underpricing exactly the sessions that hurt most the next day.
    const r = rpeTss();
    if (r != null) return Math.round(r * 1.1);
    const h = hrTss();
    if (h != null) return Math.round(h * 1.15);
    return Math.round(dur * SPORT_FALLBACK_PER_MIN[sport]);
  }

  const h = hrTss();
  if (h != null) return h;
  return rpeTss() ?? Math.round(dur * (SPORT_FALLBACK_PER_MIN[sport] ?? SPORT_FALLBACK_PER_MIN.other));
}

function isUsableDate(d: unknown): d is string {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function emptySummary(): TrainingLoadSummary {
  return {
    currentCtl: 0,
    currentAtl: 0,
    currentTsb: 0,
    tsbStatus: "neutral",
    tsbStatusLabel: "No data yet",
    rampRate: 0,
    rampRateWarning: false,
    history: [],
    weeklyTss: 0,
    monthlyTss: 0,
    sportCtl: Object.fromEntries(ALL_SPORTS.map((s) => [s, 0])) as Record<Sport, number>,
    acwr: 1,
    acwrStatus: "optimal",
  };
}

export function computeTrainingLoad(
  sessions: Array<SessionForTss & { date: string }>,
  athlete: AthleteParams,
  today: string = new Date().toISOString().slice(0, 10),
): TrainingLoadSummary {
  const usable = sessions.filter((s) => isUsableDate(s.date) && s.date <= today);
  if (usable.length === 0) return emptySummary();

  const aerobicByDate = new Map<string, number>();
  const totalByDate = new Map<string, number>();
  const sportByDate: Record<Sport, Map<string, number>> = Object.fromEntries(
    ALL_SPORTS.map((s) => [s, new Map<string, number>()]),
  ) as Record<Sport, Map<string, number>>;

  const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  for (const s of usable) {
    const tss = estimateSessionTss(s, athlete);
    if (!Number.isFinite(tss)) continue; // a non-finite TSS would otherwise poison every EWMA downstream
    bump(totalByDate, s.date, tss);
    bump(sportByDate[s.sport], s.date, tss);
    if (s.sport === "strength") continue; // strength stays out of the aerobic PMC
    bump(aerobicByDate, s.date, tss);
  }

  const startDate = Array.from(totalByDate.keys()).sort()[0];
  if (!startDate) return emptySummary();

  const history: DailyLoad[] = [];
  let ctl = 0;
  let atl = 0;
  const sportCtl: Record<Sport, number> = Object.fromEntries(ALL_SPORTS.map((s) => [s, 0])) as Record<Sport, number>;

  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${today}T00:00:00Z`);

  while (cursor <= end) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const tss = aerobicByDate.get(dateStr) ?? 0;

    ctl = ctl * CTL_DECAY + tss / CTL_TC;
    atl = atl * ATL_DECAY + tss / ATL_TC;
    for (const sport of ALL_SPORTS) {
      sportCtl[sport] = sportCtl[sport] * CTL_DECAY + (sportByDate[sport].get(dateStr) ?? 0) / CTL_TC;
    }

    history.push({ date: dateStr, tss, ctl: round1(ctl), atl: round1(atl), tsb: round1(ctl - atl) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const latest = history[history.length - 1]!;
  const { tsbStatus, tsbStatusLabel } = interpretTsb(latest.tsb);
  const weekAgo = history[Math.max(0, history.length - 8)];
  const rampRate = weekAgo ? round1(latest.ctl - weekAgo.ctl) : 0;

  const dates = history.map((h) => h.date);
  const sumOver = (n: number) => Math.round(dates.slice(-n).reduce((s, d) => s + (totalByDate.get(d) ?? 0), 0));

  const acwr = history.length >= 14 && latest.ctl > 0 ? round1(latest.atl / latest.ctl) : 1;

  return {
    currentCtl: latest.ctl,
    currentAtl: latest.atl,
    currentTsb: latest.tsb,
    tsbStatus,
    tsbStatusLabel,
    rampRate,
    rampRateWarning: rampRate > 8,
    history,
    weeklyTss: sumOver(7),
    monthlyTss: sumOver(28),
    sportCtl: Object.fromEntries(ALL_SPORTS.map((s) => [s, round1(sportCtl[s])])) as Record<Sport, number>,
    acwr,
    acwrStatus: acwr < 0.8 ? "underloading" : acwr <= 1.3 ? "optimal" : acwr <= 1.5 ? "caution" : "high-risk",
  };
}

function interpretTsb(tsb: number): { tsbStatus: TrainingLoadSummary["tsbStatus"]; tsbStatusLabel: string } {
  if (tsb >= 15) return { tsbStatus: "peak", tsbStatusLabel: "Peak form — race ready" };
  if (tsb >= 5) return { tsbStatus: "fresh", tsbStatusLabel: "Fresh — good day for quality" };
  if (tsb >= -10) return { tsbStatus: "neutral", tsbStatusLabel: "Neutral — productive training" };
  if (tsb >= -25) return { tsbStatus: "tired", tsbStatusLabel: "Fatigued — manage intensity" };
  return { tsbStatus: "overreached", tsbStatusLabel: "Overreached — recovery is mandatory" };
}

/**
 * Walk planned TSS forward through the same EWMA recursion: "if the plan is
 * executed from today, what form does it arrive at the goal date in?" A flat
 * daily TSS instead would simulate quitting training and produce a fictional
 * projection.
 */
export function projectFormOverPlan(
  currentCtl: number,
  currentAtl: number,
  fromDate: string,
  targetDate: string,
  tssByDate: Map<string, number>,
): { ctl: number; atl: number; tsb: number } {
  let ctl = currentCtl;
  let atl = currentAtl;
  const cursor = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${targetDate}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + 1); // today's load is already banked

  while (cursor <= end) {
    const tss = tssByDate.get(cursor.toISOString().slice(0, 10)) ?? 0;
    ctl = ctl * CTL_DECAY + tss / CTL_TC;
    atl = atl * ATL_DECAY + tss / ATL_TC;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { ctl: round1(ctl), atl: round1(atl), tsb: round1(ctl - atl) };
}
