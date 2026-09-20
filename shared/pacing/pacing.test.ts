import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE, type AthleteParams } from "../athlete";
import { measured, seeded } from "../measured";
import type { Goal, GoalTargetMetrics } from "../goal";
import { TRIATHLON_DISTANCES, predictRunRace, predictTriathlon } from "../predictors/enduranceRace";
import { predictHyrox } from "../predictors/hyrox";
import { STATIONS } from "../predictors/hyroxStations";
import {
  EVEN_PROFILE,
  PACING_DISCIPLINES,
  PACING_LEGS,
  PACING_PROFILE,
  fractionSum,
  integrateFactor,
  isNegativeSplit,
  profileFor,
  splitKmFor,
  weightedFactor,
} from "./profiles";
import {
  type HyroxPacingPlan,
  type PacingPlan,
  type PacingResult,
  type RunPacingPlan,
  type TriathlonPacingPlan,
  buildSplits,
  chooseBasis,
  pacingPlan,
  pacingDisciplineFor,
  seedsFrom,
} from "./pacing";

const MARATHON_KM = 42.195;

function goal(overrides: Partial<Goal> & { targetMetrics?: GoalTargetMetrics }): Goal {
  return {
    id: "g1",
    type: "endurance_race",
    discipline: "run",
    label: "Berlin Marathon",
    targetDate: "2027-09-26",
    priority: 1,
    successCriteria: "Finish under 3:30",
    targetMetrics: {},
    constraints: [],
    createdAt: "2026-01-01",
    active: true,
    ...overrides,
  };
}

const OPTS = { today: "2026-09-18" };

function runPlan(g: Goal, a: AthleteParams = DEFAULT_ATHLETE, mult = 1): RunPacingPlan {
  const p = pacingPlan(g, a, mult, OPTS);
  assert.ok(p.available && p.discipline === "run", "expected a running pacing plan");
  return p;
}

function triPlan(g: Goal, a: AthleteParams = DEFAULT_ATHLETE, mult = 1): TriathlonPacingPlan {
  const p = pacingPlan(g, a, mult, OPTS);
  assert.ok(p.available && p.discipline === "triathlon", "expected a triathlon pacing plan");
  return p;
}

function hyroxPlan(g: Goal, a: AthleteParams = DEFAULT_ATHLETE, mult = 1): HyroxPacingPlan {
  const p = pacingPlan(g, a, mult, OPTS);
  assert.ok(p.available && p.discipline === "hyrox", "expected a HYROX pacing plan");
  return p;
}

// ─── The profile table ───────────────────────────────────────────────────────

test("the profile table is exhaustive over the disciplines and legs it claims to serve", () => {
  for (const discipline of PACING_DISCIPLINES) {
    const claimed = PACING_LEGS[discipline];
    assert.ok(claimed.length > 0, `${discipline} claims no legs at all`);
    const declared = Object.keys(PACING_PROFILE[discipline]).sort();
    assert.deepEqual(declared, [...claimed].sort(), `${discipline} declares profiles for legs it does not claim, or claims legs it has no profile for`);
    for (const leg of claimed) {
      const profile = PACING_PROFILE[discipline][leg];
      assert.ok(profile, `${discipline}/${leg} has no profile`);
      assert.ok(profile!.rationale.length > 40, `${discipline}/${leg} must say WHY it has this shape`);
    }
  }
});

test("every profile redistributes a leg without resizing it", () => {
  const all = [...PACING_DISCIPLINES.flatMap((d) => PACING_LEGS[d].map((leg) => [`${d}/${leg}`, profileFor(d, leg)] as const)), ["even", EVEN_PROFILE] as const];
  for (const [name, profile] of all) {
    assert.ok(Math.abs(fractionSum(profile) - 1) < 1e-9, `${name}: zone fractions must cover the leg exactly, got ${fractionSum(profile)}`);
    assert.ok(Math.abs(weightedFactor(profile) - 1) < 1e-9, `${name}: weighted factors must be 1 or the profile is secretly resizing the leg, got ${weightedFactor(profile)}`);
    assert.ok(Math.abs(integrateFactor(profile, 0, 1) - 1) < 1e-9, `${name}: integrating the whole leg must give the leg back`);
  }
});

