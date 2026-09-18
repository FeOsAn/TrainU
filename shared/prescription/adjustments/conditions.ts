/**
 * The conditions slice of the modulation layer: what an injury or an illness
 * does to the week that was prescribed for a healthy athlete.
 *
 * Two functions, deliberately, per DECISIONS B2:
 *
 *   applyConditions   — the full rules, scheduled ONCE, second in the pipeline.
 *   enforceConditions — scheduled LAST, only the two idempotent predicates.
 *
 * The split is not tidiness, it is a correctness property. Three of the five
 * rules below SCALE a session (× 0.85, × 0.5, × 0.6), and scaling is
 * multiplicative: running the same rules twice over their own output gives
 * 0.85 × 0.85 = 0.72, a week quietly 28% smaller than anything anyone
 * decided on. So the dosing pass runs exactly once, and what runs at the end
 * is a pure predicate on the session's CURRENT kind — "is this kind ruled
 * out, yes or no" — which is genuinely idempotent and can therefore sit
 * behind every other slice as a guard. If a later step ever downgrades a
 * session back into something the athlete's body rules out, the guard
 * catches it; if it does not, the guard changes nothing, and a test pins
 * that.
 *
 * Everything this file DECIDES lives in `shared/conditions.ts` — which kinds
 * a restriction forbids, what to substitute, the illness rules, the return
 * ramp. This file only sequences those tables over a week and writes the
 * sentences the athlete reads. Two files that both know that a calf strain
 * rules out running is the drift this codebase keeps paying to avoid.
 *
 * Per DATE, never per "today": every session is judged against the
 * conditions that were open ON ITS OWN DAY. Monday's session sees the strain
 * and Saturday's — after it was marked healed on Thursday — does not. That
 * is the Phase 3 archetype's defence, one layer down from where it bit.
 */

import type { AthleteParams } from "../../athlete";
import {
  type Condition,
  type ConditionCeiling,
  type CrossTraining,
  ILLNESS_RULES,
  KIND_REQUIRES,
  type RampPosition,
  RESTRICTION_LABELS,
  type Restriction,
  SUBSTITUTES,
  SUBSTITUTE_LOAD_FACTOR,
  applyConditionCeiling,
  conditionsOn,
  isAvailable,
  isForbidden,
  maxSeverity,
  openIllnesses,
  openRestrictions,
  pickSubstitute,
} from "../../conditions";
import { daysBetween } from "../../dates";
import {
  type AdjustedSession,
  type AthleteState,
  type SessionChange,
  type WorkingWeek,
  dropSessionAt,
  adjustSessionAt,
  isAnswered,
  registerModulator,
  restDay,
} from "../adjust";
import type { SessionKind } from "../sessionKinds";
import { INTENSITY_OF, TITLE_OF, clampKind, equivalentMinutes } from "../templates";

/*
 * ─── Sizing ───────────────────────────────────────────────────────────────
 */

/**
 * The shortest a scaled-down session is allowed to get.
 *
 * Deliberately NOT `KIND_MINUTES[kind].min`. That bound says how long a
 * HEALTHY version of this session is, and an illness-shortened one is meant
 * to be below it — "very easy and short, or skip it" is the instruction, and
 * clamping a 30-minute easy run back up to 30 minutes for someone with a
 * chest infection would silently cancel the only thing this rule does. What
 * it must not become is a session too short to be worth changing out of.
 */
export const MIN_REDUCED_MINUTES = 10;

/** A session cut by an illness or a ramp: the same session, less of it. */
export function reducedMinutes(minutes: number, factor: number): number {
  return Math.max(MIN_REDUCED_MINUTES, Math.round(minutes * factor));
}

/**
 * How long the substitute is (DECISIONS C1).
 *
 * LOAD first, then dose. `equivalentMinutes` converts across sports so the
 * ride carries the run's training stress rather than its clock time — 60
 * minutes of running is 73 of riding, and swapping minute-for-minute would
 * be an unannounced 18% rest day. Only then is the severity factor applied,
 * because that is a deliberate decision to ask for LESS than the session it
 * replaces while something hurts.
 *
 * `factor` is 1 in the end-of-pipeline guard: that pass exists to turn an
 * impossible session into a possible one, and it must be idempotent, so it
 * does not get to make a dosing decision on top.
 */
export function substituteMinutes(
  fromKind: SessionKind,
  toKind: SessionKind,
  minutes: number,
  factor: number,
): number {
  return clampKind(toKind, equivalentMinutes(fromKind, toKind, minutes) * factor);
}

