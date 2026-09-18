/**
 * "What if I moved the race?" — answered by the real engine, not by a model
 * of it.
 *
 * This file is a DIFF LAYER and nothing else. It applies one hypothetical
 * patch to copies of the athlete's goals, runs the unmodified `arbitratePlan`
 * twice — once on the real goals, once on the patched copies — and describes
 * the difference. It contains no blending, no phase logic and no nutrition
 * logic of its own. That is the whole point: a what-if that approximates the
 * engine is a second mechanism that will drift from the first, and the week it
 * drifts is the week an athlete makes a real decision on a number the app no
 * longer actually believes.
 *
 * Three deliberate limits:
 *
 *  - ONE patch, THREE ops. Move this goal's date, change its priority, or
 *    drop it. A rich scenario payload nobody can drive on a phone is worse
 *    than three controls, and every extra dimension produces summary lines
 *    that can't be attributed to anything the athlete touched.
 *  - `remove` sets `active = false` rather than splicing the goal out, so
 *    `arbitrateWeek`'s own `active` filter is what removes it — the same code
 *    path a real deactivation would take, rather than a second one.
 *  - Arbitration layer ONLY. This sits above `prescribeWeek`, and therefore
 *    above any day-to-day modulation of the week. It reads no completions, no
 *    injuries, no check-ins. A hypothetical about next June must not be
 *    coloured by how tired the athlete is this morning. (`conditions` is
 *    passed through solely because `arbitratePlan` takes it and the BEFORE
 *    side has to match what the Plan page actually shows.)
 *
 * Nothing here writes anything. A hypothetical is not a prediction the app
 * made, so it must never reach `outcomeLog`.
 */

import type { Goal, GoalConflict } from "../goal";
import type { AthleteParams } from "../athlete";
import type { Condition } from "../conditions";
import { addDays, daysBetween, isValidISODate, weeksUntil } from "../dates";
import { predictBodyComposition } from "../predictors/bodyComposition";
import { arbitratePlan, type ArbitratedPlan } from "./arbitrate";
import { phaseForGoal, type NutritionStance } from "./goalPhase";

/* ─────────────────────────── The patch surface ─────────────────────────── */

/** Runtime value, not just a type — server validation and the UI both derive from this one list rather than keeping their own copies (the `SESSION_KINDS` lesson). */
export const WHAT_IF_OPS = ["shift", "reprioritise", "remove"] as const;
export type WhatIfOp = (typeof WHAT_IF_OPS)[number];

/** The athlete never reads an op value; they read these. A new op fails `tsc` here until it has words. */
export const WHAT_IF_OP_LABELS: Record<WhatIfOp, string> = {
  shift: "Move the date",
  reprioritise: "Change how much this one matters",
  remove: "Drop this goal",
};

export type GoalPatch =
  | { op: "shift"; goalId: string; byWeeks: number }
  | { op: "reprioritise"; goalId: string; priority: number }
  | { op: "remove"; goalId: string };

/** A year either way. Beyond that the athlete is describing a different goal, not moving this one. */
export const MAX_SHIFT_WEEKS = 52;
/** No hard ceiling exists on a stored goal's priority; this only rejects obvious nonsense typed into a hypothetical. */
export const MAX_PRIORITY = 20;
/** Two years of weeks. Stops a goal typo'd into 2035 producing a 500-week response. */
export const MAX_HORIZON_WEEKS = 104;

/** Every rejection from this layer. One class, so the route above maps one thing to 400. */
export class WhatIfPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatIfPatchError";
  }
}

/* ─────────────────────────────── The diff ──────────────────────────────── */

/** What the patch did to a goal. `bystander` is reported, never omitted — "your other goal is untouched" is an answer the athlete wants. */
export const GOAL_ROLES = ["patched", "removed", "bystander"] as const;
export type GoalRole = (typeof GOAL_ROLES)[number];

export const GOAL_ROLE_LABELS: Record<GoalRole, string> = {
  patched: "the goal you changed",
  removed: "the goal you dropped",
  bystander: "your other goals",
};

/** Which question `adequate` is answering — the two are not comparable, so the basis travels with the answer. */
export const FEASIBILITY_BASES = ["race_runway", "body_composition"] as const;
export type FeasibilityBasis = (typeof FEASIBILITY_BASES)[number];

export const FEASIBILITY_BASIS_LABELS: Record<FeasibilityBasis, string> = {
  race_runway: "whether there is still time to train for it",
  body_composition: "whether the weight change is still at a safe rate",
};

/** One phase of a goal's shape: how many weeks it wants, how many it would actually get. */
export interface PhaseNeed {
  phaseName: string;
  weeksNeeded: number;
  weeksAvailable: number;
}

