import { test } from "node:test";
import assert from "node:assert/strict";
import type { Goal, GoalType, Discipline } from "../goal";
import { type BlockPreferences, DEFAULT_CONNECTOR_PREFERENCES, DEFAULT_FEATURE_PREFERENCES } from "../preferences";
import { assembleApp, STATED_PREFERENCE } from "./assemble";
import { BLOCKS, CAPABILITY_LABELS, CAPABILITY_NEEDS, DISCIPLINE_NEEDS, FEATURE_NEEDS, type Capability } from "./blocks";

const TODAY = "2026-09-16";

function goal(type: GoalType, label: string, opts: { discipline?: Discipline; targetDate?: string; active?: boolean } = {}): Goal {
  return {
    id: `${type}-${label}`,
    type,
    discipline: opts.discipline ?? (type === "endurance_race" ? "run" : "other"),
    label,
    targetDate: opts.targetDate ?? "2027-06-01",
    priority: 1,
    successCriteria: "",
    targetMetrics: {},
    constraints: [],
    createdAt: TODAY,
    active: opts.active ?? true,
  };
}

function assemble(goals: Goal[], features = DEFAULT_FEATURE_PREFERENCES, blocks: BlockPreferences = {}) {
  return assembleApp(goals, DEFAULT_CONNECTOR_PREFERENCES, features, TODAY, blocks);
}

function blockIds(app: ReturnType<typeof assemble>, surface: string): string[] {
  return app.surfaces.find((s) => s.id === surface)!.blocks.map((b) => b.id);
}

test("a marathoner is not shown bike and swim numbers", () => {
  const app = assemble([goal("endurance_race", "Berlin Marathon", { discipline: "run" })]);
  assert.ok(blockIds(app, "athlete").includes("athlete.running"));
  assert.ok(!blockIds(app, "athlete").includes("athlete.bikeSwim"), "a run-only goal has no use for CdA or critical swim speed");
});

test("a triathlete IS shown bike and swim numbers, off the same goal type", () => {
  const app = assemble([goal("endurance_race", "Ironman 70.3", { discipline: "triathlon" })]);
  assert.ok(blockIds(app, "athlete").includes("athlete.bikeSwim"));
  assert.ok(app.capabilities.includes("swim_bike_prescription"));
});

test("a body-composition athlete sees no running, heart-rate or station panels", () => {
  const app = assemble([goal("body_composition", "Wedding")]);
  const athlete = blockIds(app, "athlete");
  assert.deepEqual(athlete.filter((id) => id.startsWith("athlete.")).sort(), ["athlete.body", "athlete.strength"]);
});

test("blocks are ordered by rank within a surface, not by catalog order", () => {
  const app = assemble([goal("hyrox", "HYROX Manchester")]);
  const athlete = blockIds(app, "athlete");
  // athlete.stations sits at rank 25 but is `planned`, so it does not render.
  assert.deepEqual(athlete, ["athlete.running", "athlete.heartRate", "athlete.strength", "athlete.body"]);
});

test("engine blocks provide capabilities but never render", () => {
  const app = assemble([goal("general_fitness", "Get fitter")]);
  assert.ok(app.capabilities.includes("session_prescription"), "the engine prescribes for every athlete");
  for (const surface of app.surfaces) {
    for (const block of surface.blocks) {
      assert.ok(!block.id.startsWith("engine."), `${block.id} is an engine block and must not render`);
    }
  }
});

test("an athlete with no goals still gets the surfaces needed to create one", () => {
  const app = assemble([]);
  const ids = app.surfaces.map((s) => s.id);
  assert.ok(ids.includes("goals") && ids.includes("coach"), "assembling these away would trap a new athlete with no way to add a goal");
  assert.equal(app.basis.activeGoalCount, 0);
  assert.ok(!blockIds(app, "athlete").includes("athlete.bikeSwim"), "a brand-new athlete should not face triathlon fields they never asked for");
});

test("a past goal stops driving assembly", () => {
  const app = assemble([goal("endurance_race", "Last year's race", { discipline: "triathlon", targetDate: "2025-06-01" })]);
  assert.equal(app.basis.activeGoalCount, 0);
  assert.ok(!blockIds(app, "athlete").includes("athlete.bikeSwim"), "a finished triathlon must not keep shaping the app — the same class of bug as the Phase 3 past-goal arbitration one");
});

test("an inactive goal stops driving assembly", () => {
  const app = assemble([goal("hyrox", "Abandoned", { active: false })]);
  assert.ok(!blockIds(app, "athlete").includes("athlete.stations"));
});

