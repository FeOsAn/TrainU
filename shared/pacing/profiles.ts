/**
 * Pacing profiles as deterministic data — one MECHANISM, per-discipline DATA.
 *
 * The tempting shortcut is a single universal shape: "first 10% two percent
 * slower, middle even, last 10% two percent faster". That is a defensible
 * marathon and it is actively WRONG on a 70.3 bike leg, where finishing the
 * leg faster than you rode it is precisely how you ruin the run that follows.
 * A pacing rule is not physics; it is coaching IP, and coaching IP differs by
 * sport. So the shape lives in a table keyed by discipline and leg, in the
 * same style as `PHASE_SHAPES` and `DISCIPLINE_KIND_WEIGHT` one layer down,
 * with every entry carrying the reason it has the shape it has.
 *
 * The invariant that makes this a single mechanism rather than a second
 * sizing mechanism: within a leg, the fractions sum to 1 AND the
 * fraction-weighted factors sum to 1. So the profile only ever *redistributes*
 * a leg's time or effort — it can never change how big the leg is. The leg's
 * size comes from the predictor, and nowhere else. (Two mechanisms sizing the
 * same thing is how Phase 7 produced a 225-minute "easy run".)
 *
 * `metric` is what stops the factor being a number with no meaning attached —
 * the same lesson `Measured<T>` and `FRESH_KM_TO_THRESHOLD` encode. On a run
 * or a swim the factor multiplies PACE, so below 1 is faster. On a bike leg it
 * multiplies POWER, so below 1 is easier. Reading one as the other inverts
 * every bike zone.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export type PacingDiscipline = "run" | "triathlon" | "hyrox";

export const PACING_DISCIPLINES: PacingDiscipline[] = ["run", "triathlon", "hyrox"];

export const PACING_DISCIPLINE_LABELS: Record<PacingDiscipline, string> = {
  run: "running race",
  triathlon: "triathlon",
  hyrox: "HYROX",
};

export type PacingLeg = "swim" | "bike" | "run";

export const PACING_LEG_LABELS: Record<PacingLeg, string> = {
  swim: "Swim",
  bike: "Bike",
  run: "Run",
};

/** What a zone's `factor` multiplies. Never assume — see this file's header. */
export type EffortMetric = "pace" | "power";

export const EFFORT_METRIC_LABELS: Record<EffortMetric, string> = {
  pace: "pace",
  power: "power",
};

export type ProfileName = "negative_split" | "even" | "eased_finish";

export const PROFILE_NAME_LABELS: Record<ProfileName, string> = {
  negative_split: "negative split — finish faster than you started",
  even: "even — the same effort the whole way",
  eased_finish: "eased finish — back off at the end to protect what comes next",
};

export type SplitZone = "opening" | "middle" | "closing";

export const SPLIT_ZONE_LABELS: Record<SplitZone, string> = {
  opening: "opening",
  middle: "middle",
  closing: "closing",
};

export interface ProfileZone {
  /** Share of the leg's distance this zone covers. The three fractions sum to 1. */
  fraction: number;
  /** Multiplier on the leg's mean value of `metric`. The fraction-weighted factors sum to 1. */
  factor: number;
}

export interface LegProfile {
  name: ProfileName;
  metric: EffortMetric;
  opening: ProfileZone;
  middle: ProfileZone;
  closing: ProfileZone;
  /** Why this leg has this shape, in the athlete's words. Shown, not just commented. */
  rationale: string;
}

// ─── The table ───────────────────────────────────────────────────────────────

/** Which legs each discipline claims to pace. The integrity test reads this. */
export const PACING_LEGS: Record<PacingDiscipline, PacingLeg[]> = {
  run: ["run"],
  triathlon: ["swim", "bike", "run"],
  hyrox: ["run"],
};