export interface Feasibility {
  basis: FeasibilityBasis;
  /** For a race: every phase in its shape gets the weeks it asks for. For body composition: the required rate is within the safe ceiling. */
  adequate: boolean;
  /** Fractional — a race 10 days out is 1.43 weeks out. Negative when the date is already behind the plan's start. */
  weeksUntilTarget: number;
  /** `race_runway` only. Never includes the open-ended outermost phase (base, accumulation) — that one cannot be "short". */
  phaseNeeds: PhaseNeed[];
  /** `body_composition` only, taken straight from `predictBodyComposition` rather than recomputed. */
  requiredWeeklyChangeKg: number | null;
  safeWeeklyRateKg: number;
}

export interface WeekDelta {
  date: string;
  load: { before: number; after: number };
  nutrition: { before: NutritionStance; after: NutritionStance };
  changed: boolean;
}

/** Contiguous weeks sharing the same (before, after) pair, merged — the same thing `arbitratePlan` does to conflicts, for the same reason: 40 near-identical rows are not information. */
export interface LoadSpan {
  from: string;
  to: string;
  weeks: number;
  before: number;
  after: number;
}

/** Run-length encoding of one goal's phase names across the horizon. */
export interface PhaseSpan {
  phaseName: string;
  from: string;
  to: string;
  weeks: number;
}

export interface PhaseChange {
  phaseName: string;
  weeksBefore: number;
  weeksAfter: number;
  startBefore: string | null;
  startAfter: string | null;
}

export interface GoalDelta {
  goalId: string;
  label: string;
  role: GoalRole;
  targetDate: { before: string; after: string | null };
  priority: { before: number; after: number | null };
  phases: { before: PhaseSpan[]; after: PhaseSpan[] };
  /** Only phases whose week count or start date moved. Never carries the "past" phase — a goal falling off the back of the plan is a caveat, not a phase that gained weeks. */
  phaseChanges: PhaseChange[];
  feasibility: { before: Feasibility; after: Feasibility | null };
}

export interface ConflictDiff {
  appeared: GoalConflict[];
  disappeared: GoalConflict[];
  changed: Array<{ before: GoalConflict; after: GoalConflict }>;
}

export interface PlanDiff {
  weekCount: number;
  changedWeekCount: number;
  weeks: WeekDelta[];
  loadSpans: LoadSpan[];
  nutritionWeeks: { before: Record<NutritionStance, number>; after: Record<NutritionStance, number> };
  /** Every goal that was active before the patch, in before-priority order then id. */
  goals: GoalDelta[];
  conflicts: ConflictDiff;
}

export interface WhatIfRange {
  fromDate: string;
  /** Defaults to the union horizon: far enough out to cover every live target date on BOTH sides, so a taper that slides later reads as moved rather than vanished. */
  toDate?: string;
  /** The real current date, for condition state. Defaults to `fromDate`, matching `arbitratePlan`. */
  today?: string;
}

export interface WhatIfResult {
  fromDate: string;
  toDate: string;
  patch: GoalPatch;
  /** Exactly `arbitratePlan(goals, …)`. Pinned by a test — this layer produces plans only by calling the real function. */
  before: ArbitratedPlan;
  /** Exactly `arbitratePlan(applyGoalPatch(goals, patch), …)`. */
  after: ArbitratedPlan;
  diff: PlanDiff;
  /** The product. Most athletes read these lines and nothing else. */
  summary: string[];
  caveats: string[];
}

/* ───────────────────────────── Athlete words ───────────────────────────── */

/*
 * `GoalPhase.phaseName` is a free string owned by goalPhase.ts, not a union,
 * so this cannot be a `Record<Enum, string>` that tsc guards — an unknown name
 * falls through unchanged, which is safe because those names are already
 * written for the athlete (arbitrate.ts puts them in conflict descriptions
 * today). The only ones translated here are the two that read as jargon.
 */
const PHASE_WORDS: Record<string, string> = {
  maintain: "holding steady",
  "lean-gain": "lean-gain",
  past: "already over",
};

function phaseWords(phaseName: string): string {
  return PHASE_WORDS[phaseName] ?? phaseName;
}

/**
 * Which of the pair a resolution hands the week to. `GoalConflict["resolution"]`
 * is declared in shared/goal.ts, which this file does not own, so the mapping
 * lives here — still typed as a Record, so a fourth resolution fails `tsc`
 * until it has been given words. The athlete reads the goal's own name, never
 * "goal_a": "the first goal's way" is a sentence about a data structure.
 */
