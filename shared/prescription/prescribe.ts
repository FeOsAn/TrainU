/**
 * Turns an arbitrated week — which says only "0.93x load, deficit, these
 * goals are in these phases" — into actual sessions with actual numbers.
 *
 * The novel part, and the reason neither sibling app has this shape: it
 * prescribes for SEVERAL goals at once. Two goals that both want an easy run
 * get ONE easy run serving both, not two, because the promise is a coherent
 * plan rather than two plans stapled together. Slots are handed out
 * interleaved by priority, so the goal that matters most gets more of the
 * week without the others vanishing.
 *
 * Deterministic on purpose: same inputs, same week, every time. It is
 * recomputed rather than stored, unit tested, and a coaching change shows up
 * as a diff. The model's job is to phrase and adapt these — never to invent
 * them.
 */

import { FRESH_KM_TO_INTERVAL, FRESH_KM_TO_THRESHOLD, type AthleteParams } from "../athlete";
import { type Goal, defaultDiscipline } from "../goal";
import type { ArbitratedWeek } from "../arbitration/arbitrate";
import { estimateSessionTss } from "../trainingLoad";
import type { Sport } from "../session";
import { BASELINE_MINUTES_PER_DAY, DEFAULT_PHASE_SHAPE, DOWNGRADE, KIND_MINUTES, PHASE_SHAPES, applyCeiling, qualitiesFor, ANCHOR_KIND, kindWeight } from "./templates";
import type { PlannedSession, PlannedSport, PrescribedWeek, SessionKind } from "./sessionKinds";

// FRESH_KM_TO_THRESHOLD / FRESH_KM_TO_INTERVAL live in shared/athlete.ts,
// next to the field they convert — see the note there about the predictor
// and the plan engine disagreeing about the same number.

/** A lift is 45-60 minutes whether the aerobic week is big or small, so it doesn't scale with the aerobic budget. */
const STRENGTH_MINUTES = 50;

const STRENGTH_KINDS: ReadonlySet<SessionKind> = new Set(["strength_lower", "strength_push", "strength_pull"]);

const SPORT_OF: Record<SessionKind, PlannedSport> = {
  run_easy: "run",
  run_long: "run",
  run_threshold: "run",
  run_intervals: "run",
  bike_endurance: "bike",
  swim_technique: "swim",
  compromised: "hybrid",
  station_work: "station",
  strength_lower: "strength",
  strength_push: "strength",
  strength_pull: "strength",
  rest: "other",
};

const INTENSITY_OF: Record<SessionKind, PlannedSession["intensity"]> = {
  run_easy: "easy",
  run_long: "moderate",
  run_threshold: "hard",
  run_intervals: "hard",
  bike_endurance: "easy",
  swim_technique: "easy",
  compromised: "hard",
  station_work: "moderate",
  strength_lower: "moderate",
  strength_push: "moderate",
  strength_pull: "moderate",
  rest: "rest",
};

const HARD_KINDS: ReadonlySet<SessionKind> = new Set(["run_threshold", "run_intervals", "compromised"]);

