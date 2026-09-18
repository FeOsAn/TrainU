import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE } from "../athlete";
import { measured } from "../measured";
import { DISCIPLINES, type Discipline, type Goal, type GoalType } from "../goal";
import { arbitrateWeek } from "../arbitration/arbitrate";
import { prescribeWeek, splitOccurrences } from "./prescribe";
import { SESSION_KINDS, type SessionKind } from "./sessionKinds";
import { GOAL_QUALITIES, KIND_MINUTES, OCCURRENCE_SHARES, qualitiesFor } from "./templates";

const MONDAY = "2026-09-14";

function goal(over: Partial<Goal>): Goal {
  return {
    id: "g",
    type: "endurance_race",
    discipline: "run",
    label: "Goal",
    targetDate: "2027-06-01",
    priority: 1,
    successCriteria: "",
    targetMetrics: {},
    constraints: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    active: true,
    ...over,
  };
}

function prescribe(goals: Goal[], athlete = DEFAULT_ATHLETE, daysPerWeek?: number) {
  const week = arbitrateWeek(goals, MONDAY, athlete);
  return prescribeWeek(week, goals, athlete, { daysPerWeek });
}

test("no active goals prescribes nothing rather than inventing a week", () => {
  const w = prescribe([]);
  assert.equal(w.sessions.length, 0);
  assert.match(w.note, /No active goals/);
});

test("a single endurance goal gets the qualities that matter, long run included", () => {
  const w = prescribe([goal({ id: "race" })]);
  const kinds = w.sessions.map((s) => s.kind);
  assert.ok(kinds.includes("run_long"), "the long run is the highest-return session for a distance goal");
  assert.ok(kinds.includes("run_easy"));
  assert.equal(w.sessions.length, 5, "should fill the default 5 training days");
});

test("every prescribed session carries real numbers, not vague instructions", () => {
  const athlete = { ...DEFAULT_ATHLETE, runThresholdSecPerKm: measured(240, "1 km TT"), runEasySecPerKm: measured(330, "median easy") };
  const w = prescribe([goal({ id: "race" })], athlete);
  for (const session of w.sessions) {
    assert.ok(session.targets.length > 0, `${session.kind} has no targets`);
    assert.ok(session.durationMinutes >= 20, `${session.kind} duration is implausible`);
    assert.ok(session.tss > 0, `${session.kind} priced at zero TSS`);
  }
  const easy = w.sessions.find((s) => s.kind === "run_easy")!;
  assert.ok(easy.targets[0]!.includes("5:30/km"), `easy pace should come off the athlete's own easy pace, got: ${easy.targets[0]}`);
});

test("threshold pace is derived from the fresh kilometre, not mistaken for it", () => {
  // 240 s/km all-out kilometre → threshold ~17% slower, i.e. about 4:41/km.
  const athlete = { ...DEFAULT_ATHLETE, runThresholdSecPerKm: measured(240, "1 km TT") };
  const w = prescribe([goal({ id: "race", targetDate: "2026-11-15" })], athlete); // build phase allows threshold
  const threshold = w.sessions.find((s) => s.kind === "run_threshold");
  assert.ok(threshold, "a build phase should include threshold work");
  assert.ok(threshold!.targets[0]!.includes("4:41"), `expected ~4:41/km threshold off a 4:00 km, got: ${threshold!.targets[0]}`);
});

test("two goals that both want an easy run get ONE easy run serving both", () => {
  const race = goal({ id: "race", type: "endurance_race", label: "Marathon", priority: 1 });
  const fitness = goal({ id: "fit", type: "general_fitness", label: "General fitness", priority: 2 });
  const w = prescribe([race, fitness]);

  const easyRuns = w.sessions.filter((s) => s.kind === "run_easy");
  assert.ok(easyRuns.length >= 1);
  const shared = easyRuns.find((s) => s.servesGoalIds.length > 1);
  assert.ok(shared, "an easy run wanted by both goals should be one session serving both, not two sessions");
  assert.match(shared!.note, /at once/);
});

test("the higher-priority goal gets more of the week", () => {
  const race = goal({ id: "race", type: "endurance_race", label: "Marathon", priority: 1 });
  const lift = goal({ id: "lift", type: "strength", label: "Squat PR", priority: 3 });
  const w = prescribe([race, lift], DEFAULT_ATHLETE, 5);

  const raceSessions = w.sessions.filter((s) => s.servesGoalIds.includes("race")).length;
  const liftSessions = w.sessions.filter((s) => s.servesGoalIds.includes("lift")).length;
  assert.ok(raceSessions > liftSessions, `priority 1 should out-allocate priority 3, got ${raceSessions} vs ${liftSessions}`);
});