const CONFLICT_WINNER: Record<NonNullable<GoalConflict["resolution"]>, 0 | 1 | null> = {
  goal_a_priority: 0,
  goal_b_priority: 1,
  balanced: null,
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function weeksWord(n: number): string {
  return `${n} ${plural(n, "week", "weeks")}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Always two decimals, so a column of these lines up and "1x → 0.9x" never appears. */
function loadWords(n: number): string {
  return `${n.toFixed(2)}x`;
}

/* ──────────────────────────── Applying a patch ─────────────────────────── */

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new WhatIfPatchError(`${field} must be a non-empty string.`);
  return value;
}

/**
 * Pure. Returns a NEW array; the patched goal is a shallow copy with one field
 * changed and every other goal is the SAME object reference, so a caller can
 * assert by identity which goal was touched. Never mutates its input — a test
 * deep-freezes the goals and the athlete and calls this.
 */
export function applyGoalPatch(goals: Goal[], patch: GoalPatch): Goal[] {
  if (patch == null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new WhatIfPatchError("patch must be an object.");
  }
  const op = (patch as { op?: unknown }).op;
  if (typeof op !== "string" || !(WHAT_IF_OPS as readonly string[]).includes(op)) {
    throw new WhatIfPatchError(`op must be one of: ${WHAT_IF_OPS.join(", ")}.`);
  }

  const goalId = requireString((patch as { goalId?: unknown }).goalId, "goalId");
  const target = goals.find((g) => g.id === goalId);
  if (!target) throw new WhatIfPatchError("goalId does not match any goal.");
  if (!target.active) throw new WhatIfPatchError("goalId refers to a goal that is not active — there is nothing to try.");
  if (!isValidISODate(target.targetDate)) throw new WhatIfPatchError("goalId refers to a goal whose target date is not a real date.");

  const replace = (next: Goal): Goal[] => goals.map((g) => (g.id === goalId ? next : g));

  switch (patch.op) {
    case "shift": {
      const byWeeks = patch.byWeeks;
      if (!Number.isInteger(byWeeks)) throw new WhatIfPatchError("byWeeks must be a whole number of weeks.");
      if (byWeeks === 0) throw new WhatIfPatchError("byWeeks must not be zero — that is not a scenario.");
      if (Math.abs(byWeeks) > MAX_SHIFT_WEEKS) throw new WhatIfPatchError(`byWeeks must be between -${MAX_SHIFT_WEEKS} and ${MAX_SHIFT_WEEKS}.`);
      return replace({ ...target, targetDate: addDays(target.targetDate, byWeeks * 7) });
    }
    case "reprioritise": {
      const priority = patch.priority;
      if (!Number.isInteger(priority) || priority < 1) throw new WhatIfPatchError("priority must be a whole number of at least 1.");
      if (priority > MAX_PRIORITY) throw new WhatIfPatchError(`priority must be at most ${MAX_PRIORITY}.`);
      // Reprioritising to the value the goal already has is allowed on purpose:
      // it is a genuine no-op and "nothing would change" is a real answer.
      return replace({ ...target, priority });
    }
    case "remove":
      return replace({ ...target, active: false });
  }
}

/* ──────────────────────────────── Horizon ──────────────────────────────── */

function latestActiveTarget(goals: Goal[]): string | null {
  let latest: string | null = null;
  for (const g of goals) {
    if (!g.active || !isValidISODate(g.targetDate)) continue;
    if (latest == null || g.targetDate > latest) latest = g.targetDate;
  }
  return latest;
}

/**
 * The UNION of both sides' latest live target date, so a race that slides
 * eight weeks later shows as moved rather than as falling off the end of the
 * comparison and looking deleted.
 */
export function resolveHorizon(goalsBefore: Goal[], goalsAfter: Goal[], fromDate: string): { toDate: string; caveats: string[] } {
  const caveats: string[] = [];
  const candidates = [fromDate, latestActiveTarget(goalsBefore), latestActiveTarget(goalsAfter)].filter((d): d is string => d != null);
  let toDate = candidates.reduce((a, b) => (b > a ? b : a));
  const cap = addDays(fromDate, MAX_HORIZON_WEEKS * 7);
  if (toDate > cap) {
    toDate = cap;
    caveats.push(`Only the next ${MAX_HORIZON_WEEKS} weeks are compared — anything past ${cap} is not shown.`);
  }
  return { toDate, caveats };
}

/* ───────────────────────────── Feasibility ─────────────────────────────── */

/** How far back to probe for a goal's full phase shape. Longer than any phase any goal type declares. */
const SHAPE_PROBE_WEEKS = 60;

function basisFor(goal: Goal): FeasibilityBasis {
  return goal.type === "body_composition" ? "body_composition" : "race_runway";
}

/**
 * The last week on the plan's own grid that still falls on or before the
 * target date.
 *
 * Both the shape and the availability count have to be sampled on the SAME
 * weekly grid or they are not comparable: a race on a Tuesday planned from a
 * Monday is sampled at 0.14, 1.14, 2.14 … weeks out, and a peak block that
 * covers 1.5–3 weeks out catches two of those points on one grid and one on
 * the other. Measured against each other that reads as a missing peak week in
 * a plan that has not moved at all.
 */
function gridAnchor(fromDate: string, targetDate: string): string {
  const days = daysBetween(fromDate, targetDate);
  if (days < 0) return targetDate;
  return addDays(fromDate, Math.floor(days / 7) * 7);
}

/**
 * What the goal's own phase shape asks for, read OUT of `phaseForGoal` rather
 * than restated here.
 *
 * goalPhase.ts owns the week thresholds (a taper at 1.5 weeks out, a build
 * from 3 to 12). Copying them into this file would be a second copy that
 * drifts the first time someone tunes a taper. So instead: stand at the
 * target date, walk backwards a week at a time, and record what the goal
 * says it wants. The outermost phase — whatever it has settled into at the
 * far end — is open-ended by definition and is excluded, because "your base
 * phase is short" is not a finding.
 */
function phaseShapeOf(goal: Goal, athlete: AthleteParams, anchorDate: string): Array<{ phaseName: string; weeksNeeded: number }> {
  const names: string[] = [];
  for (let k = 0; k <= SHAPE_PROBE_WEEKS; k++) {
    names.push(phaseForGoal(goal, addDays(anchorDate, -7 * k), athlete).phaseName);
  }
  const steady = names[SHAPE_PROBE_WEEKS]!;
  const counts = new Map<string, number>();
  for (const name of names) {
    if (name === steady) break;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  // Nearest-first out of the walk; reversed so the athlete reads them in the
  // order they would train them.
  return [...counts.entries()].reverse().map(([phaseName, weeksNeeded]) => ({ phaseName, weeksNeeded }));
}

function phasesAvailable(goal: Goal, athlete: AthleteParams, fromDate: string): Map<string, number> {
  const counts = new Map<string, number>();
  let cursor = fromDate;
  for (let k = 0; k <= MAX_HORIZON_WEEKS && cursor <= goal.targetDate; k++) {
    const name = phaseForGoal(goal, cursor, athlete).phaseName;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    cursor = addDays(cursor, 7);
  }
  return counts;
}

/**
 * Honest rather than encouraging: a race moved closer still produces a
 * perfectly plausible-looking week — a taper is a taper — while the build
 * phase underneath it has quietly been cut from nine weeks to two. The week
 * cannot show that. This can.
 */
export function feasibilityOf(goal: Goal, athlete: AthleteParams, fromDate: string): Feasibility {
  const weeksUntilTarget = round2(weeksUntil(fromDate, goal.targetDate));
  const basis = basisFor(goal);

  if (basis === "body_composition") {
    const prediction = predictBodyComposition(athlete, {
      targetWeightKg: goal.targetMetrics.targetWeightKg,
      targetBodyFatPercent: goal.targetMetrics.targetBodyFatPercent,
      targetDate: goal.targetDate,
      today: fromDate,
    });
    return {
      basis,
      adequate: prediction.achievable,
      weeksUntilTarget,
      phaseNeeds: [],
      requiredWeeklyChangeKg: prediction.requiredWeeklyChangeKg,
      safeWeeklyRateKg: prediction.safeWeeklyRateKg,
    };
  }

  const shape = phaseShapeOf(goal, athlete, gridAnchor(fromDate, goal.targetDate));
  const available = weeksUntilTarget < 0 ? new Map<string, number>() : phasesAvailable(goal, athlete, fromDate);
  const phaseNeeds: PhaseNeed[] = shape.map(({ phaseName, weeksNeeded }) => ({
    phaseName,
    weeksNeeded,
    weeksAvailable: available.get(phaseName) ?? 0,
  }));
  return {
    basis,
    adequate: weeksUntilTarget >= 0 && phaseNeeds.every((p) => p.weeksAvailable >= p.weeksNeeded),
    weeksUntilTarget,
    phaseNeeds,
    requiredWeeklyChangeKg: null,
    safeWeeklyRateKg: 0,
  };
}

/* ──────────────────────────────── Diffing ──────────────────────────────── */

function emptyStanceCounts(): Record<NutritionStance, number> {
  return { surplus: 0, maintenance: 0, deficit: 0 };
}

function phaseSpansFor(plan: ArbitratedPlan, goalId: string): PhaseSpan[] {
  const spans: PhaseSpan[] = [];
  for (const week of plan.weeks) {
    const phase = week.goalPhases.find((p) => p.goalId === goalId);
    if (!phase) continue;
    const last = spans[spans.length - 1];
    if (last && last.phaseName === phase.phaseName && daysBetween(last.to, week.date) <= 8) {
      last.to = week.date;
      last.weeks += 1;
    } else {
      spans.push({ phaseName: phase.phaseName, from: week.date, to: week.date, weeks: 1 });
    }
  }
  return spans;
}

function phaseChangesBetween(before: PhaseSpan[], after: PhaseSpan[]): PhaseChange[] {
  const names = [...new Set([...before, ...after].map((s) => s.phaseName))].filter((n) => n !== "past");
  const changes: PhaseChange[] = [];
  for (const phaseName of names) {
    const b = before.filter((s) => s.phaseName === phaseName);
    const a = after.filter((s) => s.phaseName === phaseName);
    const weeksBefore = b.reduce((n, s) => n + s.weeks, 0);
    const weeksAfter = a.reduce((n, s) => n + s.weeks, 0);
    const startBefore = b[0]?.from ?? null;
    const startAfter = a[0]?.from ?? null;
    if (weeksBefore === weeksAfter && startBefore === startAfter) continue;
    changes.push({ phaseName, weeksBefore, weeksAfter, startBefore, startAfter });
  }
  return changes;
}

function pairKey(ids: [string, string]): string {
  return [...ids].sort().join("|");
}

function windowsOverlap(a: GoalConflict, b: GoalConflict): boolean {
  return a.window.from <= b.window.to && b.window.from <= a.window.to;
}

function sameWindow(a: GoalConflict, b: GoalConflict): boolean {
  return a.window.from === b.window.from && a.window.to === b.window.to;
}

/**
 * Matched by goal PAIR and overlapping window, because `GoalConflict` carries
 * no kind. `mergeContiguousConflicts` already collapses a nutrition and a load
 * conflict between the same pair in the same span into one entry, so matching
 * any finer would be inventing an identity the data does not have. A before
 * window that splits into two after windows therefore reports as one changed
 * plus one appeared — documented, not silent.
 */
function diffConflicts(before: GoalConflict[], after: GoalConflict[]): ConflictDiff {
  const keys = [...new Set([...before, ...after].map((c) => pairKey(c.betweenGoalIds)))].sort();
  const diff: ConflictDiff = { appeared: [], disappeared: [], changed: [] };

  for (const key of keys) {
    const bs = before.filter((c) => pairKey(c.betweenGoalIds) === key).sort((x, y) => x.window.from.localeCompare(y.window.from));
    const as = after.filter((c) => pairKey(c.betweenGoalIds) === key).sort((x, y) => x.window.from.localeCompare(y.window.from));
    const takenAfter = new Set<number>();

    for (const b of bs) {
      const index = as.findIndex((a, i) => !takenAfter.has(i) && windowsOverlap(b, a));
      if (index === -1) {
        diff.disappeared.push(b);
        continue;
      }
      takenAfter.add(index);
      const a = as[index]!;
      if (sameWindow(b, a) && b.resolution === a.resolution) continue;
      diff.changed.push({ before: b, after: a });
    }
    as.forEach((a, i) => {
      if (!takenAfter.has(i)) diff.appeared.push(a);
    });
  }
  return diff;
}

export function diffArbitratedPlans(
  before: ArbitratedPlan,
  after: ArbitratedPlan,
  goalsBefore: Goal[],
  goalsAfter: Goal[],
  athlete: AthleteParams,
): PlanDiff {
  if (before.weeks.length !== after.weeks.length) {
    throw new WhatIfPatchError("the two plans cover different numbers of weeks — they must be arbitrated over the same range.");
  }

  const weeks: WeekDelta[] = before.weeks.map((b, i) => {
    const a = after.weeks[i]!;
    if (a.date !== b.date) throw new WhatIfPatchError("the two plans do not line up week for week.");
    const phasesDiffer = [...new Set([...b.goalPhases, ...a.goalPhases].map((p) => p.goalId))].some((id) => {
      const bp = b.goalPhases.find((p) => p.goalId === id);
      const ap = a.goalPhases.find((p) => p.goalId === id);
      return (bp?.phaseName ?? null) !== (ap?.phaseName ?? null);
    });
    return {
      date: b.date,
      load: { before: b.loadMultiplier, after: a.loadMultiplier },
      nutrition: { before: b.nutritionStance, after: a.nutritionStance },
      changed: b.loadMultiplier !== a.loadMultiplier || b.nutritionStance !== a.nutritionStance || phasesDiffer,
    };
  });

  const loadSpans: LoadSpan[] = [];
  for (const w of weeks) {
    if (w.load.before === w.load.after) continue;
    const last = loadSpans[loadSpans.length - 1];
    if (last && last.before === w.load.before && last.after === w.load.after && daysBetween(last.to, w.date) <= 8) {
      last.to = w.date;
      last.weeks += 1;
    } else {
      loadSpans.push({ from: w.date, to: w.date, weeks: 1, before: w.load.before, after: w.load.after });
    }
  }

  const nutritionWeeks = { before: emptyStanceCounts(), after: emptyStanceCounts() };
  for (const w of weeks) {
    nutritionWeeks.before[w.nutrition.before] += 1;
    nutritionWeeks.after[w.nutrition.after] += 1;
  }

  const tracked = goalsBefore.filter((g) => g.active).sort((x, y) => x.priority - y.priority || x.id.localeCompare(y.id));
  const goals: GoalDelta[] = tracked.map((b) => {
    const a = goalsAfter.find((g) => g.id === b.id) ?? null;
    const removed = a == null || !a.active;
    const role: GoalRole = removed ? "removed" : a.targetDate !== b.targetDate || a.priority !== b.priority ? "patched" : "bystander";
    const phasesBefore = phaseSpansFor(before, b.id);
    const phasesAfter = removed ? [] : phaseSpansFor(after, b.id);
    return {
      goalId: b.id,
      label: b.label,
      role,
      targetDate: { before: b.targetDate, after: removed ? null : a!.targetDate },
      priority: { before: b.priority, after: removed ? null : a!.priority },
      phases: { before: phasesBefore, after: phasesAfter },
      phaseChanges: phaseChangesBetween(phasesBefore, phasesAfter),
      feasibility: {
        before: feasibilityOf(b, athlete, before.fromDate),
        after: removed ? null : feasibilityOf(a!, athlete, after.fromDate),
      },
    };
  });

  return {
    weekCount: weeks.length,
    changedWeekCount: weeks.filter((w) => w.changed).length,
    weeks,
    loadSpans,
    nutritionWeeks,
    goals,
    conflicts: diffConflicts(before.conflicts, after.conflicts),
  };
}

/* ─────────────────────────────── Summary ───────────────────────────────── */

function labelOf(goals: Goal[], goalId: string): string {
  return goals.find((g) => g.id === goalId)?.label ?? "a goal you no longer have";
}

function headlineFor(patch: GoalPatch, goalsBefore: Goal[], goalsAfter: Goal[]): string {
  const label = labelOf(goalsBefore, patch.goalId);
  switch (patch.op) {
    case "shift": {
      const from = goalsBefore.find((g) => g.id === patch.goalId)!.targetDate;
      const to = goalsAfter.find((g) => g.id === patch.goalId)!.targetDate;
      const n = Math.abs(patch.byWeeks);
      return `Moving ${label} ${weeksWord(n)} ${patch.byWeeks > 0 ? "later" : "earlier"} (${from} → ${to}).`;
    }
    case "reprioritise": {
      const was = goalsBefore.find((g) => g.id === patch.goalId)!.priority;
      return `Making ${label} priority ${patch.priority} (it is priority ${was} today).`;
    }
    case "remove":
      return `Dropping ${label}.`;
  }
}

function phaseChangeLine(label: string, change: PhaseChange): string {
  const words = phaseWords(change.phaseName);
  if (change.weeksBefore === 0) {
    return `${label} gains a ${words} phase — ${weeksWord(change.weeksAfter)}, starting ${change.startAfter}.`;
  }
  if (change.weeksAfter === 0) {
    return `${label}'s ${words} phase disappears — it was ${weeksWord(change.weeksBefore)} from ${change.startBefore}.`;
  }
  if (change.weeksBefore !== change.weeksAfter) {
    const delta = Math.abs(change.weeksAfter - change.weeksBefore);
    const verb = change.weeksAfter > change.weeksBefore ? "gains" : "loses";
    return `${label}'s ${words} phase ${verb} ${weeksWord(delta)} (${change.weeksBefore} → ${change.weeksAfter}).`;
  }
  const shift = Math.round(daysBetween(change.startBefore!, change.startAfter!) / 7);
  const direction = shift > 0 ? "later" : "earlier";
  return `${label}'s ${words} phase starts ${weeksWord(Math.abs(shift))} ${direction} (${change.startBefore} → ${change.startAfter}).`;
}

