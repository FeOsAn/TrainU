/**
 * The morning check-in, turned into one number the week can act on.
 *
 * Three taps — how you slept, how sore you are, how much energy you have —
 * plus an optional resting heart rate and a note. That is the whole input.
 * It is deliberately small: a check-in the athlete resents filling in stops
 * being filled in, and a readiness score nobody records is worth nothing.
 *
 * Three rules shape everything below, and each exists because the obvious
 * version of this feature gets it wrong:
 *
 * 1. THE SCORE IS `Measured<number>`, and today it is honestly NOT verified.
 *    "I feel wrecked" is a real, actionable signal, but it is self-reported,
 *    and the app says so rather than dressing it up next to a lab number —
 *    the same rule every physiological input in this app follows. The
 *    `WearableRecovery` slot below is where a Whoop/Garmin recovery value
 *    will make it `verified: true`. The slot is DECLARED and unwired: no
 *    connector fills it yet, and nothing here pretends otherwise.
 *
 * 2. A GUESSED BASELINE NEVER MOVES THE NUMBER. The resting-HR penalty is
 *    inert until the athlete's OWN median exists (>= 5 mornings). A
 *    population-average resting HR would quietly penalise anyone whose true
 *    resting rate is 62 for being exactly themselves — the seeded-CdA
 *    pattern this codebase was rebuilt to stop.
 *
 * 3. THE BANDS ARE RELATIVE TO THE ATHLETE, NOT ABSOLUTE. Fixed thresholds
 *    mean a habitually pessimistic athlete — one who reports 2/3/3 on a
 *    perfectly good Tuesday — has every hard session downgraded forever,
 *    and an habitual optimist never triggers anything at all. So once five
 *    mornings exist, the self-reported part is shifted so that the
 *    athlete's own trailing-28-day median reads as the middle of "ready".
 *    What the bands then measure is a change from THEIR normal, which is
 *    the only thing three taps can honestly measure.
 *
 * Below five mornings the score and band are still computed and shown — a
 * flag is useful on day one — but `acting` is false, and the modulation
 * layer's slice must not restructure a week on a band it cannot yet trust.
 * That is a field rather than a comment on purpose: a slice cannot forget to
 * read it the way it could forget to read a docstring.
 *
 * Pure and DB-free, like shared/conditions.ts and server/goalValidation.ts:
 * the score has to be reachable from a test, a future chat tool and the
 * server without dragging a database in, and a malformed check-in has to be
 * rejected here exactly as a bad form submission is.
 */

import { addDays, isValidISODate } from "./dates";
import { measured, seeded, type Measured } from "./measured";

/* ─── The check-in ───────────────────────────────────────────────────────── */

/** The 1-5 scale both ends of every tap. Exported so the client renders exactly five chips, not four or six. */
export const CHECK_IN_MIN = 1;
export const CHECK_IN_MAX = 5;

/** Longest note we store. Long enough for "woke at 3am with the baby", short enough that it is a note and not a journal. */
export const NOTE_MAX_LENGTH = 500;

/** Plausible human resting heart rate. Outside this it is a typo or a reading taken mid-walk, and a typo must not move the score. */
export const RESTING_HR_BOUNDS: readonly [number, number] = [30, 120];

export interface CheckIn {
  /** YYYY-MM-DD. One row per date — checking in twice corrects the morning, it does not add a second one. */
  date: string;
  /** 1 (rough) … 5 (great). */
  sleepQuality: number;
  /** 1 (none) … 5 (wrecked). Inverted in the formula — more soreness is fewer points. */
  soreness: number;
  /** 1 (flat) … 5 (fired up). */
  energy: number;
  /** Optional. Only ever penalises once the athlete's OWN baseline exists. */
  restingHrBpm?: number | null;
  note?: string | null;
  /**
   * "I know what it says — train as prescribed anyway."
   *
   * An explicit, per-date opt-out the athlete sets themselves, and the one
   * thing that makes an honest check-in safe to give the app. Without it,
   * an athlete who feels rough but intends to train anyway has exactly one
   * way to keep their session: go back and falsify the health record. That
   * makes lying to the app the only route to training as prescribed, and
   * poisons the only dataset this feature produces.
   *
   * The override is itself evidence, and a true one: "felt bad, trained
   * anyway" is a fact worth keeping, and it is kept.
   */
  trainAnywayOverride?: boolean;
}