export const PACING_PROFILE: Record<PacingDiscipline, Partial<Record<PacingLeg, LegProfile>>> = {
  run: {
    // A standalone race is the one case where the whole day is the leg, so
    // every second saved by starting two percent slow is available to spend
    // at the end. 0.10×1.02 + 0.80×1.00 + 0.10×0.98 = 1 exactly, so the middle
    // pace IS the mean pace and there is nothing to "add up" separately.
    run: {
      name: "negative_split",
      metric: "pace",
      opening: { fraction: 0.1, factor: 1.02 },
      middle: { fraction: 0.8, factor: 1.0 },
      closing: { fraction: 0.1, factor: 0.98 },
      rationale:
        "Start two percent slower than the number you want, hold it flat through the middle, and spend what is left in the last tenth. Almost every blown race is a first tenth run at what felt easy on fresh legs.",
    },
  },
  triathlon: {
    // The swim is not where a triathlon is won, and the first two hundred
    // metres taken anaerobically is a debt the bike pays with interest. So:
    // controlled opening, steady middle, and a closing fifth AT the mean —
    // not faster. Sprinting the last buoy buys seconds and costs the T1.
    swim: {
      name: "even",
      metric: "pace",
      opening: { fraction: 0.2, factor: 1.03 },
      middle: { fraction: 0.6, factor: 0.99 },
      closing: { fraction: 0.2, factor: 1.0 },
      rationale:
        "Swim the first fifth deliberately under control — going anaerobic in the first two hundred metres is a debt the bike pays back. The last fifth is not a sprint finish; you have the whole day left.",
    },
    // THE ENTRY DECISIONS C3 EXISTS FOR. A bike leg ridden to a negative
    // split is a run leg walked. The shape is the opposite: easiest at the
    // start (you are still clearing the swim), steady through the middle,
    // and eased in the last fifth so the legs arrive at T2 with something in
    // them. Because the mean is fixed, an easy opening and an eased finish
    // arithmetically REQUIRE a middle above the mean — that is not a surge,
    // it is where the leg's work actually happens.
    bike: {
      name: "eased_finish",
      metric: "power",
      opening: { fraction: 0.2, factor: 0.92 },
      middle: { fraction: 0.6, factor: 1.05 },
      closing: { fraction: 0.2, factor: 0.93 },
      rationale:
        "Ride the first fifth easier than your target — you are still clearing the swim. Do the work in the middle. Then ease the last fifth: arriving at the second transition a minute earlier with wrecked legs costs far more than a minute on the run.",
    },
    // Off the bike the legs lie to you for about ten minutes: the pace feels
    // free and is not. A bigger opening zone and a bigger discount than the
    // standalone race, and the press held for the last fifteen percent.
    run: {
      name: "negative_split",
      metric: "pace",
      opening: { fraction: 0.15, factor: 1.04 },
      middle: { fraction: 0.7, factor: 1.0 },
      closing: { fraction: 0.15, factor: 0.96 },
      rationale:
        "For the first fifteen percent off the bike your legs will offer you a pace you cannot hold — take four percent slower than target instead. If you are still whole in the last fifteen percent, that is when it gets spent.",
    },
  },
  hyrox: {
    // Deliberately flat. Each run split already carries the penalty of the
    // station in front of it and a global drift term, both from the
    // predictor — laying a profile on top would count the same fade twice
    // and hand the athlete a plan that gets faster exactly where the race
    // gets harder.
    run: {
      name: "even",
      metric: "pace",
      opening: { fraction: 0.1, factor: 1.0 },
      middle: { fraction: 0.8, factor: 1.0 },
      closing: { fraction: 0.1, factor: 1.0 },
      rationale:
        "Every run split below already has the station before it priced in, and the fade across the eight runs with it. There is no extra shape to add on top — hold the number you are given for that run and let the stations do the rest.",
    },
  },
};

export const EVEN_PROFILE: LegProfile = {
  name: "even",
  metric: "pace",
  opening: { fraction: 0.1, factor: 1.0 },
  middle: { fraction: 0.8, factor: 1.0 },
  closing: { fraction: 0.1, factor: 1.0 },
  rationale: "Flat, the whole way. When the time you are chasing is already ahead of what the numbers say, the last thing to add is a slow start.",
};

export function profileFor(discipline: PacingDiscipline, leg: PacingLeg): LegProfile {
  // The catalog-integrity test asserts every leg a discipline claims has an
  // entry, so this fallback is a belt, not a strategy.
  return PACING_PROFILE[discipline][leg] ?? EVEN_PROFILE;
}

// ─── Reading the table ───────────────────────────────────────────────────────

export interface ZoneSlice extends ProfileZone {
  zone: SplitZone;
  /** Distance fraction where this zone begins / ends. */
  from: number;
  to: number;
}

export function zoneSlices(profile: LegProfile): ZoneSlice[] {
  const o = profile.opening;
  const m = profile.middle;
  const c = profile.closing;
  return [
    { zone: "opening", ...o, from: 0, to: o.fraction },
    { zone: "middle", ...m, from: o.fraction, to: o.fraction + m.fraction },
    { zone: "closing", ...c, from: o.fraction + m.fraction, to: 1 },
  ];
}