function feasibilityLines(label: string, before: Feasibility, after: Feasibility | null): string[] {
  // A goal whose new date is already behind the plan's start is covered by a
  // caveat; telling the athlete it has no build weeks left on top of that is
  // noise about something that is simply over.
  if (!after || after.weeksUntilTarget < 0) return [];
  const lines: string[] = [];

  if (after.basis === "body_composition") {
    const required = after.requiredWeeklyChangeKg;
    if (required == null) return lines;
    const rate = Math.abs(round2(required));
    const ceiling = round2(after.safeWeeklyRateKg);
    if (!after.adequate && (before.adequate || before.requiredWeeklyChangeKg !== after.requiredWeeklyChangeKg)) {
      lines.push(`${label} would need ${rate} kg a week — above the ${ceiling} kg a week that is safe to sustain. The plan will still show a sensible-looking week; the arithmetic underneath it does not work.`);
    } else if (after.adequate && !before.adequate) {
      lines.push(`${label} becomes achievable — ${rate} kg a week, under the ${ceiling} kg a week ceiling.`);
    }
    return lines;
  }

  const short = after.phaseNeeds.filter((p) => p.weeksAvailable < p.weeksNeeded);
  if (short.length > 0 && (before.adequate || short.some((p) => {
    const b = before.phaseNeeds.find((q) => q.phaseName === p.phaseName);
    return !b || b.weeksAvailable !== p.weeksAvailable;
  }))) {
    const parts = short.map((p) => `${p.weeksAvailable} ${plural(p.weeksAvailable, "week", "weeks")} of ${phaseWords(p.phaseName)} where it wants ${p.weeksNeeded}`);
    lines.push(`${label} would not have the runway: ${parts.join(", ")}. The week would still look normal — the training behind it would not be there.`);
  } else if (after.adequate && !before.adequate) {
    lines.push(`${label} would get every phase it needs in full, which it does not today.`);
  }
  return lines;
}

