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
import { WEEKDAY_LABELS, addDays, weekdayOf } from "../dates";
import {
  ANCHOR_KIND,
  BASELINE_MINUTES_PER_DAY,
  DEFAULT_PHASE_SHAPE,
  DOWNGRADE,
  FOCUS_OF,
  HARD_KINDS,
  INTENSITY_OF,
  KIND_MINUTES,
  PHASE_SHAPES,
  SPORT_OF,
  TITLE_OF,
  applyCeiling,
  clampKind,
  kindWeight,
  occurrenceShare,
  qualitiesFor,
  rpeFor,
} from "./templates";
import type { AdjustedFrom, PlannedSession, PlannedSport, PrescribedWeek, SessionKind, SessionOccurrence } from "./sessionKinds";

// FRESH_KM_TO_THRESHOLD / FRESH_KM_TO_INTERVAL live in shared/athlete.ts,
// next to the field they convert — see the note there about the predictor
// and the plan engine disagreeing about the same number.

/** A lift is 45-60 minutes whether the aerobic week is big or small, so it doesn't scale with the aerobic budget. */
const STRENGTH_MINUTES = 50;

const STRENGTH_KINDS: ReadonlySet<SessionKind> = new Set(["strength_lower", "strength_push", "strength_pull"]);

// SPORT_OF / INTENSITY_OF / HARD_KINDS / TITLE_OF / FOCUS_OF / clampKind /
// rpeFor now live in templates.ts: they answer "what IS this kind of
// session", which the modulation layer has to answer identically when it
// substitutes or downgrades one. One table, imported back here.