test("a 70.3 bike leg is NOT prescribed a negative split, while the runs are", () => {
  const bike = profileFor("triathlon", "bike");
  assert.equal(bike.metric, "power", "the bike factor is power, not pace — reading one as the other inverts every zone");
  assert.equal(isNegativeSplit(bike), false, "finishing the bike leg harder than you rode it is how you ruin the run");
  assert.ok(bike.closing.factor <= 1, "the closing zone must not ask for more power than the leg average");
  assert.ok(bike.closing.factor < bike.middle.factor, "the last fifth must be easier than the working middle");

  assert.equal(isNegativeSplit(profileFor("run", "run")), true);
  assert.equal(isNegativeSplit(profileFor("triathlon", "run")), true);
  // HYROX runs already carry the station penalty and the drift; adding a
  // profile would count the same fade twice.
  assert.equal(isNegativeSplit(profileFor("hyrox", "run")), false);
});

test("a 70.3 bike plan puts the least power in the closing zone", () => {
  const plan = triPlan(goal({ discipline: "triathlon", label: "Ironman 70.3", targetMetrics: { targetDistanceKm: 113 } }));
  const closing = plan.bike.zones.find((z) => z.zone === "closing")!;
  const middle = plan.bike.zones.find((z) => z.zone === "middle")!;
  assert.ok(closing.targetWatts <= plan.bike.targetWatts, "closing watts must not exceed the leg average");
  assert.ok(closing.targetWatts < middle.targetWatts, "closing watts must sit below the working middle");
  assert.ok(plan.bike.ceilingWatts > plan.bike.targetWatts, "the surge ceiling must sit above the target, or it is not a ceiling");
});

// ─── Splits ──────────────────────────────────────────────────────────────────

test("a marathon negative split sums to the predicted time", () => {
  const g = goal({ targetMetrics: { targetDistanceKm: MARATHON_KM } });
  const plan = runPlan(g);
  const predicted = Math.round(predictRunRace(DEFAULT_ATHLETE, MARATHON_KM).predictedTimeMinutes * 60);

  assert.equal(plan.basis, "predicted", "no target time means the plan is built to the prediction");
  assert.ok(Math.abs(plan.planSeconds - predicted) <= 1, `plan ${plan.planSeconds} vs prediction ${predicted}`);

  const summed = plan.splits.reduce((s, x) => s + x.seconds, 0);
  assert.equal(summed, plan.planSeconds, "the splits must sum to the plan exactly");
  assert.equal(plan.splits[plan.splits.length - 1].cumulativeSeconds, plan.planSeconds, "the last cumulative IS the finish time");
  assert.equal(plan.splitKm, 5, "a marathon is read in 5 km blocks");

  const first = plan.splits[0];
  const last = plan.splits[plan.splits.length - 1];
  assert.ok(first.paceSecPerKm > last.paceSecPerKm, `negative split: opening ${first.paceSecPerKm} must be slower than closing ${last.paceSecPerKm}`);
  assert.equal(first.zone, "opening");
  assert.equal(last.zone, "closing");
});

test("a 10 km race is read in 1 km splits and still sums exactly", () => {
  const plan = runPlan(goal({ label: "Club 10K", targetMetrics: { targetDistanceKm: 10 } }));
  assert.equal(plan.splitKm, 1);
  assert.equal(plan.splits.length, 10);
  assert.equal(
    plan.splits.reduce((s, x) => s + x.seconds, 0),
    plan.planSeconds,
  );
  assert.equal(splitKmFor(21.0975), 5);
  assert.equal(splitKmFor(5), 1);
});

test("a split straddling a zone boundary is priced across both zones", () => {
  // The marathon's opening zone ends at 4.2195 km, inside the first 5 km
  // split. Pricing that split at one zone's factor would leak time.
  const profile = profileFor("run", "run");
  const straddle = integrateFactor(profile, 0, 5 / MARATHON_KM);
  const openingPart = (4.2195 / MARATHON_KM) * 1.02;
  const middlePart = ((5 - 4.2195) / MARATHON_KM) * 1.0;
  assert.ok(Math.abs(straddle - (openingPart + middlePart)) < 1e-9);

  const splits = buildSplits(12000, MARATHON_KM, 5, profile);
  assert.equal(splits[splits.length - 1].cumulativeSeconds, 12000);
});

test("the bail-out names a decision point near halfway and a pace that still finishes", () => {
  const plan = runPlan(goal({ targetMetrics: { targetDistanceKm: MARATHON_KM } }));
  assert.equal(plan.bailOut.decisionAtKm, 20, "nearest split boundary to halfway on a marathon");
  assert.ok(plan.bailOut.paceSecPerKm > plan.splits[0].paceSecPerKm, "the bail-out must be slower than plan pace");
  assert.ok(plan.bailOut.finishSeconds > plan.planSeconds, "bailing out costs time — saying otherwise would be a lie");
  assert.ok(plan.bailOut.trigger.includes("20 km"));
  assert.ok(plan.bailOut.behindBySeconds > 0);
});