test("two goals compose — the athlete gets the union, not the winner", () => {
  const app = assemble([
    goal("endurance_race", "Ironman 70.3", { discipline: "triathlon" }),
    goal("body_composition", "Wedding"),
  ]);
  const athlete = blockIds(app, "athlete");
  assert.ok(athlete.includes("athlete.bikeSwim"), "the triathlon still shapes the app");
  assert.ok(athlete.includes("athlete.strength"), "and so does the body-composition goal");
  assert.deepEqual(app.basis.goalTypes, ["body_composition", "endurance_race"]);
});

// ─── Gaps ────────────────────────────────────────────────────────────────────

test("a gap names the goal that wanted it, not just the missing feature", () => {
  const app = assemble([goal("endurance_race", "Berlin Marathon")]);
  const pacing = app.gaps.find((g) => g.capability === "race_day_pacing");
  assert.ok(pacing, "nothing builds a race-day pacing plan yet, so an endurance goal must report it");
  assert.deepEqual(pacing.wantedBy, ["Berlin Marathon"]);
  assert.equal(pacing.plannedBlockId, "plan.pacing", "a named-but-unbuilt block is a richer answer than silence");
});

test("a HYROX athlete is told station benchmarks aren't built rather than silently missing them", () => {
  const app = assemble([goal("hyrox", "HYROX Manchester")]);
  const gap = app.gaps.find((g) => g.capability === "station_benchmarks");
  assert.ok(gap, "the engine can use station times but nothing lets the athlete enter them — say so");
  assert.equal(gap.plannedBlockId, "athlete.stations");
});

test("a planned block is declared, reported as a gap, and never rendered", () => {
  const app = assemble([goal("body_composition", "Wedding")], { physiqueTracking: true });
  assert.ok(!blockIds(app, "athlete").includes("athlete.physique"), "planned blocks must not render");
  const gap = app.gaps.find((g) => g.capability === "physique_tracking");
  assert.ok(gap, "the preference is a stated need and the app owes an honest answer");
  assert.deepEqual(gap.wantedBy, [STATED_PREFERENCE]);
});

test("a preference left off produces no gap", () => {
  // The inverse of the bug this catalog exists to catch: silence is only
  // correct when nothing was ever asked for.
  const app = assemble([goal("body_composition", "Wedding")], { physiqueTracking: false });
  assert.ok(!app.gaps.some((g) => g.capability === "physique_tracking"));
});

test("a triathlon goal reports no swim/bike gap now that the prescriber is discipline-aware", () => {
  const app = assemble([goal("endurance_race", "Ironman 70.3", { discipline: "triathlon" })]);
  assert.ok(!app.gaps.some((g) => g.capability === "swim_bike_prescription"));
});

test("a standalone cycling race reports the missing predictor rather than quoting a running one", () => {
  const app = assemble([goal("endurance_race", "Alpine gran fondo", { discipline: "cycling" })]);
  const gap = app.gaps.find((g) => g.capability === "race_time_prediction");
  assert.ok(gap, "predictRunRace and predictTriathlon do not cover a standalone bike race; saying so beats predicting one badly");
});

test("gaps are ordered by how many goals want them", () => {
  const app = assemble([
    goal("endurance_race", "Berlin Marathon"),
    goal("hyrox", "HYROX Manchester"),
  ]);
  const pacing = app.gaps.find((g) => g.capability === "race_day_pacing");
  assert.equal(pacing?.wantedBy.length, 2, "both goals want a pacing plan");
  assert.equal(app.gaps[0]?.capability, "race_day_pacing", "the most-wanted gap sorts first — that's the build queue");
});

// ─── Catalog integrity ───────────────────────────────────────────────────────

test("every capability has a plain-language label", () => {
  const declared = new Set<Capability>();
  for (const block of BLOCKS) for (const capability of block.provides) declared.add(capability);
  for (const capability of declared) {
    assert.ok(CAPABILITY_LABELS[capability], `${capability} has no athlete-facing label`);
  }
});

test("block ids are unique", () => {
  const ids = BLOCKS.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every block is reachable — nothing serves a goal type that never asks for it", () => {
  // The bug this pins, generalized: prescribe.ts had complete swim and bike
  // sessions that no goal could request, so they were dead code that looked
  // like a feature. A block whose capabilities nobody needs is the same thing.
  for (const block of BLOCKS) {
    if (block.provides.length === 0) continue;
    // A universal block is reachable by construction — calibration and
    // adherence are infrastructure every athlete gets, not something a goal
    // asks for. The risk this catches is a TARGETED block: one that names the
    // goal types it serves, none of which ever request what it provides.
    if (block.goalTypes === "*") continue;
    const types = block.goalTypes;
    const wanted = types.some((type) =>
      block.provides.some(
        (capability) =>
          CAPABILITY_NEEDS[type].includes(capability) ||
          Object.values(DISCIPLINE_NEEDS).some((needs) => needs?.includes(capability)) ||
          Object.values(FEATURE_NEEDS).some((needs) => needs?.includes(capability)),
      ),
    );
    assert.ok(wanted, `${block.id} provides ${block.provides.join(", ")} but no goal type it serves ever asks for it`);
  }
});