/*
 * ─── Words ────────────────────────────────────────────────────────────────
 *
 * Every sentence below is built from label tables, never from an identifier.
 * `no_running` is a database value; "Can't run" is what a person reads
 * (DECISIONS C7). The athlete's own condition label ("Left calf strain") is
 * used verbatim, because they wrote it.
 */

/** The two pieces of kit a substitute can need, in the athlete's words. Keyed off `CrossTraining` so a third one fails `tsc` here until it has words. */
export const EQUIPMENT_LABELS: Record<keyof CrossTraining, string> = {
  bike: "a bike",
  swim: "a pool",
};

/** How the athlete turns each one on — a reason that names a missing thing owes them the fix. */
export const EQUIPMENT_FIX_LABELS: Record<keyof CrossTraining, string> = {
  bike: '"I have a bike"',
  swim: '"I can get to a pool"',
};

/**
 * Said about a substitute whose numbers come off a value nobody has
 * measured. The hard rule made audible: the app cannot make a seeded FTP
 * true, but it can stop a power target reading like a measurement to an
 * athlete who has never been tested.
 */
const SEED_CAVEATS: Partial<Record<SessionKind, (athlete: AthleteParams) => string | null>> = {
  bike_endurance: (a) =>
    a.ftpWatts.verified ? null : "Ride it by feel — that power target is off an untested FTP, not a measurement.",
  swim_technique: (a) =>
    a.cssSecPer100m.verified ? null : "Swim it by feel — that pace is off an untested swim threshold, not a measurement.",
};

function seedCaveat(kind: SessionKind, athlete: AthleteParams): string | null {
  return SEED_CAVEATS[kind]?.(athlete) ?? null;
}

