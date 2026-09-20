import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Vite compiles these pages with the automatic JSX runtime; tsx uses the
// classic one, which wants `React` in scope. Hence the global + dynamic import.
(globalThis as unknown as { React: typeof React }).React = React;
// The empty state renders a wouter <Link>, which reads location.pathname.
// `history` is deliberately left undefined: wouter only patches it when a
// window exists, and there is none here.
Object.assign(globalThis, { location: { pathname: "/", search: "", hash: "" } });
const { default: Plan } = await import("./Plan");

/*
 * Defect: the "Why this week looks like this" panel fell back to
 * `phase.goalType` — the raw enum — whenever the goals query had not
 * resolved. `main.tsx` sets `retry: 1`, so a `/api/goals` that fails twice
 * leaves it unresolved for the rest of the page visit, and the athlete reads
 * `body_composition`, underscore and all, under their goal's name.
 * DECISIONS C7: no enum value reaches the athlete.
 *
 * The same root cause — `goals === undefined` read as `goals === []` — also
 * told an athlete with two live goals "No active goals yet" above a panel
 * describing their multi-goal week. Both are pinned here.
 *
 * Nothing caught it because there were no client tests at all, and the one
 * live browser pass Phase 10 records ("zero enum ids on screen") was run
 * with every query healthy — which is the only state in which the fallback
 * never renders.
 */

const WEEK = {
  weekStart: "2026-09-14",
  days: [],
  totalMinutes: 300,
  totalTss: 250,
  note: "A maintenance week.",
  phaseName: "base",
  original: { totalMinutes: 300 },
  adherence: { adherenceRate: null, completed: 0, skipped: 0, prescribed: 0, actualTss: null },
  adjustments: [],
  dropped: [],
  checkIn: null,
  readiness: null,
  arbitrated: {
    loadMultiplier: 0.83,
    nutritionStance: "deficit",
    conflicts: [],
    goalPhases: [
      {
        goalId: "g_cut",
        goalLabel: "Wedding",
        goalType: "body_composition",
        phaseName: "cut",
        notes: "Six weeks out — a steady deficit.",
        risk: null,
      },
    ],
  },
};

function render(goals: unknown[] | "unresolved") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["app-shell"], {
    surfaces: [{ id: "plan", title: "Plan", blocks: [{ id: "plan.arbitration", title: "Why" }] }],
    capabilities: [],
    gaps: [],
  });
  qc.setQueryData(["week"], WEEK);
  qc.setQueryData(["plan"], { conflicts: [], weeks: [] });
  if (goals !== "unresolved") qc.setQueryData(["goals"], goals);
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: qc }, React.createElement(Plan)),
  );
}

test("defect: an unresolved goals query must not print the goal-type enum (C7)", () => {
  const html = render("unresolved");
  assert.ok(!html.includes("body_composition"), "an engine id reached the athlete");
  assert.ok(html.includes("Body composition"), "the label table is what belongs there");
});

test("defect: an unresolved goals query is not an athlete with no goals", () => {
  const html = render("unresolved");
  assert.ok(
    !html.includes("No active goals yet"),
    "told an athlete with live goals they had none, directly above a panel describing them",
  );
});

test("boundary: goals resolved EMPTY still says so", () => {
  // The empty state is right, and the fix must not hide it — it is the only
  // route a new athlete has to their first goal.
  assert.ok(render([]).includes("No active goals yet"));
});

test("boundary: goals resolved — the subtitle is the real one, not the fallback", () => {
  const html = render([
    {
      id: "g_cut",
      type: "body_composition",
      discipline: "other",
      label: "Wedding",
      targetDate: "2026-11-01",
      priority: 1,
      successCriteria: "78 kg",
      targetMetrics: {},
      active: true,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ]);
  assert.ok(html.includes("priority 1"), "the goal was found, so the fallback is not in play");
  assert.ok(!html.includes("body_composition"));
});