/* ─── Bands ──────────────────────────────────────────────────────────────── */

export const READINESS_BAND_VALUES = ["very_low", "low", "ready", "high"] as const;
export type ReadinessBand = (typeof READINESS_BAND_VALUES)[number];

/**
 * The athlete never sees a band id. Typed `Record<ReadinessBand, string>` so
 * adding a fifth band fails `tsc` until someone has written words for it.
 */
export const READINESS_BAND_LABELS: Record<ReadinessBand, string> = {
  very_low: "Wiped out",
  low: "Under par",
  ready: "Ready to go",
  high: "Firing",
};

/** What the band means for today, in a sentence. Same table discipline, same reason. */
export const READINESS_BAND_MEANINGS: Record<ReadinessBand, string> = {
  very_low: "A long way below your own normal — today is a rest day unless you say otherwise.",
  low: "Below your own normal — the hard work is better done later in the week.",
  ready: "About where you usually are — today's session stands as written.",
  high: "Above your own normal — a good morning to do the session properly.",
};

/** Score thresholds. `ready` is everything between `lowBelow` and `highFrom`. */
export const READINESS_BANDS = { veryLowBelow: 30, lowBelow: 45, highFrom: 80 } as const;

/**
 * The middle of the `ready` band — derived from the thresholds rather than
 * written twice, so moving a band edge cannot leave the normalisation centre
 * pointing at the old middle.
 */
export const READY_CENTRE = Math.round((READINESS_BANDS.lowBelow + (READINESS_BANDS.highFrom - 1)) / 2);

export function bandFor(score: number): ReadinessBand {
  if (score < READINESS_BANDS.veryLowBelow) return "very_low";
  if (score < READINESS_BANDS.lowBelow) return "low";
  if (score >= READINESS_BANDS.highFrom) return "high";
  return "ready";
}

/* ─── Baselines ──────────────────────────────────────────────────────────── */

/** First match wins, so read most-severe-first. A resting HR well above your own normal is the classic pre-illness signal. */
export const RESTING_HR_PENALTIES = [
  { deltaBpm: 10, penalty: 20 },
  { deltaBpm: 5, penalty: 10 },
] as const;

/**
 * The resting-HR baseline: the median of the athlete's own recent mornings.
 *
 * Median rather than mean because one 78 bpm reading taken after running up
 * the stairs should not drag a baseline. Bounded by rows AND by age: a
 * resting HR from four months and 6 kg ago is not this athlete's baseline
 * any more — the same staleness discipline `calibrateBenchmark` applies to
 * a time trial, one level down.
 */
export const RESTING_HR_BASELINE = { minSamples: 5, maxRows: 14, maxAgeDays: 60 } as const;

/**
 * The self-report baseline, which is what makes the bands the athlete's own.
 * 28 days because that is the window the rest of the app already reasons in
 * (chronic training load), and because a shorter one would drift with a
 * single rough week.
 */
export const SELF_BASELINE = { minSamples: 5, windowDays: 28 } as const;

export interface RestingHrBaseline {
  bpm: number;
  samples: number;
}

export interface SelfScoreBaseline {
  /** Median of the athlete's own previous self-reported scores, 0-100. */
  median: number;
  samples: number;
}

export interface ReadinessBaseline {
  /** Null until `SELF_BASELINE.minSamples` mornings exist. While null, nothing acts. */
  selfScore: SelfScoreBaseline | null;
  /** Null until `RESTING_HR_BASELINE.minSamples` readings exist. While null, the HR penalty is exactly zero. */
  restingHr: RestingHrBaseline | null;
}