test("a body-composition goal contributes lifting, not cardio it can't recover from", () => {
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(82, "scale") };
  const cut = goal({ id: "cut", type: "body_composition", label: "Wedding", targetDate: "2026-11-01", targetMetrics: { targetWeightKg: 78 } });
  const w = prescribe([cut], athlete);
  const kinds = w.sessions.map((s) => s.kind);
  assert.ok(kinds.includes("strength_lower"), "lifting is what protects lean mass in a deficit");
  assert.ok(!kinds.includes("run_intervals"), "a deficit phase shouldn't prescribe intensity it can't recover from");
});

test("a base week doesn't get two threshold runs just because the ceiling downgraded the intervals slot", () => {
  const w = prescribe([goal({ id: "race", targetDate: "2027-06-01" })]); // far out → base, ceiling "threshold"
  const hard = w.sessions.filter((s) => s.intensity === "hard");
  assert.ok(hard.length <= 1, `a base week should carry at most one hard session, got ${hard.map((s) => s.kind).join(", ")}`);
  assert.ok(w.sessions.filter((s) => s.kind === "run_easy").length >= 2, "the surplus intensity should become aerobic volume");
});

test("a build week still gets BOTH threshold and intervals — they're different qualities", () => {
  const w = prescribe([goal({ id: "race", targetDate: "2026-11-15" })]); // ~9 weeks → build, ceiling "full"
  const kinds = w.sessions.map((s) => s.kind);
  assert.ok(kinds.includes("run_threshold"));
  assert.ok(kinds.includes("run_intervals"));
});

test("the week's size scales with the arbitrated load multiplier", () => {
  const taperGoal = goal({ id: "race", targetDate: "2026-09-18" }); // days out → taper, ~0.5x
  const baseGoal = goal({ id: "race2", targetDate: "2027-09-01" }); // far out → base, 1.0x

  const taperWeek = prescribe([taperGoal]);
  const baseWeek = prescribe([baseGoal]);
  assert.ok(taperWeek.totalMinutes < baseWeek.totalMinutes, "a taper week must be smaller than a base week");
});

test("fewer available days drops the least important qualities, never the long run", () => {
  const w3 = prescribe([goal({ id: "race" })], DEFAULT_ATHLETE, 3);
  assert.equal(w3.sessions.length, 3);
  assert.ok(w3.sessions.some((s) => s.kind === "run_long"), "the long run survives a squeezed week");
});

test("hard sessions don't land on back-to-back days", () => {
  const w = prescribe([goal({ id: "race", type: "hyrox", targetDate: "2026-11-15" })], DEFAULT_ATHLETE, 6);
  const hardDates = w.sessions.filter((s) => s.intensity === "hard").map((s) => Date.parse(`${s.date}T00:00:00Z`)).sort();
  for (let i = 1; i < hardDates.length; i++) {
    assert.ok(hardDates[i]! - hardDates[i - 1]! > 86_400_000, "two hard sessions landed on consecutive days");
  }
});

test("no session gets an absurd duration, however the budget falls", () => {
  // The bug this guards: a week whose slots are mostly strength handed the
  // entire remaining aerobic budget to the one easy run in it — 225 minutes.
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(82, "scale") };
  const cut = goal({ id: "cut", type: "body_composition", label: "Wedding", targetDate: "2026-11-01", priority: 1, targetMetrics: { targetWeightKg: 78 } });
  const race = goal({ id: "race", type: "endurance_race", label: "Ironman", targetDate: "2027-06-13", priority: 2 });
  const w = prescribe([cut, race], athlete, 5);

  for (const session of w.sessions) {
    assert.ok(session.durationMinutes <= 210, `${session.kind} is ${session.durationMinutes} min — nobody does that session`);
    if (session.kind === "run_easy") {
      assert.ok(session.durationMinutes <= 80, `an easy run of ${session.durationMinutes} min is not an easy run`);
    }
  }
});