function pace(secPerKm: number): string {
  return `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, "0")}/km`;
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

/**
 * What the athlete calls a session of this sport, in a sentence. A label
 * table rather than a switch so a new sport fails `tsc` until it has words
 * the athlete would use — no identifier ever reaches a card.
 */
const SPORT_NOUN: Record<PlannedSport, string> = {
  run: "run",
  bike: "ride",
  swim: "swim",
  strength: "lift",
  hybrid: "session",
  station: "session",
  other: "session",
};

/**
 * Why two sessions of the same kind in one week are different lengths.
 *
 * Without this the athlete sees a 128-minute ride and an 84-minute ride with
 * identical targets and no stated reason, which reads as a bug rather than
 * as a plan. Decided from the split's OWN numbers instead of from whether
 * the kind decays in principle: when a ceiling flattens a split into three
 * near-equal swims, calling one of them "shorter" would be a sentence the
 * numbers contradict.
 */
function occurrenceNote(kind: SessionKind, occurrence: SessionOccurrence, split: number[], longDate: string): string | null {
  if (occurrence.of < 2 || split.length < 2) return null;
  const first = split[0]!;
  // Only when the first occurrence is strictly the longest. A ceiling can
  // flatten a split into two equal swims and a shorter one, and then there
  // is no "long one" to point at — so the plan says nothing rather than
  // something the minutes on the card contradict.
  if (first <= Math.max(...split.slice(1))) return null;
  const noun = SPORT_NOUN[SPORT_OF[kind]];
  if (occurrence.n === 1) {
    return occurrence.of === 2
      ? `The week's long ${noun} — the other one is shorter on purpose.`
      : `The week's long ${noun} — the others are shorter on purpose.`;
  }
  return `Shorter ${noun} (${occurrence.n} of ${occurrence.of}) — the long one is on ${WEEKDAY_LABELS[weekdayOf(longDate)]}.`;
}

export interface AssignDatesOptions {
  /**
   * The kind that gets the week's protected weekend slot. Defaults to
   * `run_long`, which is what this function did before it took options at
   * all — a runner's week is unchanged. Only the FIRST occurrence is pinned:
   * a cycling week with three rides pins one and spreads the rest.
   */
  anchorKind?: SessionKind;
  /**
   * Weekday offsets the athlete can actually train, 0 = Monday … 6 = Sunday.
   * Defaults to all seven.
   *
   * This is a HARD constraint and the weekend pin is only a preference. The
   * athlete's own statement about which days exist outranks the engine's
   * opinion about which day is nicest for a long session — pinning a long
   * run to a Saturday someone has told us they cannot train is worse than
   * any layout compromise.
   */
  trainingDays?: number[];
  /**
   * Explicit offsets by index into `kinds`, for a session the athlete (or an
   * earlier layer) has already placed. Highest precedence of all — including
   * over `trainingDays`, because a session pinned to a day is a statement
   * about that specific session, not a default.
   */
  pinned?: Record<number, number>;
}

const HARD_FIRST_CHOICE = [1, 3, 5, 0, 2, 4, 6];
const EASY_FIRST_CHOICE = [0, 2, 4, 6, 1, 3, 5];

/**
 * Lay the week out so hard days don't stack. The anchor takes the last
 * training day of the week — Saturday if it's available, else Sunday, else
 * the latest day that is — and everything else is spread across the
 * remaining days as evenly as the count allows.
 *
 * Precedence, in order: `pinned` › `trainingDays` › the weekend anchor
 * preference › the hard/easy spread. Called with no options it produces
 * exactly the offsets it always did.
 */
function assignDates(weekStart: string, kinds: SessionKind[], options: AssignDatesOptions = {}): string[] {
  const anchorKind = options.anchorKind ?? "run_long";
  const legal = (options.trainingDays ?? [0, 1, 2, 3, 4, 5, 6]).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const allowed = new Set<number>(legal.length > 0 ? legal : [0, 1, 2, 3, 4, 5, 6]);
  const taken = new Set<number>();
  const offsets: number[] = new Array(kinds.length);

  const claim = (i: number, slot: number) => {
    offsets[i] = slot;
    taken.add(slot);
  };

  // 1. Explicit pins win outright.
  for (const [rawIndex, rawOffset] of Object.entries(options.pinned ?? {})) {
    const i = Number(rawIndex);
    if (!Number.isInteger(i) || i < 0 || i >= kinds.length) continue;
    if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > 6) continue;
    claim(i, rawOffset);
  }

  /*
   * 2. The weekend pins, and ONLY the first occurrence of each.
   *
   * The long run goes first, then the discipline's anchor — for a runner
   * those are the same session, so a runner's week comes out exactly as it
   * always did. For a triathlete the long run takes Saturday and the long
   * ride takes Sunday, instead of the ride landing in the first free Monday
   * slot because nothing had ever pinned it.
   *
   * FIRST occurrence only: pinning every session of a kind would put two
   * rides on the same day, and two sessions sharing a (date, kind) share a
   * completion key — ticking one would tick both.
   *
   * `allowed` is honoured throughout, because the athlete's statement about
   * which days exist outranks the engine's opinion about which day is
   * nicest for a long session. The weekend is a preference; the training
   * days are a constraint. With no Saturday or Sunday available this walks
   * back to the latest day that is.
   */
  const preference = [5, 6, 4, 3, 2, 1, 0];
  const pinFirst = (kind: SessionKind) => {
    const index = kinds.findIndex((k, i) => k === kind && offsets[i] === undefined);
    if (index < 0) return;
    const slot = preference.find((d) => allowed.has(d) && !taken.has(d));
    if (slot !== undefined) claim(index, slot);
  };
  pinFirst("run_long");
  if (anchorKind !== "run_long") pinFirst(anchorKind);

  // 3. Everything else spreads, hard sessions first-choice on alternating days.
  kinds.forEach((kind, i) => {
    if (offsets[i] !== undefined) return;
    const order = HARD_KINDS.has(kind) ? HARD_FIRST_CHOICE : EASY_FIRST_CHOICE;
    const slot = order.find((d) => allowed.has(d) && !taken.has(d));
    if (slot !== undefined) {
      claim(i, slot);
      return;
    }
    /*
     * Nothing legal is free. The old fallback took the first preference
     * regardless of occupancy, which silently doubled a session onto a day
     * that already had one of the same kind — and two sessions sharing a
     * (date, kind) share a completion key, so ticking one ticked both. Put
     * it on the least-loaded legal day instead, earliest breaking the tie.
     */
    const counts = new Map<number, number>();
    for (const day of allowed) counts.set(day, 0);
    for (const assigned of offsets) {
      if (assigned === undefined || !counts.has(assigned)) continue;
      counts.set(assigned, counts.get(assigned)! + 1);
    }
    const least = [...counts.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0]![0];
    claim(i, least);
  });

  return offsets.map((o) => addDays(weekStart, o));
}