/* ─── The wearable slot ──────────────────────────────────────────────────── */

/**
 * SLOT ONLY — declared, and deliberately unwired.
 *
 * When a connector fills this, the score becomes `verified: true` and the
 * blend below gives it half the weight. Declaring the shape now is what
 * stops the wearable arriving later as a second, parallel readiness number
 * living beside this one. Nothing in the app populates it today, and this
 * file does not reach for one — Phase 5's connectors sync sessions, not
 * recovery.
 */
export interface WearableRecovery {
  /** 0-100, however the device scales it. */
  score: number;
  /** Plain language, e.g. "Whoop recovery". Goes straight into `Measured.source`. */
  source: string;
  asOf: string;
}

/** Half and half when both exist: neither a device nor the athlete gets the last word on how the athlete feels. */
export const WEARABLE_WEIGHT = 0.5;

/* ─── Readiness ──────────────────────────────────────────────────────────── */

/**
 * Every part of the score, in points, and they add up exactly:
 *
 *   sleep + soreness + energy + normalisation + (wearable ?? 0)
 *     − restingHrPenalty + clamp  ===  score.value
 *
 * That identity is a test, not a comment. A score that cannot be taken apart
 * into the reasons for it is a number the athlete has to take on faith, and
 * the first time it disagrees with how they actually feel they stop
 * believing all of it.
 */
export interface ReadinessComponents {
  /** 0-33 each, from the three taps. */
  sleep: number;
  soreness: number;
  energy: number;
  /** Shift applied so the athlete's own median reads as the middle of `ready`. 0 while no baseline exists. Can be negative. */
  normalisation: number;
  /** Positive number of points SUBTRACTED. 0 unless a resting-HR baseline exists and today's reading is above it. */
  restingHrPenalty: number;
  /** Points contributed by a device recovery score, or null when there is none. */
  wearable: number | null;
  /** Correction from holding the total inside 0-100. Almost always 0; shown when it is not, rather than hidden. */
  clamp: number;
}

export interface Readiness {
  /** The date this describes. A slice must refuse a readiness whose date is not today — yesterday's morning is not today's. */
  date: string;
  /** 0-100. `verified: false` while it is three taps; `verified: true` once a wearable recovery backs it. */
  score: Measured<number>;
  band: ReadinessBand;
  components: ReadinessComponents;
  baseline: ReadinessBaseline;
  /**
   * THE GATE. True only when the band has earned the right to restructure a
   * week: the athlete's own normal range exists AND they have not overridden
   * today. The modulation layer's slice checks this ONE field — so both
   * reasons to stand down are impossible to honour by halves.
   */
  acting: boolean;
  /** Why `acting` is what it is, in the athlete's words. Shown under the score. */
  actingReason: string;
  /** Verbatim from the check-in, so the UI can show the override is on and offer to take it off. */
  trainAnywayOverride: boolean;
  /** One plain line per component, in the order they were applied. */
  explanation: string[];
  /** The one-line version, for a chip. */
  note: string;
}

export interface ReadinessOptions {
  /** The declared-but-unwired slot. Nothing passes this today. */
  wearable?: WearableRecovery | null;
}

/* ─── The formula ────────────────────────────────────────────────────────── */

/**
 * Each tap is worth 0-33 points: `(value - 1) / 12 * 100`, with soreness
 * inverted (`(5 - soreness)`), so three neutral 3s make 50 and three perfect
 * answers make 100.
 *
 * Worked examples, pinned by tests:
 *   sleep 2, soreness 4, energy 2  →  25  (a genuinely bad morning)
 *   3 / 3 / 3                      →  50  (the middle of everything)
 *   2 / 3 / 3                      →  42  (the pessimist's ordinary Tuesday)
 */
export function selfScoreOf(checkIn: CheckIn): number {
  return Math.round(tapPoints(checkIn).reduce((a, b) => a + b, 0));
}