test("the long run is always the week's longest aerobic session", () => {
  const athlete = { ...DEFAULT_ATHLETE, weightKg: measured(82, "scale") };
  const cut = goal({ id: "cut", type: "body_composition", targetDate: "2026-11-01", priority: 1, targetMetrics: { targetWeightKg: 78 } });
  const race = goal({ id: "race", type: "endurance_race", targetDate: "2027-06-13", priority: 2 });

  for (const goals of [[race], [cut, race], [race, cut]]) {
    const w = prescribe(goals, athlete, 5);
    const long = w.sessions.find((s) => s.kind === "run_long");
    if (!long) continue;
    const otherAerobic = w.sessions.filter((s) => s.kind !== "run_long" && s.sport !== "strength");
    for (const other of otherAerobic) {
      assert.ok(long.durationMinutes > other.durationMinutes, `long run (${long.durationMinutes}) should exceed ${other.kind} (${other.durationMinutes})`);
    }
  }
});

test("prescription is deterministic — same inputs, same week, every time", () => {
  const goals = [goal({ id: "race", priority: 1 }), goal({ id: "cut", type: "body_composition", priority: 2, targetDate: "2026-11-01", targetMetrics: { targetWeightKg: 78 } })];
  const a = prescribe(goals);
  const b = prescribe(goals);
  assert.deepEqual(a, b);
});

test("a past goal contributes no sessions", () => {
  const past = goal({ id: "old", targetDate: "2020-01-01" });
  const live = goal({ id: "live", targetDate: "2027-06-01" });
  const w = prescribe([past, live]);
  assert.ok(w.sessions.every((s) => !s.servesGoalIds.includes("old")), "a goal that already happened shouldn't be prescribed for");
});


// ─── Discipline ──────────────────────────────────────────────────────────────

test("a triathlon goal is prescribed swim and bike sessions, not a marathon plan", () => {
  // The gap the app-shell assembler surfaced: `endurance_race` covered both a
  // marathon and an Ironman, so every endurance goal took the run-only
  // quality list — while prescribe.ts had complete swim and bike sessions
  // (targets, TSS weights, duration bounds, rationale) that nothing could ask
  // for. An Ironman athlete was handed a marathon plan.
  const w = prescribe([goal({ discipline: "triathlon", label: "Ironman 70.3" })], DEFAULT_ATHLETE, 6);
  const sports = new Set(w.sessions.map((s) => s.sport));
  assert.ok(sports.has("bike"), `a triathlon week must contain a ride, got: ${[...sports].join(", ")}`);
  assert.ok(sports.has("swim"), `a triathlon week must contain a swim, got: ${[...sports].join(", ")}`);
  assert.ok(sports.has("run"), "and still run");
});

test("a run-discipline endurance goal is unchanged by the discipline field", () => {
  const w = prescribe([goal({ discipline: "run" })], DEFAULT_ATHLETE, 5);
  const sports = new Set(w.sessions.map((s) => s.sport));
  assert.ok(!sports.has("bike") && !sports.has("swim"), "a marathoner gets no swim/bike — this is the behaviour that was always correct");
});

test("the triathlon week's sessions carry real swim and bike targets", () => {
  const athlete = { ...DEFAULT_ATHLETE, ftpWatts: measured(290, "20 min test"), cssSecPer100m: measured(105, "400 m TT") };
  const w = prescribe([goal({ discipline: "triathlon" })], athlete, 6);
  const ride = w.sessions.find((s) => s.sport === "bike");
  const swim = w.sessions.find((s) => s.sport === "swim");
  assert.ok(ride && ride.targets.length > 0, "a prescribed ride with no numbers is the coefficient problem again");
  assert.ok(swim && swim.targets.length > 0);
  assert.ok(ride.targets.some((t) => /\d+\s*W/.test(t)), `the ride should carry watts off FTP, got: ${ride.targets.join(" | ")}`);
});

test("a triathlon goal and a body-composition goal still merge into one week", () => {
  const w = prescribe(
    [
      goal({ id: "tri", discipline: "triathlon", label: "Ironman 70.3", priority: 1 }),
      goal({ id: "wed", type: "body_composition", discipline: "other", label: "Wedding", targetDate: "2026-11-01", priority: 2 }),
    ],
    DEFAULT_ATHLETE,
    6,
  );
  assert.ok(w.sessions.length > 0);
  assert.ok(w.sessions.length <= 6, `six days must not produce ${w.sessions.length} sessions`);
  const sports = new Set(w.sessions.map((s) => s.sport));
  assert.ok(sports.has("bike") || sports.has("swim"), "the triathlon is the priority-1 goal; it must survive arbitration with a second goal");
});


