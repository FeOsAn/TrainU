/**
 * Injury and illness as first-class state.
 *
 * A condition is a fact about the BODY, not about a goal: it has no goal id,
 * because a calf strain rules out running whether you are training for a
 * marathon or a wedding. It is evaluated per DATE rather than per "today" —
 * a condition closed on Wednesday is not open on Thursday, and one opened on
 * Wednesday was not open on Monday. That per-date rule is the whole defence
 * against the Phase 3 archetype, where state that should have stopped
 * influencing output kept quietly steering the plan.
 *
 * SCOPE: everything a condition MEANS lives here — the type, the runtime
 * enums, their athlete-facing label tables, the per-date predicates, and all
 * the coaching judgement (which session kinds each restriction forbids, the
 * substitute lists, the illness rules, the return-to-training ramp, and what
 * a condition costs a goal). Deliberately not scattered across the modules
 * that consume it: the week adjuster, the risk annotation on a goal phase and
 * the UI's suggested checkboxes all read the SAME tables, so "a calf strain
 * rules out running" cannot be true in one screen and false in another.
 *
 * Pure and DB-free, for the same reason server/goalValidation.ts is: the
 * validation below has to be reachable from a future chat tool
 * ("I tweaked my calf yesterday") without dragging in the database, and a
 * hallucinated restriction has to be rejected exactly as a bad form
 * submission is.
 */

import { addDays, daysBetween, isValidISODate, weeksUntil } from "./dates";
import type { Goal } from "./goal";
import type { FeaturePreferences } from "./preferences";
import { SESSION_KINDS, type SessionKind } from "./prescription/sessionKinds";
import { TITLE_OF, applyCeiling, downgradeToEasy, qualitiesFor } from "./prescription/templates";

export const CONDITION_KINDS = ["injury", "illness"] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

export const SEVERITIES = [1, 2, 3] as const;
export type Severity = (typeof SEVERITIES)[number];

/** What a condition rules out. Structured, because the engine has to act on it — free text would be a note nobody can honour. */
export const RESTRICTIONS = ["no_running", "no_impact", "no_upper", "no_lower"] as const;
export type Restriction = (typeof RESTRICTIONS)[number];

/** A UI hint source only: it suggests restrictions. The engine NEVER reads it — what it acts on is the restrictions the athlete confirmed. */
export const BODY_PARTS = [
  "foot", "ankle", "shin", "calf", "knee", "hamstring", "quad", "hip",
  "lower_back", "upper_back", "shoulder", "elbow", "wrist", "other",
] as const;
export type BodyPart = (typeof BODY_PARTS)[number];

export interface Condition {
  id: string;
  kind: ConditionKind;
  /** The athlete's own words: "Left calf strain", "Head cold". */
  label: string;
  bodyPart: BodyPart | null;
  severity: Severity;
  restrictions: Restriction[];
  /** YYYY-MM-DD. */
  openedAt: string;
  /** YYYY-MM-DD, or null while it is still open. Never set by the app on its own — see the note on auto-closing below. */
  closedAt: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/*
 * ─── Labels ────────────────────────────────────────────────────────────────
 *
 * Every enum gets its words in the same file that declares it, typed as
 * Record<TheEnum, string> so a new member fails `tsc` until someone has
 * written what it says to the athlete. No `no_running`, no `severity-2` and
 * no `at_risk` ever reaches a screen or a reason string.
 */

export const CONDITION_KIND_LABELS: Record<ConditionKind, string> = {
  injury: "Injury",
  illness: "Illness",
};

export const RESTRICTION_LABELS: Record<Restriction, string> = {
  no_running: "Can't run",
  no_impact: "No impact — riding and swimming are fine",
  no_upper: "Nothing loading the upper body",
  no_lower: "Nothing loading the legs",
};

export const BODY_PART_LABELS: Record<BodyPart, string> = {
  foot: "Foot",
  ankle: "Ankle",
  shin: "Shin",
  calf: "Calf",
  knee: "Knee",
  hamstring: "Hamstring",
  quad: "Quad",
  hip: "Hip",
  lower_back: "Lower back",
  upper_back: "Upper back",
  shoulder: "Shoulder",
  elbow: "Elbow",
  wrist: "Wrist",
  other: "Somewhere else",
};

/** Severity means different things for an injury and an illness, so it gets different words for each rather than one number the athlete has to interpret. */
export const SEVERITY_LABELS: Record<ConditionKind, Record<Severity, string>> = {
  injury: {
    1: "Niggle — I can train around it",
    2: "Real — it changes what I can do",
    3: "Can't train on it at all",
  },
  illness: {
    1: "Above the neck — head cold, sniffles",
    2: "Below the neck, no fever — chest, aches",
    3: "Fever or systemic — properly ill",
  },
};

/*
 * ─── Per-date predicates ───────────────────────────────────────────────────
 */

/**
 * Was this condition open on this DATE — not "is it open today".
 *
 * Every consumer goes through here. A week is adjusted session by session,
 * each against its own date, so Monday's session sees the strain and
 * Saturday's (after it was marked healed on Thursday) does not.
 */
export function isOpenOn(c: Condition, date: string): boolean {
  return c.openedAt <= date && (c.closedAt === null || date <= c.closedAt);
}

/*
 * A condition is NEVER closed by the app. After long enough with no edit it
 * stops contributing restrictions and the athlete is asked whether it is
 * still true — but the app does not know that anyone healed, and recording
 * that it did would be the silent-guess pattern in reverse.
 */

/*
 * ─── Goal risk ─────────────────────────────────────────────────────────────
 *
 * What a condition does to a GOAL. Declared here so arbitration and the
 * predictors can carry it; computed by the conditions feature, which knows
 * how many of the goal's anchor sessions were actually lost.
 *
 * Note what risk deliberately does NOT do: it never moves a prediction's
 * point estimate. Widening the band because training did not happen is
 * honest; inventing a detraining curve and presenting it with the same
 * confidence as the Riegel maths is the CdA mistake this codebase exists to
 * avoid.
 */
export type RiskLevel = "none" | "watch" | "at_risk";

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  none: "On track",
  watch: "Worth watching",
  at_risk: "At risk",
};