test("every discipline's bail-out is a WHOLE-RACE clock, not the clock of the leg it is decided in", () => {
  // Defect: `planTriathlon` handed `bailOutFor` the RUN LEG's total, so
  // `BailOut.finishSeconds` meant "race finish" for a marathon and "run split"
  // for a triathlon — while the sentence built around it says "brings you home
  // in". A 70.3 athlete was promised a 1:45:31 finish to a 5:03:48 race, and a
  // 48:49 checkpoint their watch (reading ~4:10:55 there) would never show.
  // The old suite pinned `finishSeconds > planSeconds` for the marathon ONLY,
  // so the fixtures agreed with the bug; this runs it over every discipline so
  // a fourth cannot be added without satisfying it.
  const plans: PacingPlan[] = [
    runPlan(goal({ targetMetrics: { targetDistanceKm: MARATHON_KM } })),
    triPlan(goal({ discipline: "triathlon", label: "Ironman 70.3", targetMetrics: { targetDistanceKm: 113 } })),
    hyroxPlan(goal({ type: "hyrox", discipline: "other", targetMetrics: {} })),
  ];
  for (const plan of plans) {
    assert.ok(
      plan.bailOut.finishSeconds > plan.planSeconds,
      `${plan.discipline}: bailing out costs time, and the number it reports must be the RACE finish — got ${plan.bailOut.finishFormatted} against a plan of ${plan.planFormatted}`,
    );
  }
  for (const plan of plans) {
    assert.ok(plan.bailOut.elapsedAtDecisionSeconds < plan.bailOut.finishSeconds, `${plan.discipline}: the decision point comes before the finish`);
    assert.ok(plan.bailOut.trigger.includes(plan.bailOut.finishFormatted), `${plan.discipline}: the sentence must quote the number the field carries`);
    assert.ok(plan.bailOut.trigger.includes(plan.bailOut.elapsedAtDecisionFormatted), `${plan.discipline}: the checkpoint in words must be the checkpoint in the field`);
  }

  // The property that actually pins leg-vs-race: the triathlon's checkpoint is
  // what the athlete's watch reads, so it sits past everything in front of the
  // run rather than starting the clock again at T2.
  const tri = plans[1] as TriathlonPacingPlan;
  const beforeRun = tri.swim.seconds + tri.t1.seconds + tri.bike.seconds + tri.t2.seconds;
  assert.ok(
    tri.bailOut.elapsedAtDecisionSeconds > beforeRun,
    `the run-leg decision point must be total elapsed (${tri.bailOut.elapsedAtDecisionSeconds}s), not run-leg elapsed, against ${beforeRun}s already spent`,
  );
  // "Behind" must mean the same share of the same race in all three: 1% of a
  // run leg is a third of 1% of the triathlon it sits inside, which fired the
  // bail-out on a minute of drift in a five-hour day.
  assert.ok(
    Math.abs(tri.bailOut.behindBySeconds - tri.planSeconds * 0.01) < 1,
    `the trigger band is a share of the whole race, got ${tri.bailOut.behindBySeconds}s against ${tri.planSeconds}s`,
  );
});

// ─── The basis rule ──────────────────────────────────────────────────────────

test("a target inside tolerance is what the plan is built to; beyond it, the prediction wins", () => {
  const measuredAthlete: AthleteParams = { ...DEFAULT_ATHLETE, marathonPbMinutes: measured(200, "Valencia 2026") };
  const predicted = predictRunRace(measuredAthlete, MARATHON_KM).predictedTimeMinutes * 60;

  const near = chooseBasis(Math.round(predicted * 0.98), predicted, measuredAthlete.marathonPbMinutes.verified ? { verifiedCount: 1, totalCount: 1, unverifiedFields: [] } : { verifiedCount: 0, totalCount: 1, unverifiedFields: ["marathonPbMinutes"] }, 1);
  assert.equal(near.basis, "target", "2% ahead with a measured PB is inside the 3% tolerance");

  const far = chooseBasis(Math.round(predicted * 0.85), predicted, { verifiedCount: 1, totalCount: 1, unverifiedFields: [] }, 1);
  assert.equal(far.basis, "predicted");
  assert.ok(far.reason.includes("%"), "the athlete is told the gap and the tolerance, not just overruled");
});