/** Unrounded points for [sleep, soreness, energy]. */
function tapPoints(checkIn: CheckIn): [number, number, number] {
  const span = (CHECK_IN_MAX - CHECK_IN_MIN) * 3; // 12
  return [
    ((checkIn.sleepQuality - CHECK_IN_MIN) / span) * 100,
    ((CHECK_IN_MAX - checkIn.soreness) / span) * 100,
    ((checkIn.energy - CHECK_IN_MIN) / span) * 100,
  ];
}

/**
 * Round the three taps so they still add up to the self score.
 *
 * Rounding each independently loses a point (8 + 8 + 8 = 24, not 25) and the
 * athlete is then shown three numbers that do not make the fourth. Rounding
 * the running total and taking differences keeps the sum exact.
 */
function roundedTapPoints(checkIn: CheckIn): [number, number, number] {
  const raw = tapPoints(checkIn);
  let carried = 0;
  let previous = 0;
  const out = raw.map((points) => {
    carried += points;
    const cumulative = Math.round(carried);
    const share = cumulative - previous;
    previous = cumulative;
    return share;
  });
  return [out[0]!, out[1]!, out[2]!];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The athlete's own resting-HR baseline on `date`.
 *
 * Excludes `date` itself — today's reading is what is being judged, and a
 * sample cannot be its own baseline.
 */
export function restingHrBaselineOn(history: readonly CheckIn[], date: string): RestingHrBaseline | null {
  const earliest = addDays(date, -RESTING_HR_BASELINE.maxAgeDays);
  const readings = history
    .filter((c) => c.date < date && c.date >= earliest && typeof c.restingHrBpm === "number")
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, RESTING_HR_BASELINE.maxRows)
    .map((c) => c.restingHrBpm as number);
  if (readings.length < RESTING_HR_BASELINE.minSamples) return null;
  return { bpm: Math.round(median(readings)), samples: readings.length };
}

/**
 * The athlete's own self-report baseline on `date` — what an ordinary
 * morning reads like FOR THEM. Excludes `date` itself, same reason.
 */
export function selfScoreBaselineOn(history: readonly CheckIn[], date: string): SelfScoreBaseline | null {
  const earliest = addDays(date, -SELF_BASELINE.windowDays);
  const scores = history.filter((c) => c.date < date && c.date >= earliest).map(selfScoreOf);
  if (scores.length < SELF_BASELINE.minSamples) return null;
  return { median: Math.round(median(scores)), samples: scores.length };
}

/** Points to subtract for a resting HR above the athlete's own baseline. Zero without a baseline — never a guess. */
function restingHrPenalty(checkIn: CheckIn, baseline: RestingHrBaseline | null): number {
  if (!baseline || typeof checkIn.restingHrBpm !== "number") return 0;
  const delta = checkIn.restingHrBpm - baseline.bpm;
  for (const rule of RESTING_HR_PENALTIES) if (delta >= rule.deltaBpm) return rule.penalty;
  return 0;
}

function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n));
}

/**
 * Turn one morning into a readiness.
 *
 * `history` is every other check-in the athlete has ever recorded (order
 * irrelevant; rows dated on or after `checkIn.date` are ignored, so passing
 * the whole table including today's own row is safe). Both baselines are
 * derived from it here rather than passed in, so there is one definition of
 * "the athlete's own normal" and not one per caller.
 */