/**
 * `betweenGoalIds` comes out of arbitrateWeek in whichever order the week
 * happened to compare them, so the same pair can read "A and B" in one week
 * and "B and A" in the next. Ordered here by the athlete's own priority so a
 * pair is named the same way every time it is mentioned.
 */
function conflictPairWords(conflict: GoalConflict, goalsBefore: Goal[]): string {
  const [a, b] = conflict.betweenGoalIds;
  // arbitrateWeek pairs a goal with ITSELF when the other party is an injury
  // rather than a goal — there is no second goal to name.
  if (a === b) return labelOf(goalsBefore, a);
  const rank = (id: string): string => {
    const g = goalsBefore.find((x) => x.id === id);
    return g ? `${String(g.priority).padStart(4, "0")}#${g.id}` : `9999#${id}`;
  };
  const [first, second] = rank(a) <= rank(b) ? [a, b] : [b, a];
  return `${labelOf(goalsBefore, first)} and ${labelOf(goalsBefore, second)}`;
}

function resolutionWords(conflict: GoalConflict, goalsBefore: Goal[]): string {
  const index = conflict.resolution ? CONFLICT_WINNER[conflict.resolution] : null;
  if (index == null) return "an even split";
  return `${labelOf(goalsBefore, conflict.betweenGoalIds[index])}'s way`;
}

