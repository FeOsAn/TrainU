import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidGoalError, validateGoalInput, type CreateGoalInput } from "./goalValidation";

function input(over: Partial<CreateGoalInput> = {}): CreateGoalInput {
  return { type: "endurance_race", label: "Marathon", targetDate: "2027-01-01", successCriteria: "sub-4", ...over };
}

test("a well-formed goal passes validation", () => {
  assert.doesNotThrow(() => validateGoalInput(input()));
});

test("rejects a type the LLM might hallucinate that isn't in the real GoalType union", () => {
  assert.throws(() => validateGoalInput(input({ type: "triathlon" as any })), InvalidGoalError);
});

test("rejects a missing or blank label", () => {
  assert.throws(() => validateGoalInput(input({ label: "" })), InvalidGoalError);
  assert.throws(() => validateGoalInput(input({ label: "   " })), InvalidGoalError);
});

test("rejects a malformed or nonsensical target date", () => {
  assert.throws(() => validateGoalInput(input({ targetDate: "not a date" })), InvalidGoalError);
  assert.throws(() => validateGoalInput(input({ targetDate: "01/01/2027" })), InvalidGoalError, "must be YYYY-MM-DD, not any parseable format");
  assert.throws(() => validateGoalInput(input({ targetDate: "2027-13-40" })), InvalidGoalError);
});

test("rejects a blank successCriteria", () => {
  assert.throws(() => validateGoalInput(input({ successCriteria: "" })), InvalidGoalError);
});

test("rejects a non-positive priority", () => {
  assert.throws(() => validateGoalInput(input({ priority: 0 })), InvalidGoalError);
  assert.throws(() => validateGoalInput(input({ priority: -1 })), InvalidGoalError);
  assert.throws(() => validateGoalInput(input({ priority: NaN })), InvalidGoalError);
});

test("priority is optional — omitting it is valid", () => {
  assert.doesNotThrow(() => validateGoalInput(input({ priority: undefined })));
});

test("DEFECT: a placeholder or typo'd far-future date is rejected, not planned toward", () => {
  const base = { type: "endurance_race" as const, label: "Race", successCriteria: "Finish" };
  // Each of these used to be accepted, and 9999-12-31 ran the server out of memory.
  for (const targetDate of ["9999-12-31", "2207-05-01", "2037-01-01"]) {
    assert.throws(() => validateGoalInput({ ...base, targetDate }, "2026-09-25"), InvalidGoalError, targetDate);
  }
  assert.doesNotThrow(() => validateGoalInput({ ...base, targetDate: "2036-09-20" }, "2026-09-25"), "ten years out is a real plan");
  assert.doesNotThrow(() => validateGoalInput({ ...base, targetDate: "2026-03-01" }, "2026-09-25"), "a goal that just finished can still be logged");
  assert.throws(() => validateGoalInput({ ...base, targetDate: "2024-01-01" }, "2026-09-25"), InvalidGoalError);
});

test("DEFECT: a rolled-over date like 2026-02-30 is rejected, not silently read as 2 March", () => {
  assert.throws(
    () => validateGoalInput({ type: "strength", label: "x", successCriteria: "y", targetDate: "2027-02-30" }, "2026-09-25"),
    InvalidGoalError,
  );
});
