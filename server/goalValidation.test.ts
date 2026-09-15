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