function pace(secPerKm: number): string {
  return `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, "0")}/km`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface PrescribeOptions {
  /** How many days a week the athlete can actually train. */
  daysPerWeek?: number;
}

interface Demand {
  goalId: string;
  goalLabel: string;
  kind: SessionKind;
  /** Lower sorts earlier. (position + 1) / weight interleaves goals by priority deterministically. */
  cost: number;
  priority: number;
}

/**
 * Hand out the week's slots. Each goal's qualities are charged
 * (position + 1) / weight, so a priority-1 goal's third-most-important
 * quality still outranks a priority-3 goal's first — which is exactly what
 * "priority" is supposed to mean. Ties break on priority then goal id so the
 * result never depends on map ordering.
 */
function buildDemands(week: ArbitratedWeek, goals: Goal[]): Demand[] {
  const demands: Demand[] = [];
  for (const phase of week.goalPhases) {
    if (phase.phaseName === "past") continue;
    const goal = goals.find((g) => g.id === phase.goalId);
    if (!goal) continue;
    const weight = 1 / Math.max(1, goal.priority);
    qualitiesFor(phase.goalType, goal.discipline).forEach((kind, index) => {
      demands.push({ goalId: goal.id, goalLabel: phase.goalLabel, kind, cost: (index + 1) / weight, priority: goal.priority });
    });
  }
  return demands.sort((a, b) => a.cost - b.cost || a.priority - b.priority || a.goalId.localeCompare(b.goalId));
}

function targetsFor(kind: SessionKind, athlete: AthleteParams, minutes: number): string[] {
  const freshKm = athlete.runThresholdSecPerKm.value;
  const easy = athlete.runEasySecPerKm.value;
  const threshold = Math.round(freshKm * FRESH_KM_TO_THRESHOLD);
  const interval = Math.round(freshKm * FRESH_KM_TO_INTERVAL);
  const pct = (oneRm: number, fraction: number) => `${Math.round((oneRm * fraction) / 2.5) * 2.5} kg`;

  switch (kind) {
    case "run_easy":
      return [`${pace(easy)} — conversational, nose-breathing`, `${minutes} min continuous`];
    case "run_long":
      return [`${pace(easy)} for the bulk of it`, `${minutes} min`, "Last 10 min steady if it still feels easy"];
    case "run_threshold":
      return [`${pace(threshold)} at threshold`, `3 × 10 min, 2 min jog between`, "15 min warm-up and cool-down either side"];
    case "run_intervals":
      return [`${pace(interval)} on the reps`, `6 × 3 min, 2 min jog between`, "Cut the session if the pace drops off, don't grind it out"];
    case "compromised":
      return [`Run at ${pace(threshold)} off the station, not fresh pace`, "4 rounds: 1 km run + 1 station, no rest between", "The point is the first 200 m off the sled — that's the race"];
    case "station_work":
      return ["Rotate the two stations you're worst at", `${minutes} min, quality over clock`, "Full-distance efforts, not fragments"];
    case "bike_endurance":
      return [`${Math.round(athlete.ftpWatts.value * 0.65)}-${Math.round(athlete.ftpWatts.value * 0.75)} W`, `${minutes} min steady`];
    case "swim_technique":
      return [`${Math.floor(athlete.cssSecPer100m.value / 60)}:${String(Math.round(athlete.cssSecPer100m.value % 60)).padStart(2, "0")}/100m at CSS`, "Drill-focused: 200 m drill / 200 m swim"];
    case "strength_lower":
      return [`Back squat 4 × 5 @ ${pct(athlete.squat1RmKg.value, 0.8)}`, `Romanian deadlift 3 × 8 @ ${pct(athlete.deadlift1RmKg.value, 0.6)}`, "Split squats 3 × 10 each side"];
    case "strength_push":
      return [`Bench press 4 × 5 @ ${pct(athlete.bench1RmKg.value, 0.78)}`, `Overhead press 3 × 6 @ ${pct(athlete.ohp1RmKg.value, 0.7)}`, "Dips 3 × max-2"];
    case "strength_pull":
      return [`Deadlift 3 × 5 @ ${pct(athlete.deadlift1RmKg.value, 0.8)}`, "Pull-ups 4 × max-2", "Barbell row 3 × 8"];
    case "rest":
      return ["Full rest"];
  }
}

const TITLE_OF: Record<SessionKind, string> = {
  run_easy: "Easy run",
  run_long: "Long run",
  run_threshold: "Threshold run",
  run_intervals: "Intervals",
  bike_endurance: "Endurance ride",
  swim_technique: "Swim — technique",
  compromised: "Compromised running",
  station_work: "Station work",
  strength_lower: "Strength — lower",
  strength_push: "Strength — push",
  strength_pull: "Strength — pull",
  rest: "Rest",
};

const FOCUS_OF: Record<SessionKind, string> = {
  run_easy: "Aerobic volume that costs almost nothing to recover from.",
  run_long: "The single highest-return session for any distance goal.",
  run_threshold: "Raises the pace you can hold before it falls apart.",
  run_intervals: "Top-end. Small doses, fully recovered.",
  bike_endurance: "Aerobic volume with no impact cost.",
  swim_technique: "Swimming is technique-limited long before it's fitness-limited.",
  compromised: "Running well on legs that have just been wrecked — the race, not a run.",
  station_work: "Time under the exact loads race day will ask for.",
  strength_lower: "Raises the ceiling every endurance quality sits under.",
  strength_push: "Upper-body pressing strength and shoulder durability.",
  strength_pull: "Posterior chain and grip — the two things that quietly cap everything.",
  rest: "Adaptation happens here, not in the sessions.",
};

/**
 * Lay the week out so hard days don't stack. The long session goes to
 * Saturday (day 5), and hard sessions are spread across the remaining days
 * as evenly as the count allows rather than landing back to back.
 */
function assignDates(weekStart: string, kinds: SessionKind[]): string[] {
  const HARD_FIRST_CHOICE = [1, 3, 5, 0, 2, 4, 6];
  const EASY_FIRST_CHOICE = [0, 2, 4, 6, 1, 3, 5];
  const taken = new Set<number>();
  const offsets: number[] = new Array(kinds.length);

  kinds.forEach((kind, i) => {
    if (kind === "run_long") {
      offsets[i] = 5;
      taken.add(5);
    }
  });

  kinds.forEach((kind, i) => {
    if (offsets[i] !== undefined) return;
    const order = HARD_KINDS.has(kind) ? HARD_FIRST_CHOICE : EASY_FIRST_CHOICE;
    const slot = order.find((d) => !taken.has(d)) ?? order.find(() => true)!;
    taken.add(slot);
    offsets[i] = slot;
  });

  return offsets.map((o) => addDays(weekStart, o));
}

export function prescribeWeek(week: ArbitratedWeek, goals: Goal[], athlete: AthleteParams, options: PrescribeOptions = {}): PrescribedWeek {
  const daysPerWeek = Math.min(7, Math.max(3, options.daysPerWeek ?? 5));

  // Shape comes from the highest-priority live goal; SIZE comes from the
  // arbitrated multiplier, which already blended every goal's phase.
  const livePhases = week.goalPhases.filter((p) => p.phaseName !== "past");
  const dominant = livePhases
    .map((phase) => ({ phase, goal: goals.find((g) => g.id === phase.goalId) }))
    .filter((entry) => entry.goal)
    .sort((a, b) => a.goal!.priority - b.goal!.priority || a.goal!.targetDate.localeCompare(b.goal!.targetDate))[0];
  const shape = dominant ? (PHASE_SHAPES[dominant.phase.phaseName] ?? DEFAULT_PHASE_SHAPE) : DEFAULT_PHASE_SHAPE;
  // The dominant goal sets the week's discipline as well as its phase: a
  // triathlete's week is shaped around the bike even when a second, lower-
  // priority goal contributes run and strength slots to it.
  const discipline = dominant?.goal ? (dominant.goal.discipline ?? defaultDiscipline(dominant.goal.type)) : "other";

  if (livePhases.length === 0) {
    return { weekStart: week.date, sessions: [], totalMinutes: 0, totalTss: 0, loadMultiplier: week.loadMultiplier, note: "No active goals — nothing to prescribe." };
  }

  // ── Slot allocation, merging duplicates so one session can serve two goals ──
  const picked: Array<{ kind: SessionKind; goalIds: string[]; goalLabels: string[] }> = [];
  for (const demand of buildDemands(week, goals)) {
    let kind = applyCeiling(demand.kind, shape.intensityCeiling);
    /*
     * A phase ceiling collapses several qualities onto the same kind — in a
     * base week both the intervals slot and the threshold slot come out as
     * "threshold". Left alone that hands a base week two threshold runs,
     * which is an artifact of the downgrade rather than anything a coach
     * decided. Step it down again so the surplus intensity becomes aerobic
     * volume, which is what a base week actually wants. Easy runs are exempt
     * — a goal listing two of those means it wants two.
     */
    while (HARD_KINDS.has(kind) && picked.some((p) => p.kind === kind && p.goalIds.includes(demand.goalId))) {
      const next = DOWNGRADE[kind];
      if (!next || next === kind) break;
      kind = next;
    }
    /*
     * Merge ACROSS goals only. An existing session of this kind that doesn't
     * already serve this goal can serve it too — that's the coherent-plan
     * promise. But a goal listing `run_easy` twice is asking for a SECOND
     * easy run, which is where a distance plan's volume actually comes from;
     * collapsing that into the first one silently drops a session and hands
     * back a four-day week when five were asked for.
     */
    const mergeable = picked.find((p) => p.kind === kind && !p.goalIds.includes(demand.goalId));
    if (mergeable) {
      mergeable.goalIds.push(demand.goalId);
      mergeable.goalLabels.push(demand.goalLabel);
      continue;
    }
    if (picked.length >= daysPerWeek) continue;
    picked.push({ kind, goalIds: [demand.goalId], goalLabels: [demand.goalLabel] });
  }

  // ── Minutes ────────────────────────────────────────────────────────────
  // A lift is ~50 minutes whatever the aerobic week looks like, so strength
  // sits outside the budget. The aerobic budget is then split by KIND_WEIGHT
  // and clamped to each kind's plausible range — without the clamp, a week
  // whose slots are mostly strength hands the whole remaining budget to the
  // one or two runs that exist.
  // Budget scales with the AEROBIC slots, not the total days: strength takes
  // days but not aerobic minutes, so sizing the budget off all five days and
  // then splitting it across the two runs that survived is how a long run
  // ends up at three hours while the athlete lifts three times.
  const aerobicKinds = picked.map((p) => p.kind).filter((k) => !STRENGTH_KINDS.has(k));
  const budget = Math.round(aerobicKinds.length * BASELINE_MINUTES_PER_DAY * week.loadMultiplier);
  const aerobicWeight = aerobicKinds.reduce((sum, k) => sum + kindWeight(k, discipline), 0);

  const minutes = new Map<SessionKind, number>();
  for (const kind of aerobicKinds) {
    const raw = aerobicWeight > 0 ? (budget * kindWeight(kind, discipline)) / aerobicWeight : KIND_MINUTES[kind].min;
    minutes.set(kind, clampKind(kind, Math.round(raw)));
  }

  /*
   * Two dominance rules, because "biggest run" and "biggest session" are the
   * same thing for a runner and different things for a triathlete.
   *
   * Collapsing them — which is what a single hardcoded long-run anchor did —
   * means that fixing the bike's share of a triathlon week gets immediately
   * undone: the long run is pushed back above the ride it was just meant to
   * sit beneath.
   */
  const biggestExcept = (except: SessionKind, within?: (k: SessionKind) => boolean) =>
    Math.max(0, ...aerobicKinds.filter((k) => k !== except && (within?.(k) ?? true)).map((k) => minutes.get(k) ?? 0));

  // 1. The long run outlasts every other RUN — never shorter than an easy run.
  const longMinutes = minutes.get("run_long");
  if (longMinutes != null) {
    const biggestOtherRun = biggestExcept("run_long", (k) => SPORT_OF[k] === "run");
    if (longMinutes <= biggestOtherRun) {
      minutes.set("run_long", clampKind("run_long", Math.round(biggestOtherRun * 1.25)));
    }
  }

  // 2. The discipline's anchor outlasts everything. For a runner this is the
  //    long run again, so rule 1's result stands and nothing changes.
  const anchorKind = ANCHOR_KIND[discipline] ?? "run_long";
  const anchorMinutes = minutes.get(anchorKind);
  if (anchorMinutes != null) {
    const biggestOther = biggestExcept(anchorKind);
    if (anchorMinutes <= biggestOther) {
      minutes.set(anchorKind, clampKind(anchorKind, Math.round(biggestOther * 1.25)));
    }
  }

  const minutesFor = (kind: SessionKind): number => (STRENGTH_KINDS.has(kind) ? STRENGTH_MINUTES : (minutes.get(kind) ?? KIND_MINUTES[kind].min));

  const dates = assignDates(week.date, picked.map((p) => p.kind));

  const sessions: PlannedSession[] = picked.map((p, i) => {
    const durationMinutes = minutesFor(p.kind);
    const sport = SPORT_OF[p.kind];
    return {
      date: dates[i]!,
      kind: p.kind,
      sport,
      title: TITLE_OF[p.kind],
      focus: FOCUS_OF[p.kind],
      durationMinutes,
      // Priced with the same function the ledger prices logged sessions with,
      // so the planned week and the recorded week are on one scale.
      tss: estimateSessionTss({ sport: sport as Sport, durationMinutes, rpe: rpeFor(p.kind) }, athlete),
      intensity: INTENSITY_OF[p.kind],
      targets: targetsFor(p.kind, athlete, durationMinutes),
      servesGoalIds: p.goalIds,
      note:
        p.goalLabels.length > 1
          ? `Serves ${p.goalLabels.join(" and ")} at once — one session, both goals.`
          : `For ${p.goalLabels[0]}.`,
    };
  });

  sessions.sort((a, b) => a.date.localeCompare(b.date));

  return {
    weekStart: week.date,
    sessions,
    totalMinutes: sessions.reduce((s, x) => s + x.durationMinutes, 0),
    totalTss: sessions.reduce((s, x) => s + x.tss, 0),
    loadMultiplier: week.loadMultiplier,
    note: shape.focus,
  };
}

function clampKind(kind: SessionKind, minutes: number): number {
  const bounds = KIND_MINUTES[kind];
  return Math.min(bounds.max, Math.max(bounds.min, minutes));
}

/** RPE the session is prescribed AT, which is what prices its planned TSS. */
function rpeFor(kind: SessionKind): number {
  switch (INTENSITY_OF[kind]) {
    case "hard":
      return 8;
    case "moderate":
      return 6;
    case "easy":
      return 4;
    default:
      return 1;
  }
}
