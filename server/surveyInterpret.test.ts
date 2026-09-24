import { test } from "node:test";
import assert from "node:assert/strict";
import { draftFromModelJson, interpretNarrative } from "./surveyInterpret";

const TODAY = "2026-09-24";

/*
 * There is no ANTHROPIC_API_KEY in this environment, so the network call
 * itself is unverified — see CLAUDE.md. What IS tested is the part that
 * matters most: the clamp between whatever the model returns and what the
 * athlete is shown. Every test below is a model output that must not reach
 * the form intact.
 */

test("a well-formed reply fills the draft and says what it filled", () => {
  const { draft, filled } = draftFromModelJson(
    JSON.stringify({
      name: "Sam",
      ageYears: 29,
      trainingDaysPerWeek: 6,
      hasBike: true,
      goals: [{ type: "hyrox", label: "HYROX London", targetDate: "2026-11-14", successCriteria: "Sub 70", targetMetrics: { targetTimeSeconds: 4200 } }],
    }),
    TODAY,
  );
  assert.equal(draft.name, "Sam");
  assert.equal(draft.ageYears, 29);
  assert.equal(draft.trainingDaysPerWeek, 6);
  assert.equal(draft.goals?.length, 1);
  assert.equal(draft.goals?.[0]?.discipline, "other", "a HYROX goal gets its type's default discipline");
  assert.ok(filled.some((f) => /HYROX London/.test(f)));
});

test("a number the model misheard never reaches the form", () => {
  // "I'm 34" heard as 340. A wrong number someone taps past is worse than a
  // blank one, because the app then treats it as something they confirmed.
  const { draft } = draftFromModelJson(JSON.stringify({ ageYears: 340, weightKg: 7.8, heightCm: 181 }), TODAY);
  assert.equal(draft.ageYears, undefined);
  assert.equal(draft.weightKg, undefined);
  assert.equal(draft.heightCm, 181);
});

test("a hallucinated goal type is dropped rather than shown", () => {
  const { draft } = draftFromModelJson(
    JSON.stringify({ goals: [{ type: "powerlifting", label: "Meet", targetDate: "2027-01-01" }] }),
    TODAY,
  );
  assert.equal(draft.goals, undefined);
});

test("a goal dated in the past is dropped — the survey refuses it anyway", () => {
  const { draft } = draftFromModelJson(
    JSON.stringify({ goals: [{ type: "hyrox", label: "Last year's race", targetDate: "2025-11-14" }] }),
    TODAY,
  );
  assert.equal(draft.goals, undefined);
});

test("a goal with no date or no name is dropped, not half-filled", () => {
  const { draft } = draftFromModelJson(
    JSON.stringify({
      goals: [
        { type: "hyrox", label: "Nameless", targetDate: "not a date" },
        { type: "hyrox", label: "   ", targetDate: "2026-11-14" },
        { type: "hyrox", label: "Good one", targetDate: "2026-11-14" },
      ],
    }),
    TODAY,
  );
  assert.deepEqual(draft.goals?.map((g) => g.label), ["Good one"]);
});

test("training days are clamped into the range the prescriber can honour", () => {
  assert.equal(draftFromModelJson(JSON.stringify({ trainingDaysPerWeek: 9 }), TODAY).draft.trainingDaysPerWeek, 7);
  assert.equal(draftFromModelJson(JSON.stringify({ trainingDaysPerWeek: 1 }), TODAY).draft.trainingDaysPerWeek, 3);
});

test("a fenced or chatty reply still parses", () => {
  const { draft } = draftFromModelJson('```json\n{"name":"Alex"}\n```', TODAY);
  assert.equal(draft.name, "Alex");
});

test("unparseable output fills nothing and throws nothing", () => {
  for (const junk of ["", "I'm sorry, I can't do that.", "{ not json", "[]", "null"]) {
    const { draft, filled } = draftFromModelJson(junk, TODAY);
    assert.deepEqual(draft, {}, `"${junk}" should fill nothing`);
    assert.deepEqual(filled, []);
  }
});

test("more than six goals is truncated rather than accepted", () => {
  const goals = Array.from({ length: 9 }, (_, i) => ({ type: "hyrox", label: `Race ${i}`, targetDate: "2026-11-14" }));
  assert.equal(draftFromModelJson(JSON.stringify({ goals }), TODAY).draft.goals?.length, 6);
});

test("with no API key it reports itself unavailable instead of failing the survey", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await interpretNarrative("I have a marathon in April.", TODAY);
    assert.equal(result.available, false);
    assert.deepEqual(result.draft, {});
    assert.match(result.message ?? "", /ANTHROPIC_API_KEY/);
    assert.match(result.message ?? "", /yourself/i, "and it says what to do instead");
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("an empty narrative never reaches the model", async () => {
  const result = await interpretNarrative("   ", TODAY);
  assert.deepEqual(result.draft, {});
  assert.match(result.message ?? "", /nothing to read/i);
});