/** "A", "A and B", "A, B and C" — a list a person would say out loud. */
function listOf(items: string[]): string {
  const unique = items.filter((item, i) => items.indexOf(item) === i);
  if (unique.length <= 1) return unique[0] ?? "";
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

function sentence(...parts: Array<string | null>): string {
  return parts.filter((p): p is string => !!p).join(" ");
}

/*
 * ─── Which conditions are speaking ────────────────────────────────────────
 */

/** The open conditions whose own restrictions rule this kind out — the ones a reason can honestly name. */
function causesFor(kind: SessionKind, open: Condition[]): Condition[] {
  return open.filter((c) => isForbidden(kind, c.restrictions));
}

/** The restrictions that rule this kind out, in the athlete's words. */
function whyForbidden(kind: SessionKind, restrictions: Restriction[]): string {
  return listOf(restrictions.filter((r) => isForbidden(kind, [r])).map((r) => RESTRICTION_LABELS[r]));
}

const CEILING_RANK: Record<ConditionCeiling, number> = { easy: 0, threshold: 1 };

/** With two returns running at once the stricter one wins: the body is in both, so it gets the more careful of the two. */
function strictestRamp(
  ramping: Array<{ condition: Condition; ramp: RampPosition }>,
): { condition: Condition; ramp: RampPosition } | null {
  return (
    [...ramping].sort(
      (a, b) =>
        CEILING_RANK[a.ramp.stage.ceiling] - CEILING_RANK[b.ramp.stage.ceiling] ||
        a.ramp.stage.loadFactor - b.ramp.stage.loadFactor,
    )[0] ?? null
  );
}

/*
 * ─── Removing a session ───────────────────────────────────────────────────
 */

/**
 * Take this session out — and leave a rest card behind if it was the last
 * thing on the day.
 *
 * `restDay` clears the WHOLE date, so it is only right when nothing else is
 * on it: a calf strain that rules out Tuesday's run has no opinion about
 * Tuesday's bench press, and resting the day would remove a session the
 * athlete can do. Either way the session stays in `dropped` with its reason,
 * so it is still rendered and still tickable by someone who did it anyway
 * (DECISIONS B7).
 */
function removeSession(week: WorkingWeek, session: AdjustedSession, change: SessionChange, state: AthleteState): boolean {
  const index = week.sessions.indexOf(session);
  if (index < 0) return false;
  const othersOnDay = week.sessions.some(
    (s) => s !== session && s.date === session.date && s.kind !== "rest" && !isAnswered(s, state),
  );
  if (othersOnDay) return dropSessionAt(week, index, change, state);
  return restDay(week, session.date, change, state) > 0;
}

/*
 * ─── The five rules ───────────────────────────────────────────────────────
 */

/** (a) A fever is not a training decision. The whole day goes, including anything else on it. */
function restWholeDay(week: WorkingWeek, date: string, illness: Condition, state: AthleteState): void {
  restDay(
    week,
    date,
    {
      source: "condition",
      conditionId: illness.id,
      reason: `Today is rest: you have ${illness.label} open, and ${ILLNESS_RULES[illness.severity].label}.`,
    },
    state,
  );
}

/** (b) The kind is ruled out. Swap it for something that isn't — or, honestly, for nothing. */
function substituteForbidden(
  week: WorkingWeek,
  session: AdjustedSession,
  open: Condition[],
  restrictions: Restriction[],
  factor: number,
  state: AthleteState,
): void {
  const index = week.sessions.indexOf(session);
  if (index < 0) return;

  const causes = causesFor(session.kind, open);
  const conditionId = causes[0]?.id;
  const blamed = listOf(causes.map((c) => c.label));
  const because = `${blamed || "Your open injury"} rules this one out (${whyForbidden(session.kind, restrictions)}).`;

  const taken = week.sessions.filter((s) => s.date === session.date).map((s) => s.kind);
  const substitute = pickSubstitute(session.kind, restrictions, state.available, taken);

  if (!substitute) {
    removeSession(
      week,
      session,
      {
        source: "condition",
        ...(conditionId ? { conditionId } : {}),
        reason: sentence(
          `Rest instead of ${TITLE_OF[session.kind]}.`,
          because,
          noSwapClause(session.kind, restrictions, taken, state.available),
        ),
      },
      state,
    );
    return;
  }

  // Stated in the order it is computed, because the two steps mean
  // different things: the first is an exchange rate between sports, the
  // second is a decision to ask for LESS than the session it replaces while
  // something hurts.
  const equivalent = equivalentMinutes(session.kind, substitute, session.durationMinutes);
  const minutes = substituteMinutes(session.kind, substitute, session.durationMinutes, factor);
  const length =
    factor < 1
      ? `Length is set by what the session costs you, not by the clock: ${session.durationMinutes} min becomes ${equivalent}, then ${Math.round(factor * 100)}% of that while this is open — ${minutes} min.`
      : `Length is set by what the session costs you, not by the clock: ${session.durationMinutes} min becomes ${minutes}.`;
  // Said plainly rather than left for the athlete to notice: a substitute
  // replaces a session's VOLUME. When the session it replaces was a hard
  // one, its intensity is simply gone, and claiming otherwise would be a
  // number the week's own load total contradicts.
  const lostIntensity =
    INTENSITY_OF[session.kind] !== "easy" && INTENSITY_OF[substitute] === "easy"
      ? "It replaces the volume, not the intensity — that part isn't on the table while this is open."
      : null;

  adjustSessionAt(
    week,
    index,
    { kind: substitute, durationMinutes: minutes },
    {
      source: "condition",
      ...(conditionId ? { conditionId } : {}),
      reason: sentence(
        `${TITLE_OF[substitute]} instead of ${TITLE_OF[session.kind]}.`,
        because,
        length,
        lostIntensity,
        seedCaveat(substitute, state.params),
      ),
    },
    state,
  );
}

/**
 * Why there was nothing to swap onto — every blocker named, not just the
 * first one.
 *
 * A rest day with no explanation reads as the app giving up, and a rest day
 * blamed on one missing thing when two were missing sends the athlete to fix
 * the wrong one. So each candidate is reported under the reason it failed,
 * and the one the athlete can actually do something about comes last, next
 * to the fix.
 */
function noSwapClause(
  kind: SessionKind,
  restrictions: Restriction[],
  taken: SessionKind[],
  available: CrossTraining,
): string {
  const candidates = SUBSTITUTES[kind];
  const ruledOut = candidates.filter((c) => isForbidden(c, restrictions));
  const allowed = candidates.filter((c) => !isForbidden(c, restrictions));
  const alreadyOnTheDay = allowed.filter((c) => isAvailable(c, available) && taken.includes(c));
  const missingKit = allowed
    .filter((c) => !isAvailable(c, available))
    .map((c) => KIND_REQUIRES[c])
    .filter((need): need is keyof CrossTraining => need !== undefined);

  const parts: string[] = [];
  if (ruledOut.length > 0) {
    parts.push(
      `${listOf(ruledOut.map((c) => TITLE_OF[c]))} ${ruledOut.length === 1 ? "is" : "are"} ruled out too.`,
    );
  }
  if (alreadyOnTheDay.length > 0) {
    parts.push(
      `${listOf(alreadyOnTheDay.map((c) => TITLE_OF[c]))} is already on that day, and doing it twice is not the same session.`,
    );
  }
  if (missingKit.length > 0) {
    const kit = listOf(missingKit.map((need) => EQUIPMENT_LABELS[need]));
    const fix = listOf(missingKit.map((need) => EQUIPMENT_FIX_LABELS[need]));
    parts.push(
      `Swapping it needs ${kit}, which you haven't said you have — tick ${fix} on your injury card and this becomes a session instead of a rest day.`,
    );
  }
  if (parts.length === 0) parts.push("There is nothing left to swap it for, so today is rest.");
  return parts.join(" ");
}

/** (c) An illness that still permits training: easier, and less of it. */
function easeForIllness(week: WorkingWeek, session: AdjustedSession, illness: Condition, state: AthleteState): void {
  const rule = ILLNESS_RULES[illness.severity];
  applyEasing(
    week,
    session,
    applyConditionCeiling(session.kind, rule.ceiling),
    reducedMinutes(session.durationMinutes, rule.loadFactor),
    (changed, before, after) =>
      changed
        ? `${TITLE_OF[changed]} instead of ${TITLE_OF[session.kind]}, ${before} → ${after} min: ${illness.label} is open, and ${rule.label}.`
        : `${TITLE_OF[session.kind]} cut from ${before} to ${after} min: ${illness.label} is open, and ${rule.label}.`,
    { source: "condition", conditionId: illness.id },
    state,
  );
}

/** (d) Back from something, but not back to normal: the stage the date falls in sets both the ceiling and the dose. */
function applyRamp(
  week: WorkingWeek,
  session: AdjustedSession,
  ramping: { condition: Condition; ramp: RampPosition },
  state: AthleteState,
): void {
  const { condition, ramp } = ramping;
  const { stage } = ramp;
  // Days since it was marked healed, not days into the current stage: "day 1
  // of 5" printed on the second stage reads as though the return restarted.
  const dayBack = condition.closedAt ? daysBetween(condition.closedAt, session.date) : ramp.dayIndex;
  // What comes back next, and when — a restriction with no end date reads
  // like a verdict rather than a stage.
  const returning = ramp.stageIndex === 0
    ? { days: daysBetween(session.date, ramp.thresholdFrom), label: "Steady work" }
    : { days: daysBetween(session.date, ramp.fullFrom), label: "Full training" };
  const ahead =
    returning.days > 0
      ? ` ${returning.label} comes back in ${returning.days} ${returning.days === 1 ? "day" : "days"}.`
      : "";

  applyEasing(
    week,
    session,
    applyConditionCeiling(session.kind, stage.ceiling),
    reducedMinutes(session.durationMinutes, stage.loadFactor),
    (changed, before, after) =>
      (changed
        ? `Day ${dayBack} back from ${condition.label}, still building up: ${stage.label}, so ${TITLE_OF[session.kind]} becomes ${TITLE_OF[changed]} and drops from ${before} to ${after} min.`
        : `Day ${dayBack} back from ${condition.label}, still building up: ${stage.label}, so ${TITLE_OF[session.kind]} drops from ${before} to ${after} min.`) + ahead,
    { source: "ramp", conditionId: condition.id },
    state,
  );
}

/**
 * The shared body of (c) and (d): a ceiling and a dose, applied through the
 * layer's mutator so the session's targets, its length and its price are
 * rebuilt together.
 *
 * Two things it refuses to do. It will not stamp a change that changes
 * nothing — a 30-minute easy run whose factor rounds it back to 30 has not
 * been adjusted, and saying so in "Changes this week" is noise the athlete
 * has to work out. And it will not downgrade a session onto a kind the day
 * already holds: `(date, kind)` is the completion key, so two of them means
 * one card can never be ticked. In that case the session comes out, which is
 * the honest version of what the downgrade was trying to say anyway.
 */
function applyEasing(
  week: WorkingWeek,
  session: AdjustedSession,
  nextKind: SessionKind,
  nextMinutes: number,
  reason: (changedKind: SessionKind | null, before: number, after: number) => string,
  change: Omit<SessionChange, "reason">,
  state: AthleteState,
): void {
  const index = week.sessions.indexOf(session);
  if (index < 0) return;
  const kindChanged = nextKind !== session.kind;
  if (!kindChanged && nextMinutes >= session.durationMinutes) return;

  if (kindChanged && week.sessions.some((s) => s !== session && s.date === session.date && s.kind === nextKind)) {
    removeSession(
      week,
      session,
      {
        ...change,
        reason: sentence(
          reason(nextKind, session.durationMinutes, nextMinutes),
          "You already have that session on the day, so this one comes out rather than being done twice.",
        ),
      },
      state,
    );
    return;
  }

  adjustSessionAt(
    week,
    index,
    { kind: nextKind, durationMinutes: nextMinutes },
    { ...change, reason: reason(kindChanged ? nextKind : null, session.durationMinutes, nextMinutes) },
    state,
  );
}

/*
 * ─── The two modulators ───────────────────────────────────────────────────
 */

/** Has this slice already made a dosing decision about this session? Read off the provenance the layer stamps — there is no second record to consult. */
function dosedByConditions(session: AdjustedSession): boolean {
  return (session.adjustedFrom?.sources ?? []).some((source) => source === "condition" || source === "ramp");
}

function datesIn(week: WorkingWeek): string[] {
  return Array.from(new Set(week.sessions.map((s) => s.date))).sort();
}

function walk(week: WorkingWeek, state: AthleteState, today: string, full: boolean): WorkingWeek {
  for (const date of datesIn(week)) {
    // Per DATE. `today` decides only whether a condition has gone stale
    // (`isSuspended`), which is a fact about now rather than about the day
    // being planned.
    const on = conditionsOn(state.conditions, date, today);

    const restOnly = openIllnesses(on.open).find((c) => ILLNESS_RULES[c.severity].restOnly);
    if (restOnly) {
      restWholeDay(week, date, restOnly, state);
      continue;
    }

    const restrictions = openRestrictions(on.open);
    const severity = maxSeverity(on.open);
    const illness = openIllnesses(on.open)[0] ?? null;
    const ramping = strictestRamp(on.ramping);
    if (restrictions.length === 0 && !illness && !ramping) continue;

    // Snapshot by IDENTITY, not by index: the rules below splice sessions
    // out and replace others in place, and an index captured before that is
    // a different session afterwards.
    const targets = week.sessions.filter((s) => s.date === date && s.kind !== "rest" && !isAnswered(s, state));

    for (const session of targets) {
      if (week.sessions.indexOf(session) < 0) continue; // already removed by an earlier rule on this day

      if (isForbidden(session.kind, restrictions)) {
        // The dose comes from the WORST thing open on the day, not from
        // whichever condition happened to rule this kind out: an athlete
        // with a niggle and a chest infection is not a niggle.
        substituteForbidden(week, session, on.open, restrictions, full ? SUBSTITUTE_LOAD_FACTOR[severity ?? 1] : 1, state);
        continue;
      }
      if (!full) continue;
      // Already dosed by this slice, on an earlier pass over the same week.
      //
      // The ceiling below is a decision about the session as PRESCRIBED, and
      // the factor that comes with it is multiplicative — 0.85 twice is 0.72,
      // a week nobody chose. The pipeline schedules this pass once
      // (DECISIONS B2), and this is the belt to that braces: re-running the
      // whole layer over its own output changes nothing, which is what makes
      // an adjusted week safe to feed back in.
      if (dosedByConditions(session)) continue;
      if (illness) {
        easeForIllness(week, session, illness, state);
        continue;
      }
      if (ramping) applyRamp(week, session, ramping, state);
    }
  }
  return week;
}

/**
 * The full rules, ONCE (DECISIONS B2). Second in the pipeline: what the body
 * rules out is decided before the morning's check-in gets an opinion about
 * how hard the rest of it should be.
 */
export function applyConditions(week: WorkingWeek, state: AthleteState, today: string): WorkingWeek {
  return walk(week, state, today, true);
}

/**
 * The guard, LAST. Only the two rules that are pure predicates on a
 * session's current kind: a fever means the day is rest, and a ruled-out
 * kind is not prescribed. No ceilings, no dose — those already happened, and
 * doing them again would compound.
 *
 * On a week that has already been through `applyConditions` this changes
 * nothing, which is the point: it costs one pass to be certain no later
 * slice handed an injured athlete a session their body rules out.
 */
export function enforceConditions(week: WorkingWeek, state: AthleteState, today: string): WorkingWeek {
  return walk(week, state, today, false);
}

/*
 * Registered at import, into the two stages DECISIONS B2 defines. A slice
 * cannot choose its position in the pipeline — the order IS the safety
 * property — so it only says which stage it is.
 */
registerModulator("conditions", applyConditions);
registerModulator("conditions_guard", enforceConditions);