/** Σ fraction — must be 1, or the profile does not cover the leg. */
export function fractionSum(profile: LegProfile): number {
  return profile.opening.fraction + profile.middle.fraction + profile.closing.fraction;
}

/** Σ fraction × factor — must be 1, or the profile is secretly resizing the leg. */
export function weightedFactor(profile: LegProfile): number {
  return zoneSlices(profile).reduce((sum, z) => sum + z.fraction * z.factor, 0);
}

/**
 * ∫ factor over [fromFraction, toFraction] of the leg, in the same units as
 * the leg total. A 5 km split that straddles a zone boundary (4.22 km on a
 * marathon) gets each part priced at its own factor rather than at whichever
 * zone its midpoint happened to land in.
 */
export function integrateFactor(profile: LegProfile, fromFraction: number, toFraction: number): number {
  let acc = 0;
  for (const z of zoneSlices(profile)) {
    const lo = Math.max(fromFraction, z.from);
    const hi = Math.min(toFraction, z.to);
    if (hi > lo) acc += (hi - lo) * z.factor;
  }
  return acc;
}

export function zoneAt(profile: LegProfile, fraction: number): SplitZone {
  for (const z of zoneSlices(profile)) {
    if (fraction < z.to) return z.zone;
  }
  return "closing";
}

/**
 * True when the leg is prescribed to finish HARDER than its mean. Note the
 * inversion: on a pace metric that means a factor below 1, on a power metric
 * a factor above 1. The 70.3 bike leg must answer false.
 */
export function isNegativeSplit(profile: LegProfile): boolean {
  const f = profile.closing.factor;
  return profile.metric === "pace" ? f < 1 : f > 1;
}

/** One line of athlete-facing words for a zone — no factors, no ids. */
export function zoneNote(profile: LegProfile, zone: SplitZone): string {
  const slice = zoneSlices(profile).find((z) => z.zone === zone)!;
  const pct = Math.round(Math.abs(slice.factor - 1) * 1000) / 10;
  if (pct < 0.05) return "Hold the number — this stretch is exactly your average.";
  const harder = profile.metric === "pace" ? slice.factor < 1 : slice.factor > 1;
  const word = profile.metric === "pace" ? (harder ? "quicker" : "slower") : harder ? "harder" : "easier";
  const where = zone === "opening" ? "Settle in" : zone === "closing" ? "Close it out" : "The working middle";
  const consequence = harder ? "if it is there to give" : "on purpose — it comes back later";
  return `${where}: ${pct}% ${word} than your average, ${consequence}.`;
}

// ─── Constants the planners share ────────────────────────────────────────────

/** At or above this, splits are read in 5 km blocks; below it, every kilometre. */
export const SPLIT_KM_LONG_THRESHOLD_KM = 15;
export const SPLIT_KM_LONG = 5;
export const SPLIT_KM_SHORT = 1;

export function splitKmFor(distanceKm: number): number {
  return distanceKm >= SPLIT_KM_LONG_THRESHOLD_KM ? SPLIT_KM_LONG : SPLIT_KM_SHORT;
}

/** The bail-out pace is this much slower than plan pace — about 12 s/km at marathon pace. */
export const BAIL_OUT_SLOWDOWN = 0.04;
/** "Behind by more than this share of plan time at the decision point" is what triggers it. */
export const BAIL_OUT_TRIGGER_FRACTION = 0.01;

/**
 * How far ahead of the prediction a stated target may sit and still be the
 * thing the plan is built to, before widening: 3% when every input is
 * measured, ~8% when every input is a seed. A guessed prediction gets less
 * say over the athlete's own stated target, not more.
 */
export const STRETCH_TOLERANCE_BASE_PCT = 3;

/**
 * Finish band as a per-mille of predicted time, before widening — per-mille
 * because `widenForConfidence` rounds to an integer and a percent would
 * round a marathon band to the nearest ~2 minutes. Triathlon is widest: it
 * is three sports, two transitions and the weather.
 */
export const FINISH_BAND_PER_MILLE: Record<PacingDiscipline, number> = {
  run: 25,
  triathlon: 35,
  hyrox: 30,
};

/** Never exceed this share of FTP on a climb, whatever the target says. */
export const BIKE_SURGE_CEILING_FRACTION = 0.9;

/** run1→ski erg … run8→wall balls. The finish line is not a transition. */
export const HYROX_ROXZONE_CROSSINGS = 15;