function conflictChangedLine(pair: string, before: GoalConflict, after: GoalConflict, goalsBefore: Goal[]): string | null {
  const weeksBefore = Math.round(daysBetween(before.window.from, before.window.to) / 7) + 1;
  const weeksAfter = Math.round(daysBetween(after.window.from, after.window.to) / 7) + 1;
  if (weeksBefore !== weeksAfter) {
    const verb = weeksAfter < weeksBefore ? "shortens" : "lengthens";
    return `The clash between ${pair} ${verb} from ${weeksWord(weeksBefore)} to ${weeksAfter}.`;
  }
  if (before.window.from !== after.window.from) {
    const shift = Math.round(daysBetween(before.window.from, after.window.from) / 7);
    return `The clash between ${pair} moves ${weeksWord(Math.abs(shift))} ${shift > 0 ? "later" : "earlier"} (${before.window.from} → ${after.window.from}).`;
  }
  if (before.resolution !== after.resolution) {
    return `The clash between ${pair} (${after.window.from} → ${after.window.to}) now goes ${resolutionWords(after, goalsBefore)} (it went ${resolutionWords(before, goalsBefore)} before).`;
  }
  return null;
}

/**
 * A fixed grammar in a fixed order, so the same scenario always reads the same
 * way. Deterministic: no locale formatting, no sorting by anything that could
 * tie, nothing derived from the clock.
 */