test("assembly is deterministic — the same goal model always produces the same app", () => {
  const goals = [goal("endurance_race", "Ironman 70.3", { discipline: "triathlon" }), goal("body_composition", "Wedding")];
  assert.deepEqual(assemble(goals), assemble([...goals].reverse()), "goal order must not change the app");
});


// ─── Athlete overrides ───────────────────────────────────────────────────────

test("an athlete can switch ON a block their goals don't imply", () => {
  // A marathoner who also rides. Inference gets the default right most of the
  // time; "most of the time" can't be the only mechanism.
  const goals = [goal("endurance_race", "Berlin Marathon", { discipline: "run" })];
  assert.ok(!blockIds(assemble(goals), "athlete").includes("athlete.bikeSwim"));
  assert.ok(blockIds(assemble(goals, DEFAULT_FEATURE_PREFERENCES, { "athlete.bikeSwim": "on" }), "athlete").includes("athlete.bikeSwim"));
});

test("an athlete can switch OFF a block their goals do imply", () => {
  const goals = [goal("endurance_race", "Ironman 70.3", { discipline: "triathlon" })];
  assert.ok(blockIds(assemble(goals), "athlete").includes("athlete.bikeSwim"));
  assert.ok(!blockIds(assemble(goals, DEFAULT_FEATURE_PREFERENCES, { "athlete.bikeSwim": "off" }), "athlete").includes("athlete.bikeSwim"));
});

test("switching a block off also silences its gap", () => {
  // Someone doing a cut who finds progress photos miserable should not keep
  // being told that the thing they declined isn't built yet. That's nagging,
  // not honesty.
  const goals = [goal("body_composition", "Wedding")];
  const on = assemble(goals, { physiqueTracking: true });
  assert.ok(on.gaps.some((g) => g.capability === "physique_tracking"));

  const off = assemble(goals, { physiqueTracking: true }, { "athlete.physique": "off" });
  assert.ok(!off.gaps.some((g) => g.capability === "physique_tracking"));
});

test("clearing an override hands the decision back to the assembler", () => {
  const goals = [goal("endurance_race", "Ironman 70.3", { discipline: "triathlon" })];
  const withOverride = assemble(goals, DEFAULT_FEATURE_PREFERENCES, { "athlete.bikeSwim": "off" });
  const cleared = assemble(goals, DEFAULT_FEATURE_PREFERENCES, {});
  assert.ok(!blockIds(withOverride, "athlete").includes("athlete.bikeSwim"));
  assert.ok(blockIds(cleared, "athlete").includes("athlete.bikeSwim"), "'let the app decide' has to stay reachable after an override");
});

test("an override cannot conjure a block that isn't built", () => {
  const goals = [goal("body_composition", "Wedding")];
  const app = assemble(goals, DEFAULT_FEATURE_PREFERENCES, { "athlete.physique": "on" });
  assert.ok(!blockIds(app, "athlete").includes("athlete.physique"), "wanting it does not implement it");
  assert.ok(app.gaps.some((g) => g.capability === "physique_tracking"), "and asking for it explicitly is exactly when the gap should be reported");
});

// ─── Surfaces collapse ───────────────────────────────────────────────────────

test("a surface with nothing on it disappears", () => {
  const goals = [goal("body_composition", "Wedding")];
  const stripped = assemble(goals, DEFAULT_FEATURE_PREFERENCES, {
    "data.load": "off",
    "data.sessions": "off",
    "data.calibration": "off",
  });
  assert.ok(!stripped.surfaces.some((s) => s.id === "data"), "five tabs is a default, not a fixed shape");
});

test("the surfaces you need to change your own mind never disappear", () => {
  const goals = [goal("body_composition", "Wedding")];
  const stripped = assemble(goals, DEFAULT_FEATURE_PREFERENCES, Object.fromEntries(BLOCKS.map((b) => [b.id, "off" as const])));
  const ids = stripped.surfaces.map((s) => s.id);
  assert.ok(ids.includes("goals") && ids.includes("coach") && ids.includes("plan"),
    "an athlete who switched everything off must still be able to switch something back on");
});