// ─── Per-occurrence sizing ───────────────────────────────────────────────────
//
// The Phase 8 limitation this closes: minutes were allocated per KIND, so the
// Nth session of a kind was a copy of the first and a 70.3 week came out with
// two identical 106-minute rides. The per-kind allocation is unchanged — only
// how that total is distributed across the kind's occurrences.

test("splitting one occurrence returns the whole allocation, decaying kind or not", () => {
  assert.deepEqual(splitOccurrences("bike_endurance", 106, 1), [106]);
  assert.deepEqual(splitOccurrences("run_long", 93, 1), [93]);
});

test("a kind with no share table splits exactly equally — this is what keeps a runner's week unchanged", () => {
  assert.deepEqual(splitOccurrences("run_easy", 156, 3), [52, 52, 52]);
  assert.deepEqual(splitOccurrences("run_threshold", 120, 2), [60, 60]);
});

test("an endurance kind decays, and the kind's total is conserved to the minute", () => {
  const two = splitOccurrences("bike_endurance", 212, 2);
  assert.deepEqual(two, [128, 84]);
  assert.equal(two.reduce((a, b) => a + b, 0), 212, "redistributed, never reduced");

  const three = splitOccurrences("bike_endurance", 225, 3);
  assert.deepEqual(three, [105, 68, 52]);
  assert.equal(three.reduce((a, b) => a + b, 0), 225);
});

test("a ceiling redistributes the overflow instead of deleting it", () => {
  // The plausible-but-wrong version of this caps the first occurrence and
  // walks away, silently removing 27 minutes of swimming from the week.
  const split = splitOccurrences("swim_technique", 219, 3);
  assert.deepEqual(split, [75, 75, 69]);
  assert.equal(split.reduce((a, b) => a + b, 0), 219, "the cap must move minutes, not destroy them");
  for (const minutes of split) assert.ok(minutes <= KIND_MINUTES.swim_technique.max);
});

test("a floor is paid for out of the long one, and everything at its ceiling stays there", () => {
  const floored = splitOccurrences("swim_technique", 90, 3);
  assert.deepEqual(floored, [30, 30, 30]);
  assert.equal(floored.reduce((a, b) => a + b, 0), 90);
  for (const minutes of floored) assert.ok(minutes >= KIND_MINUTES.swim_technique.min);

  assert.deepEqual(splitOccurrences("bike_endurance", 480, 2), [240, 240]);
});

test("the fourth occurrence and beyond repeat the last share", () => {
  const split = splitOccurrences("bike_endurance", 400, 4);
  assert.deepEqual(split, [152, 98, 75, 75]);
  assert.equal(split.reduce((a, b) => a + b, 0), 400);
  for (let i = 1; i < split.length; i++) assert.ok(split[i]! <= split[i - 1]!, "a later occurrence is never longer than an earlier one");
});

test("a marathon week is byte-identical to what it was before occurrences were sized", () => {
  // The invariant the whole change is held to: a runner's week must not move
  // by a single minute or a single day.
  const base = prescribe([goal({ id: "race" })], DEFAULT_ATHLETE, 5);
  assert.deepEqual(
    base.sessions.map((s) => [s.date, s.kind, s.durationMinutes, s.tss]),
    [
      ["2026-09-14", "run_easy", 52, 28],
      ["2026-09-15", "run_threshold", 52, 93],
      ["2026-09-16", "run_easy", 52, 28],
      ["2026-09-18", "run_easy", 52, 28],
      ["2026-09-19", "run_long", 93, 114],
    ],
  );
  assert.equal(base.totalMinutes, 301);
  assert.equal(base.totalTss, 291);

  const build = prescribe([goal({ id: "race", targetDate: "2026-11-15" })], DEFAULT_ATHLETE, 5);
  assert.deepEqual(
    build.sessions.map((s) => [s.date, s.kind, s.durationMinutes, s.tss]),
    [
      ["2026-09-14", "run_easy", 61, 33],
      ["2026-09-15", "run_threshold", 61, 109],
      ["2026-09-16", "run_easy", 61, 33],
      ["2026-09-17", "run_intervals", 54, 96],
      ["2026-09-19", "run_long", 109, 133],
    ],
  );
  assert.equal(build.totalMinutes, 346);
  assert.equal(build.totalTss, 404);
});