/**
 * Split ONE kind's weekly minutes across its occurrences.
 *
 * The per-kind allocation above is unchanged — this only decides how that
 * total is shared out. A kind with no entry in `OCCURRENCE_SHARES` splits
 * equally, which is bit-for-bit what every kind got before this existed, so
 * a runner's three easy runs stay three equal easy runs. The endurance kinds
 * decay (1 / 0.65 / 0.5, last value repeating), which is the difference
 * between "two rides" and "one long weekend ride and one shorter midweek
 * one" — the thing a week sized per KIND could not say.
 *
 * VOLUME IS REDISTRIBUTED, NEVER REDUCED. The total comes back out equal to
 * what went in, so decaying a kind can't quietly delete training: the only
 * way minutes are lost is if every occurrence is already at its ceiling,
 * which is the bound that existed before and not a new one.
 *
 * The bounds are enforced by iterating to a FIXED POINT rather than by one
 * pass of water-filling. A single directional pass can leave the total
 * wrong: raising a short occurrence to its floor takes minutes from the
 * first, which can then itself need capping, which puts minutes back — and
 * a pass that has already run does not see them. Clamp, measure the
 * residual, hand it to whoever has headroom in share order, repeat.
 */
export function splitOccurrences(kind: SessionKind, total: number, count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [total];

  const { min, max } = KIND_MINUTES[kind];
  const weights = Array.from({ length: count }, (_, i) => occurrenceShare(kind, i + 1));
  const weightSum = weights.reduce((a, b) => a + b, 0);

  // Later occurrences round; the first takes the remainder, so the sum is
  // exact before the bounds are applied rather than off by a minute or two.
  const out = weights.map((w, i) => (i === 0 ? 0 : Math.round((total * w) / weightSum)));
  out[0] = total - out.slice(1).reduce((a, b) => a + b, 0);

  for (let pass = 0; pass <= count + 2; pass++) {
    // Positive residual = minutes taken off a capped occurrence, looking for
    // somewhere to go. Negative = minutes lent to an occurrence below its
    // floor, owed by whoever still has room above theirs.
    let residual = 0;
    for (let i = 0; i < count; i++) {
      if (out[i]! > max) {
        residual += out[i]! - max;
        out[i] = max;
      } else if (out[i]! < min) {
        residual -= min - out[i]!;
        out[i] = min;
      }
    }
    if (residual === 0) return out;

    let moved = 0;
    for (let i = 0; i < count && residual !== 0; i++) {
      // Share order: the long one absorbs a surplus first and pays a
      // shortfall first, so the decay shape survives the correction.
      const headroom = residual > 0 ? max - out[i]! : -(out[i]! - min);
      const step = residual > 0 ? Math.min(residual, headroom) : Math.max(residual, headroom);
      if (step === 0) continue;
      out[i] = out[i]! + step;
      residual -= step;
      moved += Math.abs(step);
    }
    // Nobody has room left: the week is at its ceiling (or its floor) and
    // the remainder is the bound doing its job, not an arithmetic slip.
    if (moved === 0) return out;
  }
  return out;
}

export interface BuildSessionOptions {
  occurrence?: SessionOccurrence;
  /** Overrides the RPE this session is priced at. Defaults to `rpeFor(kind)` — pass it only when the session genuinely is not that kind's usual effort. */
  targetRpe?: number;
  /** Overrides the "For <goal>." line — the modulation layer puts its reason here. */
  note?: string;
  adjustedFrom?: AdjustedFrom;
}