test("no pacing sentence offers the athlete a control the app does not have", () => {
  // Defect: the predicted-basis reason ended "You can override this and plan
  // to the target anyway." The override is real in `PacingOptions.basis`, but
  // nothing in the client can request it — `api.pacingFor` has no call sites —
  // so the athlete hunted for a button that was never wired up. The capability
  // stays available to callers; the PROMISE of a control goes, until there is
  // one. A confident wrong statement is the failure `Measured<T>` exists to
  // prevent, and it applies to prose as much as to numbers.
  const far = chooseBasis(10000, 12600, { verifiedCount: 1, totalCount: 1, unverifiedFields: [] }, 1);
  assert.equal(far.basis, "predicted");

  const prose: string[] = [far.reason];
  for (const g of [
    goal({ targetMetrics: { targetDistanceKm: MARATHON_KM, targetTimeSeconds: 9000 } }),
    goal({ discipline: "triathlon", targetMetrics: { targetDistanceKm: 113, targetTimeSeconds: 12000 } }),
    goal({ type: "hyrox", discipline: "other", targetMetrics: { targetTimeSeconds: 3000 } }),
  ]) {
    const plan = pacingPlan(g, DEFAULT_ATHLETE, 1, OPTS);
    assert.ok(plan.available);
    prose.push(plan.basisReason, ...plan.reasons);
  }
  for (const sentence of prose) {
    assert.equal(/\boverrid/i.test(sentence), false, `promises a control that does not exist: ${sentence}`);
  }
});

test("a seeded prediction gives the athlete's own target more room than a measured one", () => {
  const allSeeds = { verifiedCount: 0, totalCount: 5, unverifiedFields: ["ftpWatts", "bikeCdA", "cssSecPer100m", "weightKg", "marathonPbMinutes"] };
  const allMeasured = { verifiedCount: 5, totalCount: 5, unverifiedFields: [] };
  const seededTolerance = chooseBasis(10000, 11000, allSeeds, 1).tolerancePct;
  const measuredTolerance = chooseBasis(10000, 11000, allMeasured, 1).tolerancePct;
  assert.ok(seededTolerance > measuredTolerance, `${seededTolerance} must exceed ${measuredTolerance}: a guessed prediction has less standing to overrule a stated target`);
  assert.equal(measuredTolerance, 3);
});

test("forcing the basis overrides the tolerance rule in both directions", () => {
  const g = goal({ targetMetrics: { targetDistanceKm: MARATHON_KM, targetTimeSeconds: 9000 } }); // 2:30, wildly ahead
  const auto = runPlan(g);
  assert.equal(auto.basis, "predicted");
  const forced = pacingPlan(g, DEFAULT_ATHLETE, 1, { ...OPTS, basis: "target" });
  assert.ok(forced.available);
  assert.equal(forced.basis, "target");
  assert.equal(forced.planSeconds, 9000);
  // An already-stretched target gets a flat profile — there is no spare tenth
  // to give away at the start.
  assert.ok(forced.discipline === "run" && forced.profile.name === "even");
});

test("a target the athlete is already inside is still what the plan is built to", () => {
  const g = goal({ targetMetrics: { targetDistanceKm: MARATHON_KM, targetTimeSeconds: 4 * 3600 } });
  const plan = runPlan(g);
  assert.equal(plan.basis, "target");
  assert.equal(plan.planSeconds, 14400);
  assert.equal(plan.goalComparison?.targetIsAhead, false);
  assert.ok(plan.goalComparison!.requirement.includes("inside"));
  assert.ok(plan.basisReason.includes("inside"), "an athlete already inside their target is told by how much");
});

// ─── Goal comparison ─────────────────────────────────────────────────────────

test("a goal comparison says how far ahead the target is and what holding it costs per kilometre", () => {
  const g = goal({ targetMetrics: { targetDistanceKm: MARATHON_KM, targetTimeSeconds: 3 * 3600 + 5 * 60 } });
  const plan = runPlan(g);
  const c = plan.goalComparison!;
  assert.ok(c.targetIsAhead);
  assert.ok(c.deltaSeconds > 0);
  assert.ok(c.requirement.includes("/km"), "what it would take must be expressed as a pace the athlete can run to");
  assert.ok(c.requirement.includes("seconds per kilometre"));
  assert.equal(c.withinTolerance, c.gapPercent <= c.tolerancePercent);
  assert.equal(plan.finish.targetSeconds, 11100);
  assert.ok(plan.finish.goalProbability != null, "a target means the predictor's probability is carried through");
});