test("three easy runs in a runner's week stay three equal easy runs", () => {
  const w = prescribe([goal({ id: "race" })], DEFAULT_ATHLETE, 5);
  const easy = w.sessions.filter((s) => s.kind === "run_easy");
  assert.equal(easy.length, 3);
  assert.equal(new Set(easy.map((s) => s.durationMinutes)).size, 1, "easy runs do not decay — a goal asking for three means three of the same");
  assert.deepEqual(easy.map((s) => s.occurrence), [{ n: 1, of: 3 }, { n: 2, of: 3 }, { n: 3, of: 3 }]);
});

test("a triathlon week gets one long weekend ride and one shorter midweek ride, same bike total", () => {
  // Before: two identical 106-minute rides, one on Monday and one on Sunday.
  const w = prescribe([goal({ discipline: "triathlon", label: "Ironman 70.3" })], DEFAULT_ATHLETE, 6);
  const rides = w.sessions.filter((s) => s.kind === "bike_endurance");
  assert.equal(rides.length, 2);

  const long = rides.find((s) => s.occurrence!.n === 1)!;
  const short = rides.find((s) => s.occurrence!.n === 2)!;
  assert.equal(long.durationMinutes, 128);
  assert.equal(short.durationMinutes, 84);
  assert.equal(long.durationMinutes + short.durationMinutes, 212, "the bike's weekly volume is redistributed, not reduced");
  assert.equal(long.date, "2026-09-20", "the long ride takes the weekend, not the first free Monday slot");

  // The rest of the week is untouched by the split.
  assert.equal(w.totalMinutes, 374);
  assert.equal(w.totalTss, 289);
  assert.equal(w.sessions.find((s) => s.kind === "run_long")!.durationMinutes, 53);
  assert.equal(w.sessions.find((s) => s.kind === "swim_technique")!.durationMinutes, 39);
});

test("the athlete is told why two rides are different lengths", () => {
  const w = prescribe([goal({ discipline: "triathlon", label: "Ironman 70.3" })], DEFAULT_ATHLETE, 6);
  const rides = w.sessions.filter((s) => s.kind === "bike_endurance");
  const long = rides.find((s) => s.occurrence!.n === 1)!;
  const short = rides.find((s) => s.occurrence!.n === 2)!;
  assert.match(long.note, /long ride/, "an unexplained 128 vs 84 reads as a bug, not a plan");
  assert.match(short.note, /Sunday/, "the short one names the day the long one is on");
  for (const session of w.sessions) {
    for (const kind of SESSION_KINDS) assert.ok(!session.note.includes(kind), `an identifier reached the athlete: ${session.note}`);
  }
});

test("a flattened split explains nothing rather than claiming a distinction the minutes contradict", () => {
  // The swim ceiling binds at 75 min, so this week is 75 / 75 / 69: there is
  // no "long one" to point at.
  const w = prescribe([goal({ discipline: "swimming" })], DEFAULT_ATHLETE, 5);
  const swims = w.sessions.filter((s) => s.kind === "swim_technique");
  assert.deepEqual(swims.map((s) => s.durationMinutes).sort((a, b) => b - a), [75, 75, 69]);
  for (const swim of swims) assert.ok(!/shorter|long swim/i.test(swim.note), `claimed a long/short split that isn't there: ${swim.note}`);
});

test("every discipline's week conserves the minutes it had before, kind by kind", () => {
  const cases: Array<{ discipline: Discipline; days: number; totalMinutes: number; perKind: Partial<Record<SessionKind, number>> }> = [
    { discipline: "triathlon", days: 6, totalMinutes: 374, perKind: { bike_endurance: 212, swim_technique: 39, run_long: 53 } },
    { discipline: "triathlon", days: 7, totalMinutes: 432, perKind: { bike_endurance: 224, swim_technique: 82 } },
    { discipline: "cycling", days: 5, totalMinutes: 305, perKind: { bike_endurance: 225 } },
    { discipline: "swimming", days: 5, totalMinutes: 299, perKind: { swim_technique: 219 } },
  ];
  for (const { discipline, days, totalMinutes, perKind } of cases) {
    const w = prescribe([goal({ discipline })], DEFAULT_ATHLETE, days);
    assert.equal(w.totalMinutes, totalMinutes, `${discipline} ${days}-day week changed size`);
    for (const [kind, expected] of Object.entries(perKind)) {
      const sum = w.sessions.filter((s) => s.kind === kind).reduce((total, s) => total + s.durationMinutes, 0);
      assert.equal(sum, expected, `${discipline} ${days}-day: ${kind} volume moved`);
    }
  }
});