export interface GoalRisk {
  level: RiskLevel;
  /** Days in the window where the goal's most important session could not happen at all. */
  daysLost: number;
  /** Days where it could happen, but not at the intensity the goal wanted. */
  daysCapped: number;
  conditionLabels: string[];
  anchorKind: SessionKind;
  windowDays: number;
  /** One or two sentences, in the athlete's words, naming the goal and what it cost. */
  note: string;
}

/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  The coaching tables
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * What a session kind asks of the body. A restriction forbids every kind that
 * carries the demand it bans.
 *
 * This indirection is the whole point: the athlete ticks "Can't run" once,
 * and every present and future session kind is classified once, rather than
 * every restriction carrying a hand-written list of kinds that goes stale the
 * day a kind is added.
 */
export const DEMANDS = ["running", "impact", "upper", "lower"] as const;
export type Demand = (typeof DEMANDS)[number];

export const DEMAND_LABELS: Record<Demand, string> = {
  running: "running",
  impact: "impact through the legs",
  upper: "upper-body load",
  lower: "load through the legs",
};

export const RESTRICTION_FORBIDS: Record<Restriction, Demand> = {
  no_running: "running",
  no_impact: "impact",
  no_upper: "upper",
  no_lower: "lower",
};

/**
 * `Record<SessionKind, …>` on purpose: a new session kind fails `tsc` until
 * somebody has said what it demands of the body. An unclassified kind would
 * otherwise default to "demands nothing", which is a session prescribed
 * straight through a restriction that was meant to stop it.
 *
 * The judgements worth arguing with: a swim is upper-body work and is left
 * available to most leg injuries; a ride loads the legs but has no impact, so
 * it survives `no_impact` and not `no_lower`; compromised running and station
 * work demand nearly everything, which is what makes them the first things to
 * go. `rest` demands nothing and is never forbidden — there has to be
 * something every restricted athlete can still be given.
 */
export const KIND_DEMANDS: Record<SessionKind, Demand[]> = {
  run_easy: ["running", "impact", "lower"],
  run_long: ["running", "impact", "lower"],
  run_threshold: ["running", "impact", "lower"],
  run_intervals: ["running", "impact", "lower"],
  bike_endurance: ["lower"],
  swim_technique: ["upper"],
  compromised: ["running", "impact", "lower", "upper"],
  station_work: ["impact", "lower", "upper"],
  strength_lower: ["lower"],
  strength_push: ["upper"],
  strength_pull: ["upper"],
  rest: [],
};