/**
 * The ONE way a PlannedSession is created.
 *
 * Every layer that substitutes, downgrades, shortens or re-lands a session
 * goes through here rather than patching fields on a copy, because the
 * targets and the duration are two statements of the same fact: a session
 * whose `durationMinutes` was edited to 42 while its targets still read
 * "60 min continuous" is a card that contradicts itself, and the athlete has
 * no way to know which number the engine actually meant. Rebuilding is also
 * what keeps a downgraded session priced by the same `estimateSessionTss`
 * the ledger prices a logged one with.
 */
export function buildSession(
  kind: SessionKind,
  date: string,
  durationMinutes: number,
  athlete: AthleteParams,
  servesGoalIds: string[],
  goalLabels: string[],
  opts: BuildSessionOptions = {},
): PlannedSession {
  const sport = SPORT_OF[kind];
  const targetRpe = opts.targetRpe ?? rpeFor(kind);
  return {
    date,
    kind,
    sport,
    title: TITLE_OF[kind],
    focus: FOCUS_OF[kind],
    durationMinutes,
    // Priced with the same function the ledger prices logged sessions with,
    // so the planned week and the recorded week are on one scale.
    tss: estimateSessionTss({ sport: sport as Sport, durationMinutes, rpe: targetRpe }, athlete),
    intensity: INTENSITY_OF[kind],
    targets: targetsFor(kind, athlete, durationMinutes),
    servesGoalIds,
    note:
      opts.note ??
      (goalLabels.length > 1
        ? `Serves ${goalLabels.join(" and ")} at once — one session, both goals.`
        : `For ${goalLabels[0]}.`),
    targetRpe,
    ...(opts.occurrence ? { occurrence: opts.occurrence } : {}),
    ...(opts.adjustedFrom ? { adjustedFrom: opts.adjustedFrom } : {}),
  };
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
  // Reported rather than left to be inferred from loadMultiplier: the blend
  // across goals makes that inference wrong exactly when it matters (see
  // PrescribedWeek.phaseName). With no live goal there is no phase to be in,
  // and "maintain" is what the shape defaults to.
  const phaseName = dominant?.phase.phaseName ?? "maintain";
  // The dominant goal sets the week's discipline as well as its phase: a
  // triathlete's week is shaped around the bike even when a second, lower-
  // priority goal contributes run and strength slots to it.
  const discipline = dominant?.goal ? (dominant.goal.discipline ?? defaultDiscipline(dominant.goal.type)) : "other";

  if (livePhases.length === 0) {
    return {
      weekStart: week.date,
      sessions: [],
      totalMinutes: 0,
      totalTss: 0,
      loadMultiplier: week.loadMultiplier,
      phaseName,
      note: "No active goals — nothing to prescribe.",
    };
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
   * ── Per-occurrence sizing ────────────────────────────────────────────
   *
   * The allocation above is per KIND, which is why a 70.3 week used to come
   * out with two identical 106-minute rides. A real week has one long
   * weekend ride and a shorter midweek one; sizing per kind cannot say that.
   *
   * So the per-kind total is kept EXACTLY as computed, and only its
   * distribution changes: `splitOccurrences` hands the kind's whole
   * allocation (count x per-kind minutes) back out across its occurrences.
   * Kinds with no share table split equally, which is what every kind got
   * before — a runner's week is unchanged to the minute.
   *
   * Which occurrence a slot is comes from ALLOCATION order, not date order:
   * the first occurrence is the one the priority ordering asked for first,
   * and it is the one the weekend pin and the dominance rules act on. It is
   * therefore the anchor by construction rather than by inference from
   * minutes.
   */
  const kindTotals = new Map<SessionKind, number>();
  for (const p of picked) kindTotals.set(p.kind, (kindTotals.get(p.kind) ?? 0) + 1);
  const kindSeen = new Map<SessionKind, number>();
  const occurrences: SessionOccurrence[] = picked.map((p) => {
    const n = (kindSeen.get(p.kind) ?? 0) + 1;
    kindSeen.set(p.kind, n);
    return { n, of: kindTotals.get(p.kind)! };
  });

  const splits = new Map<SessionKind, number[]>();
  for (const [kind, count] of kindTotals) {
    if (STRENGTH_KINDS.has(kind)) continue;
    const perKind = minutes.get(kind) ?? KIND_MINUTES[kind].min;
    splits.set(kind, splitOccurrences(kind, perKind * count, count));
  }

  // A lift is ~50 minutes however the aerobic week falls, as before.
  const minutesAt: number[] = picked.map((p, i) =>
    STRENGTH_KINDS.has(p.kind) ? STRENGTH_MINUTES : (splits.get(p.kind)?.[occurrences[i]!.n - 1] ?? KIND_MINUTES[p.kind].min),
  );

  /*
   * Two dominance rules, because "biggest run" and "biggest session" are the
   * same thing for a runner and different things for a triathlete.
   *
   * Collapsing them — which is what a single hardcoded long-run anchor did —
   * means that fixing the bike's share of a triathlon week gets immediately
   * undone: the long run is pushed back above the ride it was just meant to
   * sit beneath.
   *
   * Both now act on the FIRST OCCURRENCE rather than on the kind: raising
   * "the ride" when a week has two of them would raise the short midweek one
   * along with the long one, which is the opposite of what the rule means.
   */
  const firstIndexOf = (kind: SessionKind) => picked.findIndex((p) => p.kind === kind);
  const biggestExcept = (except: SessionKind, within?: (k: SessionKind) => boolean) =>
    Math.max(
      0,
      ...picked.map((p, i) => (p.kind !== except && !STRENGTH_KINDS.has(p.kind) && (within?.(p.kind) ?? true) ? minutesAt[i]! : 0)),
    );

  // 1. The long run outlasts every other RUN — never shorter than an easy run.
  const longIndex = firstIndexOf("run_long");
  if (longIndex >= 0) {
    const biggestOtherRun = biggestExcept("run_long", (k) => SPORT_OF[k] === "run");
    if (minutesAt[longIndex]! <= biggestOtherRun) {
      minutesAt[longIndex] = clampKind("run_long", Math.round(biggestOtherRun * 1.25));
    }
  }

  // 2. The discipline's anchor outlasts everything. For a runner this is the
  //    long run again, so rule 1's result stands and nothing changes.
  const anchorKind = ANCHOR_KIND[discipline] ?? "run_long";
  const anchorIndex = STRENGTH_KINDS.has(anchorKind) ? -1 : firstIndexOf(anchorKind);
  if (anchorIndex >= 0) {
    const biggestOther = biggestExcept(anchorKind);
    if (minutesAt[anchorIndex]! <= biggestOther) {
      minutesAt[anchorIndex] = clampKind(anchorKind, Math.round(biggestOther * 1.25));
    }
  }

  const dates = assignDates(week.date, picked.map((p) => p.kind), { anchorKind });

  const sessions: PlannedSession[] = picked.map((p, i) => {
    const occurrence = occurrences[i]!;
    const session = buildSession(p.kind, dates[i]!, minutesAt[i]!, athlete, p.goalIds, p.goalLabels, { occurrence });
    const sentence = occurrenceNote(p.kind, occurrence, splits.get(p.kind) ?? [], dates[firstIndexOf(p.kind)] ?? session.date);
    return sentence ? { ...session, note: `${session.note} ${sentence}` } : session;
  });

  sessions.sort((a, b) => a.date.localeCompare(b.date));

  return {
    weekStart: week.date,
    sessions,
    totalMinutes: sessions.reduce((s, x) => s + x.durationMinutes, 0),
    totalTss: sessions.reduce((s, x) => s + x.tss, 0),
    loadMultiplier: week.loadMultiplier,
    phaseName,
    note: shape.focus,
  };
}