export function summariseDiff(diff: PlanDiff, patch: GoalPatch, goalsBefore: Goal[], goalsAfter: Goal[]): string[] {
  const headline = headlineFor(patch, goalsBefore, goalsAfter);
  const lines: string[] = [];

  for (const goal of diff.goals) {
    for (const change of goal.phaseChanges) {
      // "holding steady" is the leftover between the blocks that are actually
      // trained, so its week count moving is a restatement of the date moving
      // and nothing more. It stays in diff.phaseChanges for the timeline the
      // UI draws; it just does not earn a line the athlete has to read.
      if (change.phaseName === "maintain") continue;
      lines.push(phaseChangeLine(goal.label, change));
    }
    lines.push(...feasibilityLines(goal.label, goal.feasibility.before, goal.feasibility.after));
  }

  if (diff.loadSpans.length > 0) {
    const biggest = diff.loadSpans.reduce((best, span) =>
      Math.abs(span.after - span.before) > Math.abs(best.after - best.before) ? span : best,
    );
    const changedLoadWeeks = diff.loadSpans.reduce((n, s) => n + s.weeks, 0);
    lines.push(
      `Training load changes in ${changedLoadWeeks} of the ${diff.weekCount} weeks — the biggest swing is the week of ${biggest.from}, ${loadWords(biggest.before)} → ${loadWords(biggest.after)}.`,
    );
  }

  if (diff.nutritionWeeks.before.deficit !== diff.nutritionWeeks.after.deficit) {
    lines.push(`Weeks eating below what you burn: ${diff.nutritionWeeks.before.deficit} → ${diff.nutritionWeeks.after.deficit}.`);
  }
  if (diff.nutritionWeeks.before.surplus !== diff.nutritionWeeks.after.surplus) {
    lines.push(`Weeks eating above what you burn: ${diff.nutritionWeeks.before.surplus} → ${diff.nutritionWeeks.after.surplus}.`);
  }

  for (const c of diff.conflicts.disappeared) {
    lines.push(`The clash between ${conflictPairWords(c, goalsBefore)} (${c.window.from} → ${c.window.to}) disappears.`);
  }
  for (const c of diff.conflicts.appeared) {
    lines.push(`A new clash between ${conflictPairWords(c, goalsBefore)} appears (${c.window.from} → ${c.window.to}).`);
  }
  for (const { before, after } of diff.conflicts.changed) {
    const line = conflictChangedLine(conflictPairWords(before, goalsBefore), before, after, goalsBefore);
    if (line) lines.push(line);
  }

  if (lines.length === 0) lines.push("Nothing about the plan would change over this stretch.");
  // Two separate episodes of the same tradeoff can phrase identically. The
  // same sentence twice is not a second finding.
  return [headline, ...lines.filter((line, i) => lines.indexOf(line) === i)];
}