export function computeReadiness(
  checkIn: CheckIn,
  history: readonly CheckIn[] = [],
  options: ReadinessOptions = {},
): Readiness {
  const [sleep, soreness, energy] = roundedTapPoints(checkIn);
  const self = sleep + soreness + energy;

  const selfBaseline = selfScoreBaselineOn(history, checkIn.date);
  const hrBaseline = restingHrBaselineOn(history, checkIn.date);

  // Shift, not scale: "17 points below your own normal" stays the same
  // distance whatever the athlete's normal is, which is exactly the quantity
  // three taps can measure. Zero until the baseline exists, so an athlete's
  // first week is judged on the raw score and acted on not at all.
  const normalisation = selfBaseline ? READY_CENTRE - selfBaseline.median : 0;
  const normalised = self + normalisation;

  const wearable = options.wearable ?? null;
  // Half the device, half the athlete. Recorded as the DIFFERENCE it made, so
  // the components still add up to the score.
  const blended = wearable ? Math.round(WEARABLE_WEIGHT * wearable.score + (1 - WEARABLE_WEIGHT) * normalised) : normalised;
  const wearablePoints = wearable ? blended - normalised : null;

  const penalty = restingHrPenalty(checkIn, hrBaseline);
  const preClamp = blended - penalty;
  const value = clamp(preClamp, 0, 100);
  const clampPoints = value - preClamp;

  const components: ReadinessComponents = {
    sleep,
    soreness,
    energy,
    normalisation,
    restingHrPenalty: penalty,
    wearable: wearablePoints,
    clamp: clampPoints,
  };

  const band = bandFor(value);
  const trainAnywayOverride = checkIn.trainAnywayOverride === true;
  const acting = Boolean(selfBaseline) && !trainAnywayOverride;

  return {
    date: checkIn.date,
    score: wearable
      ? measured(value, `${wearable.source} and your check-in, ${checkIn.date}`, checkIn.date)
      : { ...seeded(value, `self-reported check-in, ${checkIn.date}`), asOf: checkIn.date },
    band,
    components,
    baseline: { selfScore: selfBaseline, restingHr: hrBaseline },
    acting,
    actingReason: actingReasonFor(selfBaseline, trainAnywayOverride),
    trainAnywayOverride,
    explanation: explain(checkIn, components, selfBaseline, hrBaseline, wearable),
    note: `${value} out of 100 — ${READINESS_BAND_LABELS[band].toLowerCase()}.`,
  };
}

function actingReasonFor(selfBaseline: SelfScoreBaseline | null, trainAnyway: boolean): string {
  if (trainAnyway) {
    return "You said to train as prescribed today, so this morning's score is on record and nothing in your week has been changed.";
  }
  if (!selfBaseline) {
    const needed = SELF_BASELINE.minSamples;
    return (
      `Your first ${needed} mornings set what an ordinary one looks like for you. ` +
      `Until then this score is shown but nothing in your week is changed by it.`
    );
  }
  return (
    `Judged against your own recent mornings — the middle of your last ${selfBaseline.samples} ` +
    `is ${selfBaseline.median} out of 100.`
  );
}

/* ─── Explanation ────────────────────────────────────────────────────────── */

/** Chip captions, so the client and this file describe a 4 the same way. */
export const CHECK_IN_CAPTIONS: Record<"sleepQuality" | "soreness" | "energy", { label: string; scale: readonly string[] }> = {
  sleepQuality: { label: "Sleep", scale: ["broken", "poor", "okay", "solid", "excellent"] },
  soreness: { label: "Soreness", scale: ["none", "a little", "noticeable", "sore", "wrecked"] },
  energy: { label: "Energy", scale: ["flat", "low", "okay", "good", "fired up"] },
};

function caption(field: keyof typeof CHECK_IN_CAPTIONS, value: number): string {
  return CHECK_IN_CAPTIONS[field].scale[clamp(value, CHECK_IN_MIN, CHECK_IN_MAX) - 1]!;
}