test("with no target there is no comparison and no probability invented", () => {
  const plan = runPlan(goal({ targetMetrics: { targetDistanceKm: MARATHON_KM } }));
  assert.equal(plan.goalComparison, null);
  assert.equal(plan.finish.goalProbability, null);
  assert.equal(plan.finish.targetSeconds, null);
});

// ─── Confidence and seeds ────────────────────────────────────────────────────

test("a seeded-FTP triathlon plan names the seeds it is built on, in words", () => {
  const plan = triPlan(goal({ discipline: "triathlon", label: "Ironman 70.3", targetMetrics: { targetDistanceKm: 113 } }));
  assert.ok(plan.seeds.length > 0, "a plan off a default athlete is nearly all seeds and must say so");

  const ftp = plan.seeds.find((s) => s.field === "ftpWatts");
  assert.ok(ftp, "the bike leg is built on FTP; a seeded FTP must be reported");
  assert.ok(ftp!.label.length > 0 && !ftp!.label.includes("ftp"), "the athlete reads words, not a field name");
  assert.ok(ftp!.source.includes("seed"), "the provenance string comes straight off the Measured value");

  const cda = plan.seeds.find((s) => s.field === "bikeCdA");
  assert.equal(cda?.source, "seed — relaxed road position assumed, not measured");

  assert.ok(plan.seedWarning, "the warning is what the athlete actually reads");
  assert.ok(plan.seedWarning!.includes("estimate"));
  assert.ok(plan.reasons.some((r) => r === plan.seedWarning));
  assert.equal(plan.seeds.length, plan.confidence.unverifiedFields.length);
});

test("measuring an input removes it from the seeds and narrows the finish band", () => {
  const seededPlan = triPlan(goal({ discipline: "triathlon", targetMetrics: { targetDistanceKm: 113 } }));
  const better: AthleteParams = {
    ...DEFAULT_ATHLETE,
    ftpWatts: measured(285, "20-minute test, 3 Sep"),
    bikeCdA: measured(0.26, "aero session, 5 Sep"),
    cssSecPer100m: measured(112, "400 m / 200 m CSS test"),
    weightKg: measured(75, "scale, this morning"),
    marathonPbMinutes: measured(203, "Berlin 2025"),
  };
  const measuredPlan = triPlan(goal({ discipline: "triathlon", targetMetrics: { targetDistanceKm: 113 } }), better);

  assert.equal(measuredPlan.seeds.length, 0);
  assert.equal(measuredPlan.seedWarning, null);
  assert.ok(measuredPlan.finish.bandPerMille < seededPlan.finish.bandPerMille, "an all-measured plan must claim a tighter finish than an all-seed one");
  assert.ok(measuredPlan.finish.lowSeconds < measuredPlan.finish.predictedSeconds);
  assert.ok(measuredPlan.finish.highSeconds > measuredPlan.finish.predictedSeconds);
});

test("a calibration multiplier above 1 widens the finish band without touching the splits", () => {
  const g = goal({ targetMetrics: { targetDistanceKm: MARATHON_KM } });
  const plain = runPlan(g, DEFAULT_ATHLETE, 1);
  const widened = runPlan(g, DEFAULT_ATHLETE, 1.8);
  assert.ok(widened.finish.bandPerMille > plain.finish.bandPerMille);
  assert.deepEqual(
    widened.splits.map((s) => s.seconds),
    plain.splits.map((s) => s.seconds),
    "calibration widens what we claim to know, never what we tell the athlete to run",
  );
});

test("seedsFrom credits a measurement only when the prediction actually used it", () => {
  // The predictor reported the field as unverified, but the stored value is
  // measured — so the prediction used its own default and saying "measured
  // yesterday" would credit a measurement this plan never touched.
  const a: AthleteParams = { ...DEFAULT_ATHLETE, ftpWatts: measured(300, "20-minute test, yesterday") };
  const rows = seedsFrom({ verifiedCount: 0, totalCount: 1, unverifiedFields: ["ftpWatts"] }, a);
  assert.equal(rows[0].source, "not measured for this plan");

  const seededRows = seedsFrom({ verifiedCount: 0, totalCount: 1, unverifiedFields: ["ftpWatts"] }, { ...DEFAULT_ATHLETE, ftpWatts: seeded(285) });
  assert.ok(seededRows[0].source.includes("seed"));
});

// ─── Triathlon ───────────────────────────────────────────────────────────────