/** Is this kind ruled out by these restrictions? Pure table lookup — the ONE place restriction semantics live. */
export function isForbidden(kind: SessionKind, restrictions: Restriction[]): boolean {
  if (kind === "rest") return false;
  const demands = KIND_DEMANDS[kind];
  return restrictions.some((r) => {
    const banned = RESTRICTION_FORBIDS[r];
    return banned !== undefined && demands.includes(banned);
  });
}

/** Every kind these restrictions rule out. Derived from `isForbidden`, never a second list. */
export function forbiddenKinds(restrictions: Restriction[]): Set<SessionKind> {
  return new Set(SESSION_KINDS.filter((kind) => isForbidden(kind, restrictions)));
}

/**
 * Ordered candidates when a kind is ruled out — cross-training around the
 * restriction rather than deleting the session.
 *
 * Ordered by how much of the original session's purpose survives, not by
 * convenience: a runner who can't run is better served by a ride than a swim,
 * and a lower-body lift that's off becomes an upper-body one before it
 * becomes nothing. `rest` has no substitutes because rest is the fallback.
 */
export const SUBSTITUTES: Record<SessionKind, SessionKind[]> = {
  run_easy: ["bike_endurance", "swim_technique"],
  run_long: ["bike_endurance", "swim_technique"],
  run_threshold: ["bike_endurance", "swim_technique"],
  run_intervals: ["bike_endurance", "swim_technique"],
  compromised: ["station_work", "bike_endurance"],
  station_work: ["bike_endurance", "swim_technique"],
  bike_endurance: ["swim_technique", "run_easy"],
  swim_technique: ["bike_endurance", "run_easy"],
  strength_lower: ["strength_pull", "strength_push"],
  strength_push: ["strength_lower"],
  strength_pull: ["strength_lower"],
  rest: [],
};

/** Whether the athlete can actually get to the equipment a substitute needs. */
export interface CrossTraining {
  bike: boolean;
  swim: boolean;
}

/**
 * Which kinds need something the athlete may not have. Prescribing a ride to
 * someone with no bike is a session they cannot do — which reads, from their
 * side, exactly like the app not knowing anything about them.
 */
export const KIND_REQUIRES: Partial<Record<SessionKind, keyof CrossTraining>> = {
  bike_endurance: "bike",
  swim_technique: "swim",
};

/** Can this athlete actually do this kind of session at all? */
export function isAvailable(kind: SessionKind, available: CrossTraining): boolean {
  const needs = KIND_REQUIRES[kind];
  return needs === undefined || available[needs];
}

/**
 * The substitute to offer for a forbidden session, or null when there isn't
 * one — which is an honest rest day, not a silent omission.
 *
 * `taken` is the kinds already scheduled on that date: swapping a forbidden
 * run onto a day that already has a ride would merge two sessions into one
 * and quietly halve the day.
 */
