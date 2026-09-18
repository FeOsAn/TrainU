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
 * SCOPE OF THIS FILE RIGHT NOW: the declarations that the rest of the app
 * needs in order to compile and to be honest about an open condition —
 * the type, the runtime enums, their athlete-facing label tables, and the
 * per-date predicate. The coaching judgement (which session kinds each
 * restriction forbids, the substitute lists, the illness rules and the
 * return-to-training ramp) lands in THIS SAME FILE with the conditions
 * feature; it is deliberately not scattered across the modules that consume
 * it. Add it here, below.
 */

import type { SessionKind } from "./prescription/sessionKinds";

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