test("a 70.3 plan gives a swim pace, bike watts, transitions and brick-penalised run splits", () => {
  const plan = triPlan(goal({ discipline: "triathlon", label: "Ironman 70.3", targetMetrics: { targetDistanceKm: 113 } }));
  const prediction = predictTriathlon(DEFAULT_ATHLETE, TRIATHLON_DISTANCES["70.3"]);

  assert.equal(plan.format, "70.3");
  assert.equal(plan.legScale, 1, "with no target the legs are the prediction's own");
  assert.ok(Math.abs(plan.planSeconds - Math.round(prediction.totalTimeMinutes * 60)) <= 2);

  const summed = plan.swim.seconds + plan.t1.seconds + plan.bike.seconds + plan.t2.seconds + plan.run.seconds;
  assert.equal(summed, plan.planSeconds, "the five legs must account for the whole race");

  assert.ok(Math.abs(plan.swim.secPer100m - Math.round((prediction.swimTimeMinutes * 60) / (TRIATHLON_DISTANCES["70.3"].swimKm * 10))) <= 1);
  assert.equal(plan.bike.targetWatts, Math.round(DEFAULT_ATHLETE.ftpWatts.value * 0.75), "race power comes from the predictor's own fraction of FTP");
  assert.ok(plan.bike.speedKmh > 20 && plan.bike.speedKmh < 55);
  assert.ok(plan.t1.seconds > 0 && plan.t2.seconds > 0);

  assert.equal(
    plan.run.splits.reduce((s, x) => s + x.seconds, 0),
    plan.run.seconds,
  );
  const freshHalf = predictRunRace(DEFAULT_ATHLETE, TRIATHLON_DISTANCES["70.3"].runKm).predictedTimeMinutes * 60;
  assert.ok(plan.run.seconds > freshHalf, "the run leg must be slower than the same distance run fresh — the brick penalty is real and already in the prediction");
  assert.ok(plan.bailOut.trigger.includes("run"), "the triathlon bail-out is decided on the run leg");
});

test("planning a triathlon to a target scales the legs and solves the watts that deliver it", () => {
  const prediction = predictTriathlon(DEFAULT_ATHLETE, TRIATHLON_DISTANCES.olympic);
  const predictedSeconds = Math.round(prediction.totalTimeMinutes * 60);
  const target = predictedSeconds - 120; // just inside the widened tolerance
  const plan = triPlan(goal({ discipline: "triathlon", label: "Olympic", targetMetrics: { targetDistanceKm: 51.5, targetTimeSeconds: target } }));

  assert.equal(plan.basis, "target");
  assert.equal(plan.planSeconds, target);
  assert.equal(plan.swim.seconds + plan.t1.seconds + plan.bike.seconds + plan.t2.seconds + plan.run.seconds, target);
  assert.ok(plan.legScale < 1, "hitting a faster time means every moving leg scales down");

  // The solved watts must actually produce the planned bike split when fed
  // back through the predictor — the whole point of bisecting it rather than
  // re-deriving the power equation here.
  const impliedFtp = plan.bike.targetWatts / 0.75;
  const check = predictTriathlon({ ...DEFAULT_ATHLETE, ftpWatts: { ...DEFAULT_ATHLETE.ftpWatts, value: impliedFtp } }, TRIATHLON_DISTANCES.olympic);
  // Watts are shown as a whole number, and a single watt is worth a few
  // seconds over an Olympic bike leg — so the two agree to within that
  // rounding, not to the second. The leg times summing to the plan exactly is
  // the invariant that matters; the watt number is what the athlete rides to.
  assert.ok(Math.abs(check.bikeTimeMinutes * 60 - plan.bike.seconds) < 8, `solved watts give ${check.bikeTimeMinutes * 60}s, plan says ${plan.bike.seconds}s`);
  assert.ok(plan.bike.targetWatts > Math.round(DEFAULT_ATHLETE.ftpWatts.value * 0.75), "a faster bike split needs more watts, and the plan says how many");
});

test("a triathlon target that needs more than the surge ceiling is called out", () => {
  const prediction = predictTriathlon(DEFAULT_ATHLETE, TRIATHLON_DISTANCES.olympic);
  const target = Math.round(prediction.totalTimeMinutes * 60 * 0.9);
  const plan = triPlan(goal({ discipline: "triathlon", targetMetrics: { targetDistanceKm: 51.5, targetTimeSeconds: target } }), DEFAULT_ATHLETE);
  const forced = pacingPlan(goal({ discipline: "triathlon", targetMetrics: { targetDistanceKm: 51.5, targetTimeSeconds: target } }), DEFAULT_ATHLETE, 1, {
    ...OPTS,
    basis: "target",
  });
  assert.ok(forced.available && forced.discipline === "triathlon");
  if (forced.bike.targetWatts > forced.bike.ceilingWatts) {
    assert.ok(forced.reasons.some((r) => r.includes("ceiling")), "riding above the ceiling must be stated, not silently planned");
  }
  assert.ok(plan.goalComparison!.requirement.includes("bike"), "the comparison says where the time would have to come from");
});