test("the first occurrence IS the anchor — longest and on the weekend", () => {
  const tri = prescribe([goal({ discipline: "triathlon" })], DEFAULT_ATHLETE, 6);
  const triAnchor = tri.sessions.find((s) => s.kind === "bike_endurance" && s.occurrence!.n === 1)!;
  for (const other of tri.sessions.filter((s) => s !== triAnchor && s.sport !== "strength")) {
    assert.ok(triAnchor.durationMinutes > other.durationMinutes, `the anchor (${triAnchor.durationMinutes}) should outlast ${other.kind} (${other.durationMinutes})`);
  }
  const triLongRun = tri.sessions.find((s) => s.kind === "run_long")!;
  assert.equal(triLongRun.date, "2026-09-19", "the long run keeps Saturday; the long ride takes Sunday");
  for (const run of tri.sessions.filter((s) => s.sport === "run" && s.kind !== "run_long")) {
    assert.ok(triLongRun.durationMinutes > run.durationMinutes, "the long run still outlasts every other run");
  }

  const cycling = prescribe([goal({ discipline: "cycling" })], DEFAULT_ATHLETE, 5);
  const cyclingAnchor = cycling.sessions.find((s) => s.occurrence!.n === 1 && s.kind === "bike_endurance")!;
  assert.equal(cyclingAnchor.date, "2026-09-19", "with no long run in the week the anchor takes Saturday itself");
  for (const other of cycling.sessions.filter((s) => s !== cyclingAnchor && s.sport !== "strength")) {
    assert.ok(cyclingAnchor.durationMinutes > other.durationMinutes);
  }
});

test("a dead goal changes neither the occurrence count nor the split", () => {
  // The Phase 3 archetype, re-pinned one layer down: a past goal's three bike
  // demands must not add a ride or re-split the ones that exist.
  const live = goal({ id: "tri", discipline: "triathlon" });
  const dead = goal({ id: "old", discipline: "cycling", targetDate: "2020-01-01" });
  assert.deepEqual(prescribe([live, dead], DEFAULT_ATHLETE, 6), prescribe([live], DEFAULT_ATHLETE, 6));
});

test("a session serving two goals is split the same as one serving one", () => {
  const tri = goal({ id: "tri", discipline: "triathlon", label: "Ironman 70.3", priority: 1 });
  const cyc = goal({ id: "cyc", discipline: "cycling", label: "Gran fondo", priority: 2 });
  const merged = prescribe([tri, cyc], DEFAULT_ATHLETE, 6);
  const rides = merged.sessions.filter((s) => s.kind === "bike_endurance");
  assert.ok(rides.every((s) => s.servesGoalIds.length === 2), "both goals want rides; they should share them");
  assert.deepEqual(
    rides.map((s) => s.durationMinutes).sort((a, b) => b - a),
    prescribe([tri], DEFAULT_ATHLETE, 6).sessions.filter((s) => s.kind === "bike_endurance").map((s) => s.durationMinutes).sort((a, b) => b - a),
    "who a session serves must not change how long it is",
  );
});

test("every kind that decays is a kind some goal can actually ask for twice", () => {
  /*
   * The Phase 8 catalog-integrity archetype, applied to this table. A share
   * entry for a kind no quality list contains twice — `run_long`, say, which
   * appears once everywhere and merges across goals — is capability nothing
   * can request: it would read as built, be tested in isolation, and never
   * run. Adding one fails here.
   */
  const disciplines: Array<Discipline | undefined> = [undefined, ...DISCIPLINES];
  for (const kind of Object.keys(OCCURRENCE_SHARES) as SessionKind[]) {
    const reachable = (Object.keys(GOAL_QUALITIES) as GoalType[]).some((type) =>
      disciplines.some((discipline) => qualitiesFor(type, discipline).filter((k) => k === kind).length >= 2),
    );
    assert.ok(reachable, `${kind} decays across occurrences, but no goal can ever ask for two of them`);
  }
});

test("prescribing a week never writes to the athlete's measured values", () => {
  const athlete = structuredClone(DEFAULT_ATHLETE);
  const before = structuredClone(DEFAULT_ATHLETE);
  prescribe([goal({ discipline: "triathlon" })], athlete, 6);
  assert.deepEqual(athlete, before, "the allocator reads Measured values; it must never mutate one");
});
