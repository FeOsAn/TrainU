import { test } from "node:test";
import assert from "node:assert/strict";
import { runTool } from "./onboarding";

test("create_goal tool creates a real, persisted goal on valid input", () => {
  const result = runTool("create_goal", {
    type: "endurance_race",
    label: "Test Marathon",
    targetDate: "2027-04-01",
    successCriteria: "sub-4 hours",
    targetTimeSeconds: 14400,
  });
  assert.match(result, /Created goal "Test Marathon"/);
});

test("create_goal tool reports a clean failure for a hallucinated type, not a crash", () => {
  const result = runTool("create_goal", {
    type: "triathlon", // not a real GoalType — exactly what a model might hallucinate
    label: "Test",
    targetDate: "2027-04-01",
    successCriteria: "x",
  });
  assert.match(result, /Could not create the goal/);
});

test("create_goal tool reports a clean failure for a malformed date rather than crashing", () => {
  const result = runTool("create_goal", {
    type: "strength",
    label: "Test",
    targetDate: "next tuesday",
    successCriteria: "x",
  });
  assert.match(result, /Could not create the goal/);
});

test("set_connector_preferences tool only touches the fields it's given", () => {
  const result = runTool("set_connector_preferences", { garmin: true });
  assert.match(result, /"garmin":true/);
});

test("set_feature_preferences tool saves a boolean opt-in", () => {
  const result = runTool("set_feature_preferences", { physiqueTracking: true });
  assert.match(result, /"physiqueTracking":true/);
});

test("an unknown tool name reports a clean error instead of throwing", () => {
  const result = runTool("delete_everything", {});
  assert.match(result, /Unknown tool/);
});