// ─── HYROX ───────────────────────────────────────────────────────────────────

test("HYROX splits sum to the predicted total including the roxzone", () => {
  const g = goal({ type: "hyrox", discipline: "other", label: "HYROX Manchester", targetMetrics: {} });
  const plan = hyroxPlan(g);
  const prediction = predictHyrox(DEFAULT_ATHLETE, 3600);

  assert.equal(plan.segments.length, STATIONS.length * 2, "eight runs and eight stations");
  assert.equal(plan.planSeconds, prediction.totalSeconds);

  const last = plan.segments[plan.segments.length - 1];
  assert.equal(last.cumulativeSeconds, prediction.totalSeconds, "the running cumulative must land exactly on the predicted finish");
  assert.equal(last.kind, "station");
  assert.equal(last.transitionSeconds, 0, "the finish line is not a transition");

  const segmentSeconds = plan.segments.reduce((s, x) => s + x.seconds, 0);
  const transitionSeconds = plan.segments.reduce((s, x) => s + x.transitionSeconds, 0);
  assert.equal(transitionSeconds, prediction.roxzoneSeconds, "the roxzone must be spread across the crossings without losing or inventing a second");
  assert.equal(segmentSeconds + transitionSeconds, prediction.totalSeconds);
  assert.equal(plan.segments.filter((s) => s.transitionSeconds > 0).length, 15);
  assert.equal(plan.roxzone.crossings, 15);
});

test("a HYROX plan is always built to the prediction, and says why", () => {
  const g = goal({ type: "hyrox", discipline: "other", targetMetrics: { targetTimeSeconds: 3900 } });
  const plan = hyroxPlan(g);
  assert.equal(plan.basis, "predicted");
  assert.ok(plan.basisReason.includes("Stations do not pace"));
  assert.ok(plan.finish.goalProbability != null, "the target still gets a probability, it just does not move the splits");
  assert.ok(plan.goalComparison);
  const forced = pacingPlan(g, DEFAULT_ATHLETE, 1, { ...OPTS, basis: "target" });
  assert.ok(forced.available && forced.basis === "predicted", "even a forced basis cannot make stations pace");
});

test("HYROX runs carry the station in front of them and the plan says which", () => {
  const plan = hyroxPlan(goal({ type: "hyrox", discipline: "other", targetMetrics: {} }));
  const runs = plan.segments.filter((s) => s.kind === "run");
  assert.equal(runs.length, 8);
  assert.equal(runs[0].precededBy, null);
  assert.equal(runs[1].precededBy, "ski_erg");
  assert.ok(runs[1].seconds > runs[0].seconds, "run 2 comes off the SkiErg and must be slower than the fresh kilometre");
  assert.ok(runs[1].note.includes("SkiErg"), "the athlete is told the station by name, not by id");
  assert.ok(plan.bailOut.decisionAtKm === 4 && plan.bailOut.trigger.includes("fourth run"));
  assert.ok(plan.limiters.length >= 0);
});

test("a measured station benchmark drops out of the seeds", () => {
  const a: AthleteParams = { ...DEFAULT_ATHLETE, benchmarks: { wall_balls: measured(210, "gym test, 2 Sep") } };
  const plan = hyroxPlan(goal({ type: "hyrox", discipline: "other", targetMetrics: {} }), a);
  assert.ok(!plan.seeds.some((s) => s.field === "benchmark_wall_balls"), "a measured benchmark is not a seed");
  const skiErg = plan.seeds.find((s) => s.field === "benchmark_ski_erg");
  assert.ok(skiErg && skiErg.label.includes("SkiErg"), "an unmeasured one is named in words");
});

// ─── Unavailable ─────────────────────────────────────────────────────────────

function unavailable(result: PacingResult) {
  assert.equal(result.available, false);
  return result as Extract<PacingResult, { available: false }>;
}

test("a running goal with no distance gets an honest gap, not a guessed race", () => {
  const u = unavailable(pacingPlan(goal({ targetMetrics: {} }), DEFAULT_ATHLETE, 1, OPTS));
  assert.equal(u.reason, "missing_target_distance");
  assert.equal(u.fix?.field, "targetDistanceKm");
  assert.ok(u.message.includes("Berlin Marathon"));
});