export function pickSubstitute(
  kind: SessionKind,
  restrictions: Restriction[],
  available: CrossTraining,
  taken: SessionKind[] = [],
): SessionKind | null {
  for (const candidate of SUBSTITUTES[kind]) {
    if (isForbidden(candidate, restrictions)) continue;
    if (!isAvailable(candidate, available)) continue;
    if (taken.includes(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * A substitute is a modality the athlete may not train often, taken on while
 * something hurts — so it is scaled by how bad the injury is. This applies
 * ONLY to a substituted session: a broken wrist does not shorten a run.
 */
export const SUBSTITUTE_LOAD_FACTOR: Record<Severity, number> = { 1: 1.0, 2: 0.85, 3: 0.7 };

/**
 * A body-part suggestion, for pre-ticking the form's checkboxes. The engine
 * NEVER reads `bodyPart` — it acts on the restrictions the athlete confirmed,
 * because a suggestion the athlete silently disagreed with would be a guess
 * steering their week.
 */
export const SUGGESTED_RESTRICTIONS: Record<BodyPart, Restriction[]> = {
  foot: ["no_impact"],
  ankle: ["no_impact"],
  shin: ["no_impact"],
  calf: ["no_running"],
  knee: ["no_running", "no_lower"],
  hamstring: ["no_running"],
  quad: ["no_running"],
  hip: ["no_running", "no_lower"],
  lower_back: ["no_impact", "no_lower"],
  upper_back: ["no_upper"],
  shoulder: ["no_upper"],
  elbow: ["no_upper"],
  wrist: ["no_upper"],
  other: [],
};

/*
 * ─── Intensity ceilings under a condition ──────────────────────────────────
 */

export const CONDITION_CEILINGS = ["easy", "threshold"] as const;
/** How hard a condition permits going. Deliberately narrower than the phase ceilings — a condition never RAISES a ceiling, so there is no "full". */
export type ConditionCeiling = (typeof CONDITION_CEILINGS)[number];

export const CONDITION_CEILING_LABELS: Record<ConditionCeiling, string> = {
  easy: "easy aerobic work only",
  threshold: "steady work is fine, nothing flat out",
};

/**
 * The kind this session becomes under a ceiling.
 *
 * "Easy" goes through `downgradeToEasy`, which walks the downgrade table to a
 * FIXED POINT. A single step takes intervals to a threshold run — still a
 * hard session, handed to someone with a fever. Two steps get to the easy run
 * that was meant. Anything meaning "easy" goes through here.
 */
export function applyConditionCeiling(kind: SessionKind, ceiling: ConditionCeiling): SessionKind {
  return ceiling === "easy" ? downgradeToEasy(kind) : applyCeiling(kind, "threshold");
}

/*
 * ─── Illness ───────────────────────────────────────────────────────────────
 */

export interface IllnessRule {
  /** Nothing at all today. */
  restOnly: boolean;
  /** How hard training may go while it is open. Ignored when `restOnly`. */
  ceiling: ConditionCeiling;
  /** What is left of the session's planned minutes. */
  loadFactor: number;
  /** The athlete's words for why, used to build reason strings — never the severity number. */
  label: string;
}

/**
 * The neck check, encoded. Above the neck you can train easy; below it you
 * train less; with a fever you do not train, because myocarditis is a real
 * outcome of training through a systemic illness and no session is worth it.
 */
export const ILLNESS_RULES: Record<Severity, IllnessRule> = {
  1: { restOnly: false, ceiling: "easy", loadFactor: 0.7, label: "it's above the neck — easy only, and shorter" },
  2: { restOnly: false, ceiling: "easy", loadFactor: 0.5, label: "it's below the neck — very easy and short, or skip it" },
  3: { restOnly: true, ceiling: "easy", loadFactor: 0, label: "a fever means no training until you mark it healed" },
};

/*
 * ─── Return to training ────────────────────────────────────────────────────
 */

export interface RampStage {
  days: number;
  ceiling: ConditionCeiling;
  loadFactor: number;
  /** Athlete-facing; used verbatim in reason strings. */
  label: string;
}

/**
 * How the return is shaped, by severity.
 *
 * Severity sets HOW CAUTIOUS the return is (the ceiling schedule and how much
 * load comes back), and a length MODIFIER — but not the length itself. That
 * comes from how long the athlete was actually out, because severity is how
 * much it hurt, not how detrained you are. A "niggle" that kept someone off
 * running for eight weeks costs exactly as much fitness as a bad one did, and
 * giving it the shortest ramp because it was ticked as a 1 is how an athlete
 * gets re-injured in the first week back.
 */
export interface RampProfile {
  /** Multiplies the time-off-derived stage length. */
  lengthModifier: number;
  easy: { ceiling: ConditionCeiling; loadFactor: number; label: string };
  threshold: { ceiling: ConditionCeiling; loadFactor: number; label: string };
}

export const RAMP_BY_SEVERITY: Record<Severity, RampProfile> = {
  1: {
    lengthModifier: 0.6,
    easy: { ceiling: "easy", loadFactor: 0.8, label: "easy work only" },
    threshold: { ceiling: "threshold", loadFactor: 0.9, label: "steady work back, nothing flat out" },
  },
  2: {
    lengthModifier: 1.0,
    easy: { ceiling: "easy", loadFactor: 0.6, label: "easy work only" },
    threshold: { ceiling: "threshold", loadFactor: 0.8, label: "steady work back, nothing flat out" },
  },
  3: {
    lengthModifier: 1.4,
    easy: { ceiling: "easy", loadFactor: 0.5, label: "easy work only" },
    threshold: { ceiling: "threshold", loadFactor: 0.7, label: "steady work back, nothing flat out" },
  },
};

/**
 * Each stage runs for this share of the days the condition was open, times
 * the severity modifier — so the whole return is roughly as long as the time
 * out, more for a bad one and less for a niggle, and always at least a day
 * per stage. Capped, because a six-month injury does not earn a five-month
 * ramp from a table this simple; what it earns is the `at_risk` annotation
 * telling the athlete that this is beyond what the app can plan.
 */
export const RAMP_STAGE_SHARE = 0.4;
export const RAMP_MAX_STAGE_DAYS = 21;

/** The days this condition was open, end to end — the input the ramp length is derived from. */
export function daysOff(c: Condition): number {
  return c.closedAt === null ? 0 : daysBetween(c.openedAt, c.closedAt) + 1;
}

function rampStageDays(c: Condition): number {
  const raw = daysOff(c) * RAMP_STAGE_SHARE * RAMP_BY_SEVERITY[c.severity].lengthModifier;
  return Math.min(RAMP_MAX_STAGE_DAYS, Math.max(1, Math.round(raw)));
}

/** The two stages this condition's return is made of, lengths already derived from its time off. */
export function rampStagesFor(c: Condition): RampStage[] {
  const profile = RAMP_BY_SEVERITY[c.severity];
  const days = rampStageDays(c);
  return [
    { days, ...profile.easy },
    { days, ...profile.threshold },
  ];
}

export interface RampPosition {
  stage: RampStage;
  /** 0 = the easy stage, 1 = the threshold stage. */
  stageIndex: number;
  /** 1-based day within this stage — "day 2 of the return". */
  dayIndex: number;
  /** Last date this stage covers. */
  stageEndsOn: string;
  /** First date steady work is allowed again. */
  thresholdFrom: string;
  /** First date with no ramp restriction at all. */
  fullFrom: string;
}

/**
 * Where in the return-to-training ramp this DATE falls, or null if it isn't
 * in one — still open, on or before the day it closed, or already past the
 * ramp entirely.
 *
 * Per-date for the same reason `isOpenOn` is: a week is adjusted session by
 * session, and Tuesday can be in the easy stage while Saturday is out of the
 * ramp completely.
 */
export function rampStageOn(c: Condition, date: string): RampPosition | null {
  if (c.closedAt === null) return null;
  const dayOffset = daysBetween(c.closedAt, date);
  if (dayOffset < 1) return null;

  const stages = rampStagesFor(c);
  const thresholdFrom = addDays(c.closedAt, stages[0]!.days + 1);
  const fullFrom = addDays(c.closedAt, stages[0]!.days + stages[1]!.days + 1);

  let consumed = 0;
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;
    if (dayOffset <= consumed + stage.days) {
      return {
        stage,
        stageIndex: i,
        dayIndex: dayOffset - consumed,
        stageEndsOn: addDays(c.closedAt, consumed + stage.days),
        thresholdFrom,
        fullFrom,
      };
    }
    consumed += stage.days;
  }
  return null;
}

/*
 * ─── Open, suspended, and the per-date view ────────────────────────────────
 */

/**
 * How many days this condition has been open as of `today`, inclusive.
 *
 * Counts to the day it closed if it closed, so a healed condition's count
 * stops growing. 0 before it started, because a condition opened tomorrow is
 * not a condition.
 */
export function daysOpen(c: Condition, today: string): number {
  if (today < c.openedAt) return 0;
  const end = c.closedAt !== null && c.closedAt < today ? c.closedAt : today;
  return daysBetween(c.openedAt, end) + 1;
}

/**
 * After this long with no edit, an open condition stops steering the plan and
 * the athlete is asked whether it is still true.
 */
export const CONDITION_SUSPEND_DAYS = 28;

/**
 * Has this open condition gone stale?
 *
 * Four weeks of silence almost always means it healed and nobody came back to
 * say so — and a forgotten condition that keeps routing running out of every
 * week is the Phase 3 archetype exactly: dead state still steering the plan.
 *
 * So it stops contributing, and the UI asks. What it does NOT do is close
 * itself: the app never observed anyone healing, and writing down that it did
 * would be a guess recorded as a fact — the same mistake `Measured<T>` exists
 * to prevent, one layer up.
 */
export function isSuspended(c: Condition, today: string): boolean {
  if (c.closedAt !== null) return false;
  const lastTouched = c.updatedAt.slice(0, 10);
  return daysBetween(lastTouched, today) >= CONDITION_SUSPEND_DAYS;
}

export interface ConditionsOnDate {
  /** Open on this date and still trusted — these are what the week is adjusted around. */
  open: Condition[];
  /** Closed, and this date falls inside the return-to-training ramp. */
  ramping: Array<{ condition: Condition; ramp: RampPosition }>;
  /** Open on paper, but stale (see `isSuspended`). Contributes nothing; shown so the athlete can confirm or close it. */
  suspended: Condition[];
}

/**
 * The single per-date view every consumer uses.
 *
 * `today` is separate from `date` on purpose: whether a condition is OPEN is a
 * fact about the date being planned, while whether it has gone stale is a
 * fact about now. Collapsing the two would make a four-week-old condition
 * suspended on Monday's session and live on Friday's.
 */
export function conditionsOn(conditions: Condition[], date: string, today: string = date): ConditionsOnDate {
  const open: Condition[] = [];
  const suspended: Condition[] = [];
  const ramping: ConditionsOnDate["ramping"] = [];

  for (const c of conditions) {
    if (isOpenOn(c, date)) {
      if (isSuspended(c, today)) suspended.push(c);
      else open.push(c);
      continue;
    }
    const ramp = rampStageOn(c, date);
    if (ramp) ramping.push({ condition: c, ramp });
  }
  return { open, ramping, suspended };
}

/** The union of everything these conditions rule out. */
export function openRestrictions(open: Condition[]): Restriction[] {
  const seen = new Set<Restriction>();
  for (const c of open) for (const r of c.restrictions) seen.add(r);
  return RESTRICTIONS.filter((r) => seen.has(r));
}

/** The worst severity among these conditions, or null for none — what a substitute is scaled by. */
export function maxSeverity(conditions: Condition[]): Severity | null {
  let worst: Severity | null = null;
  for (const c of conditions) if (worst === null || c.severity > worst) worst = c.severity;
  return worst;
}

/** The open illnesses among these, worst first — the rule that applies is the worst one's. */
export function openIllnesses(open: Condition[]): Condition[] {
  return open.filter((c) => c.kind === "illness").sort((a, b) => b.severity - a.severity);
}

/*
 * ─── What the athlete can actually cross-train on ──────────────────────────
 */

/**
 * ONE rule, shared by the server and the client, so the form's "I have a
 * bike" checkbox and the engine's substitution decision can never disagree.
 *
 * A live triathlon or cycling goal is proof of a bike; a triathlon or
 * swimming goal is proof of pool access. Inference only ADDS — the athlete's
 * own answer is never overwritten by a goal, and a goal that has already
 * happened proves nothing about today.
 */
export function crossTrainingAvailability(goals: Goal[], features: FeaturePreferences, today: string): CrossTraining {
  const live = goals.filter((g) => g.active && g.targetDate >= today);
  return {
    bike: features.hasBike || live.some((g) => g.discipline === "triathlon" || g.discipline === "cycling"),
    swim: features.hasPool || live.some((g) => g.discipline === "triathlon" || g.discipline === "swimming"),
  };
}

/*
 * ─── Goal risk ─────────────────────────────────────────────────────────────
 */

/** How much wider a prediction's band gets at each risk level. It NEVER moves the point estimate — see the note above. */
export const RISK_BAND_MULTIPLIER: Record<RiskLevel, number> = { none: 1, watch: 1.25, at_risk: 1.5 };

/** The window risk is counted over. Four weeks: long enough that one missed session isn't a crisis, short enough that a healed injury stops counting. */
export const RISK_WINDOW_DAYS = 28;

function weeksPhrase(weeksOut: number): string {
  if (weeksOut < 1) return "less than a week out";
  const weeks = Math.round(weeksOut);
  return `${weeks} week${weeks === 1 ? "" : "s"} out`;
}

function listLabels(labels: string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * What the open conditions have cost THIS goal.
 *
 * The goal's most important session is `qualitiesFor(...)[0]` — the existing
 * "what matters for this goal" statement, reused rather than restated, so a
 * triathlete's risk is measured against their long ride and a marathoner's
 * against their long run without a second table to keep in sync.
 *
 * The window ends at `min(asOf, today)`: days that have not happened yet
 * cannot have been lost. So a plan drawn for a week in November reports the
 * risk as it stands today rather than projecting an injury forward, which
 * would be a guess wearing a number's clothes. Weeks-out, by contrast, is
 * measured from `asOf` — that week really is closer to the race.
 *
 * Never called for a past or inactive goal: a goal that is over cannot be at
 * risk, and Phase 3's bug was precisely a dead goal still being consulted.
 */
export function assessGoalRisk(goal: Goal, conditions: Condition[], asOf: string, today: string): GoalRisk {
  const anchorKind = qualitiesFor(goal.type, goal.discipline)[0]!;
  const otherKinds = qualitiesFor(goal.type, goal.discipline).slice(1);
  const windowEnd = asOf < today ? asOf : today;

  let daysLost = 0;
  let daysCapped = 0;
  const labels = new Set<string>();

  for (let i = 0; i < RISK_WINDOW_DAYS; i++) {
    const date = addDays(windowEnd, -i);
    const { open } = conditionsOn(conditions, date, today);
    if (open.length === 0) continue;

    const restricted = openRestrictions(open);
    const restOnly = openIllnesses(open).some((c) => ILLNESS_RULES[c.severity].restOnly);
    const anchorGone = restOnly || isForbidden(anchorKind, restricted);
    const anchorCapped = openIllnesses(open).length > 0 || otherKinds.some((k) => isForbidden(k, restricted));

    if (anchorGone) {
      daysLost++;
      for (const c of open) labels.add(c.label);
    } else if (anchorCapped) {
      daysCapped++;
      for (const c of open) labels.add(c.label);
    }
  }

  // "Still going on" is evaluated at the end of the window, not at `asOf` —
  // an open condition has no end date, and reading that as "still open in
  // November" is the projection this function refuses to make.
  const { open: openNowConditions } = conditionsOn(conditions, windowEnd, today);
  const openNow =
    openNowConditions.length > 0 &&
    (openIllnesses(openNowConditions).some((c) => ILLNESS_RULES[c.severity].restOnly) ||
      isForbidden(anchorKind, openRestrictions(openNowConditions)));

  const weeksOut = Math.max(0, weeksUntil(asOf, goal.targetDate));

  let level: RiskLevel = "none";
  if ((daysLost >= 7 && weeksOut <= 12) || (openNow && weeksOut <= 3) || daysLost >= 14) level = "at_risk";
  else if (daysLost >= 3 || openNow || daysCapped >= 7) level = "watch";

  const conditionLabels = [...labels];
  const anchorWords = TITLE_OF[anchorKind].toLowerCase();
  const because = conditionLabels.length > 0 ? ` — ${listLabels(conditionLabels)}` : "";

  let note: string;
  if (level === "none" && daysLost === 0 && daysCapped === 0) {
    note = `${goal.label}: nothing in the last four weeks has got in the way of the ${anchorWords}. ${weeksPhrase(weeksOut)}.`;
  } else if (daysLost > 0) {
    note =
      `${goal.label}: ${daysLost} of the last 28 days, the ${anchorWords} couldn't happen${because}. ` +
      `${weeksPhrase(weeksOut)}` +
      (level === "at_risk"
        ? ` — both the plan and the prediction assume training that hasn't happened.`
        : `, so it's worth watching.`);
  } else {
    note =
      `${goal.label}: ${daysCapped} of the last 28 days had to be scaled back${because}, ` +
      `though the ${anchorWords} still went ahead. ${weeksPhrase(weeksOut)}.`;
  }

  return { level, daysLost, daysCapped, conditionLabels, anchorKind, windowDays: RISK_WINDOW_DAYS, note };
}

/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  Validation — DB-free, the same role server/goalValidation.ts plays for goals
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every write path goes through here: the REST endpoint, and the chat tool
 * that will eventually let an athlete say "I tweaked my calf yesterday". A
 * tool schema is a hint to a model, not an enforcement mechanism, so a
 * hallucinated restriction or a date in the future is rejected here exactly
 * as a bad form submission is.
 */

export class InvalidConditionError extends Error {}

export const MAX_CONDITION_LABEL = 80;
export const MAX_CONDITION_NOTE = 500;

export interface ConditionInput {
  kind: ConditionKind;
  label: string;
  bodyPart?: BodyPart | null;
  severity: Severity;
  /** `"none"` is an explicit "this rules nothing out", distinguishable from "the caller didn't say". */
  restrictions?: Restriction[] | "none";
  openedAt?: string;
  note?: string | null;
}

/** What validation hands back: defaults resolved, so the service writes one shape and never re-decides. */
export interface NormalizedConditionInput {
  kind: ConditionKind;
  label: string;
  bodyPart: BodyPart | null;
  severity: Severity;
  restrictions: Restriction[];
  openedAt: string;
  note: string | null;
}

export type ConditionPatch = Partial<Pick<Condition, "label" | "bodyPart" | "severity" | "restrictions" | "openedAt" | "closedAt" | "note">>;

const PATCHABLE = ["label", "bodyPart", "severity", "restrictions", "openedAt", "closedAt", "note"] as const;

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidConditionError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new InvalidConditionError("label is required");
  const trimmed = value.trim();
  if (trimmed.length > MAX_CONDITION_LABEL) throw new InvalidConditionError(`label must be ${MAX_CONDITION_LABEL} characters or fewer`);
  return trimmed;
}

function validSeverity(value: unknown): Severity {
  if (!(SEVERITIES as readonly unknown[]).includes(value)) throw new InvalidConditionError(`severity must be one of ${SEVERITIES.join(", ")}`);
  return value as Severity;
}

function validBodyPart(value: unknown): BodyPart | null {
  if (value === null || value === undefined || value === "") return null;
  if (!(BODY_PARTS as readonly unknown[]).includes(value)) throw new InvalidConditionError(`bodyPart must be one of ${BODY_PARTS.join(", ")}`);
  return value as BodyPart;
}

function validRestrictions(value: unknown): Restriction[] {
  if (value === "none" || value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new InvalidConditionError("restrictions must be an array");
  for (const r of value) {
    if (!(RESTRICTIONS as readonly unknown[]).includes(r)) throw new InvalidConditionError(`restrictions must each be one of ${RESTRICTIONS.join(", ")}`);
  }
  // Deduped in declaration order, so two clients ticking the same boxes in a
  // different order store the same row.
  return RESTRICTIONS.filter((r) => (value as Restriction[]).includes(r));
}

function validNote(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new InvalidConditionError("note must be text");
  if (value.length > MAX_CONDITION_NOTE) throw new InvalidConditionError(`note must be ${MAX_CONDITION_NOTE} characters or fewer`);
  return value;
}

function validDate(value: unknown, field: string): string {
  if (!isValidISODate(value)) throw new InvalidConditionError(`${field} must be a valid YYYY-MM-DD date`);
  return value;
}

export function validateConditionInput(input: unknown, today: string): NormalizedConditionInput {
  const raw = asRecord(input, "condition");
  if (!(CONDITION_KINDS as readonly unknown[]).includes(raw.kind)) {
    throw new InvalidConditionError(`kind must be one of ${CONDITION_KINDS.join(", ")}`);
  }
  const openedAt = raw.openedAt === undefined || raw.openedAt === null ? today : validDate(raw.openedAt, "openedAt");
  // A condition that starts tomorrow is not a fact about the body, it is a
  // prediction — and it would sit silently inert until the date arrived.
  if (openedAt > today) throw new InvalidConditionError("openedAt cannot be in the future");
  return {
    kind: raw.kind as ConditionKind,
    label: validLabel(raw.label),
    bodyPart: validBodyPart(raw.bodyPart),
    severity: validSeverity(raw.severity),
    restrictions: validRestrictions(raw.restrictions),
    openedAt,
    note: validNote(raw.note),
  };
}

/**
 * A patch is validated against the row it is changing, because half of what
 * makes a patch valid is the other half of the row: a `closedAt` is only
 * meaningful relative to the `openedAt` it will sit next to, whichever of the
 * two this patch happens to be setting.
 */
export function validateConditionPatch(patch: unknown, existing: Condition, today: string): ConditionPatch {
  const raw = asRecord(patch, "patch");
  for (const key of Object.keys(raw)) {
    if (!(PATCHABLE as readonly string[]).includes(key)) {
      throw new InvalidConditionError(`a condition has no "${key}" to change — try one of ${PATCHABLE.join(", ")}`);
    }
  }

  const out: ConditionPatch = {};
  if ("label" in raw) out.label = validLabel(raw.label);
  if ("bodyPart" in raw) out.bodyPart = validBodyPart(raw.bodyPart);
  if ("severity" in raw) out.severity = validSeverity(raw.severity);
  if ("restrictions" in raw) out.restrictions = validRestrictions(raw.restrictions);
  if ("note" in raw) out.note = validNote(raw.note);
  if ("openedAt" in raw) out.openedAt = validDate(raw.openedAt, "openedAt");
  if ("closedAt" in raw) out.closedAt = raw.closedAt === null ? null : validDate(raw.closedAt, "closedAt");

  const openedAt = out.openedAt ?? existing.openedAt;
  const closedAt = "closedAt" in raw ? out.closedAt! : existing.closedAt;

  if (openedAt > today) throw new InvalidConditionError("openedAt cannot be in the future");
  if (closedAt !== null) {
    if (closedAt > today) throw new InvalidConditionError("a condition cannot be marked healed on a date that hasn't happened yet");
    if (closedAt < openedAt) throw new InvalidConditionError("a condition cannot be marked healed before it started");
  }
  return out;
}