/* ──────────────────────────────── Entry ────────────────────────────────── */

/**
 * The only function a caller needs.
 *
 * `before` and `after` come out of `arbitratePlan` and nothing else — the diff
 * is descriptive, never authoritative.
 */
export function whatIf(
  goals: Goal[],
  patch: GoalPatch,
  range: WhatIfRange,
  athlete: AthleteParams,
  conditions: Condition[] = [],
): WhatIfResult {
  if (!Array.isArray(goals)) throw new WhatIfPatchError("goals must be an array.");
  if (!isValidISODate(range?.fromDate)) throw new WhatIfPatchError("fromDate must be a real date in YYYY-MM-DD form.");
  if (range.toDate != null && !isValidISODate(range.toDate)) throw new WhatIfPatchError("toDate must be a real date in YYYY-MM-DD form.");
  if (range.today != null && !isValidISODate(range.today)) throw new WhatIfPatchError("today must be a real date in YYYY-MM-DD form.");
  const { fromDate } = range;

  const patched = applyGoalPatch(goals, patch);

  let toDate: string;
  const caveats: string[] = [];
  if (range.toDate != null) {
    if (range.toDate < fromDate) throw new WhatIfPatchError("toDate must not be before fromDate.");
    toDate = range.toDate;
    for (const g of patched) {
      if (!g.active || !isValidISODate(g.targetDate) || g.targetDate <= toDate) continue;
      caveats.push(`${g.label} would land on ${g.targetDate}, past the end of this comparison — the run-in to it is not shown.`);
    }
  } else {
    const resolved = resolveHorizon(goals, patched, fromDate);
    toDate = resolved.toDate;
    caveats.push(...resolved.caveats);
  }

  // The Phase 3 past-goal bug, re-pinned one layer up: a goal moved behind the
  // plan's start contributes nothing at all, and the athlete is told so rather
  // than left to notice that its phases all read as over.
  const movedGoal = patched.find((g) => g.id === patch.goalId);
  if (patch.op === "shift" && movedGoal && movedGoal.targetDate < fromDate) {
    caveats.push(`${movedGoal.label}'s new date (${movedGoal.targetDate}) is before this week — it would already be behind you, and would count for nothing in the plan.`);
  }

  const today = range.today ?? fromDate;
  const before = arbitratePlan(goals, fromDate, toDate, athlete, conditions, today);
  const after = arbitratePlan(patched, fromDate, toDate, athlete, conditions, today);
  const diff = diffArbitratedPlans(before, after, goals, patched, athlete);

  return { fromDate, toDate, patch, before, after, diff, summary: summariseDiff(diff, patch, goals, patched), caveats };
}