test("a triathlon goal with an unrecognisable distance asks for the format", () => {
  const u = unavailable(pacingPlan(goal({ discipline: "triathlon", targetMetrics: { targetDistanceKm: 77 } }), DEFAULT_ATHLETE, 1, OPTS));
  assert.equal(u.reason, "missing_triathlon_format");
  const ok = pacingPlan(goal({ discipline: "triathlon", targetMetrics: { targetDistanceKm: 226 } }), DEFAULT_ATHLETE, 1, OPTS);
  assert.ok(ok.available && ok.discipline === "triathlon" && ok.format === "full", "a full-distance total resolves to the full format");
});

test("goals with no start line say so instead of returning an empty plan", () => {
  assert.equal(unavailable(pacingPlan(goal({ discipline: "cycling", targetMetrics: { targetDistanceKm: 160 } }), DEFAULT_ATHLETE, 1, OPTS)).reason, "unsupported_discipline");
  assert.equal(unavailable(pacingPlan(goal({ type: "body_composition", discipline: "other" }), DEFAULT_ATHLETE, 1, OPTS)).reason, "unsupported_goal_type");
  assert.equal(pacingDisciplineFor(goal({ type: "strength", discipline: "other" })), null);
  assert.equal(pacingDisciplineFor(goal({ type: "hyrox", discipline: "other" })), "hyrox");
  assert.equal(pacingDisciplineFor(goal({ discipline: "triathlon" })), "triathlon");
});

test("a target that equals the prediction reads as one time, not as a zero margin", () => {
  // Found by looking at a generated plan rather than by a failing test: the
  // margin branch printed "already have you 0:00 inside 3:30:00", which reads
  // like a broken number instead of a coincidence.
  const a: AthleteParams = { ...DEFAULT_ATHLETE, marathonPbMinutes: measured(210, "Berlin 2025") };
  const predicted = Math.round(predictRunRace(a, MARATHON_KM).predictedTimeMinutes * 60);
  const plan = runPlan(goal({ targetMetrics: { targetDistanceKm: MARATHON_KM, targetTimeSeconds: predicted } }), a);
  assert.equal(plan.basis, "target");
  assert.ok(plan.basisReason.includes("exactly what your numbers say"), plan.basisReason);
  assert.ok(!/ 0:00\b/.test(plan.basisReason), plan.basisReason);
  assert.ok(!/ 0:00\b/.test(plan.goalComparison!.requirement), plan.goalComparison!.requirement);
  assert.ok(plan.goalComparison!.requirement.includes("same time"));
});

// ─── The athlete never reads an id ───────────────────────────────────────────

test("no athlete-facing sentence contains a field name, a kind id or an enum value", () => {
  const prose: string[] = [];
  const collect = (plan: PacingResult) => {
    if (!plan.available) {
      prose.push(plan.message);
      return;
    }
    prose.push(plan.basisReason, ...plan.reasons, plan.bailOut.trigger);
    if (plan.seedWarning) prose.push(plan.seedWarning);
    if (plan.goalComparison) prose.push(plan.goalComparison.requirement);
    if (plan.discipline === "run") prose.push(...plan.splits.map((s) => s.note), plan.profile.rationale);
    if (plan.discipline === "triathlon") {
      prose.push(plan.swim.note, plan.bike.note, plan.t1.note, plan.t2.note, plan.run.brickNote);
      prose.push(...plan.swim.zones.map((z) => z.note), ...plan.bike.zones.map((z) => z.note), ...plan.run.splits.map((s) => s.note));
    }
    if (plan.discipline === "hyrox") prose.push(...plan.segments.map((s) => s.note), plan.roxzone.note);
  };

  collect(pacingPlan(goal({ targetMetrics: { targetDistanceKm: MARATHON_KM, targetTimeSeconds: 11100 } }), DEFAULT_ATHLETE, 1, OPTS));
  collect(pacingPlan(goal({ discipline: "triathlon", targetMetrics: { targetDistanceKm: 113 } }), DEFAULT_ATHLETE, 1, OPTS));
  collect(pacingPlan(goal({ type: "hyrox", discipline: "other", targetMetrics: { targetTimeSeconds: 3900 } }), DEFAULT_ATHLETE, 1, OPTS));
  collect(pacingPlan(goal({ targetMetrics: {} }), DEFAULT_ATHLETE, 1, OPTS));

  const idish = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/;
  for (const sentence of prose) {
    assert.ok(sentence.length > 0, "an athlete-facing string may never be blank");
    assert.equal(idish.test(sentence), false, `an id leaked into athlete-facing words: ${sentence}`);
  }
});