function explain(
  checkIn: CheckIn,
  components: ReadinessComponents,
  selfBaseline: SelfScoreBaseline | null,
  hrBaseline: RestingHrBaseline | null,
  wearable: WearableRecovery | null,
): string[] {
  const lines = [
    `Sleep ${checkIn.sleepQuality} of 5, ${caption("sleepQuality", checkIn.sleepQuality)}: ${components.sleep} points.`,
    `Soreness ${checkIn.soreness} of 5, ${caption("soreness", checkIn.soreness)}: ${components.soreness} points.`,
    `Energy ${checkIn.energy} of 5, ${caption("energy", checkIn.energy)}: ${components.energy} points.`,
  ];

  if (selfBaseline) {
    const shift = components.normalisation;
    if (shift === 0) {
      lines.push(`That is exactly your own usual morning over the last ${SELF_BASELINE.windowDays} days, so nothing was added or taken off.`);
    } else {
      lines.push(
        `Measured against your own usual morning (${selfBaseline.median} out of 100 across ${selfBaseline.samples} check-ins): ` +
          `${shift > 0 ? `${shift} points added` : `${Math.abs(shift)} points taken off`}.`,
      );
    }
  }

  if (wearable) {
    const points = components.wearable ?? 0;
    lines.push(
      `${wearable.source} put you at ${wearable.score} out of 100, counted for half: ` +
        `${points === 0 ? "no change" : points > 0 ? `${points} points added` : `${Math.abs(points)} points taken off`}.`,
    );
  }

  if (typeof checkIn.restingHrBpm === "number") {
    if (!hrBaseline) {
      const needed = RESTING_HR_BASELINE.minSamples;
      lines.push(
        `Resting heart rate ${checkIn.restingHrBpm} recorded. It takes ${needed} mornings to know what yours normally is, ` +
          `so it has not moved this score.`,
      );
    } else if (components.restingHrPenalty > 0) {
      const delta = checkIn.restingHrBpm - hrBaseline.bpm;
      lines.push(
        `Resting heart rate ${checkIn.restingHrBpm} against your own ${hrBaseline.bpm} — ${delta} higher than usual: ` +
          `${components.restingHrPenalty} points off.`,
      );
    } else {
      lines.push(`Resting heart rate ${checkIn.restingHrBpm}, in line with your own ${hrBaseline.bpm}: no change.`);
    }
  }

  if (components.clamp !== 0) {
    lines.push(
      components.clamp < 0
        ? "Held at 100 — the pieces added up past the top of the scale."
        : "Held at 0 — the pieces added up below the bottom of the scale.",
    );
  }

  return lines;
}

/* ─── Validation ─────────────────────────────────────────────────────────── */

/** Anything a form or a chat tool might hand us. Validated before it becomes a `CheckIn`. */
export interface CheckInInput {
  date?: unknown;
  sleepQuality?: unknown;
  soreness?: unknown;
  energy?: unknown;
  restingHrBpm?: unknown;
  note?: unknown;
  trainAnywayOverride?: unknown;
}

function isTap(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= CHECK_IN_MIN && n <= CHECK_IN_MAX;
}

/**
 * Returns a plain-language problem, or null when the input is a check-in.
 *
 * Server-side and DB-free for the same reason `goalValidation.ts` is: a
 * hallucinated tool call has to be rejected exactly as a bad form submission
 * is, and neither path may be the only one that checks.
 */
export function validateCheckIn(input: CheckInInput): string | null {
  if (!isValidISODate(input.date)) return "A check-in needs a real date, as YYYY-MM-DD.";
  for (const field of ["sleepQuality", "soreness", "energy"] as const) {
    if (!isTap(input[field])) {
      return `${CHECK_IN_CAPTIONS[field].label} has to be a whole number from ${CHECK_IN_MIN} to ${CHECK_IN_MAX}.`;
    }
  }
  const hr = input.restingHrBpm;
  if (hr !== undefined && hr !== null) {
    const [low, high] = RESTING_HR_BOUNDS;
    if (typeof hr !== "number" || !Number.isInteger(hr) || hr < low || hr > high) {
      return `A resting heart rate should be a whole number between ${low} and ${high} beats per minute.`;
    }
  }
  const note = input.note;
  if (note !== undefined && note !== null) {
    if (typeof note !== "string") return "A note has to be text.";
    if (note.length > NOTE_MAX_LENGTH) return `Keep the note under ${NOTE_MAX_LENGTH} characters.`;
  }
  const override = input.trainAnywayOverride;
  if (override !== undefined && typeof override !== "boolean") {
    return "Training anyway is a yes or a no.";
  }
  return null;
}
