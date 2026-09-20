import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { weightChangeWarning, type PhysiqueEntry } from "@shared/physique";
import { entryBefore, savedNotice } from "./PhysiquePanel";

// Vite compiles this with the automatic JSX runtime; tsx uses the classic
// one, which wants `React` in scope.
(globalThis as unknown as { React: typeof React }).React = React;
const { PhysiquePanel } = await import("./PhysiquePanel");

/*
 * Defect: the weight-change confirmation compared against `entries.at(-1)` —
 * the newest weigh-in in the whole history — while the date field is free
 * and the panel advertises back-dating. The server's own
 * `physiqueSaveWarning` compares against the entry immediately BEFORE the
 * submitted date, and its answer was being discarded.
 *
 * Why nothing caught it: `server/physiqueService.test.ts` pins the SERVER's
 * baseline (including the same-date exclusion) — which is exactly what makes
 * the client's divergence provable, and exactly why a server-side suite
 * could not see it. There were no client tests.
 */

function entry(date: string, weightKg: number): PhysiqueEntry {
  return { id: date, date, weightKg, bodyFatPercent: null, waistCm: null, note: null, createdAt: `${date}T06:00:00.000Z` } as PhysiqueEntry;
}

// Oldest-first, as `listPhysiqueEntries` returns them: a cut from 82 to 78.
const history = [entry("2026-01-01", 82.0), entry("2026-03-01", 78.0)];

test("defect: back-dating an ordinary January weigh-in does not accuse a cutting athlete of gaining 3.9 kg", () => {
  const baseline = entryBefore(history, "2026-01-02");
  assert.equal(baseline?.date, "2026-01-01");
  assert.equal(weightChangeWarning(81.9, baseline), null);
  // Pre-fix the baseline was March's 78.0 kg, and this read
  // "That is 3.9 kg up from 78 kg on 2026-03-01. Save it anyway?"
});

test("defect: back-dating a typo IS caught — the mirror case, which silently saved before", () => {
  const baseline = entryBefore(history, "2026-01-02");
  const warning = weightChangeWarning(77.5, baseline); // 82.5 was meant
  assert.ok(warning?.includes("4.5 kg down from 82 kg on 2026-01-01"), warning ?? "no warning at all");
  // Pre-fix: compared against 78.0, delta 0.5, no question asked — and the
  // bad number then folds into getAthleteParams() and sizes the deficit.
});

test("boundary: correcting a day is judged against the day BEFORE it, not the value being replaced", () => {
  // The server excludes the same date explicitly; so does this.
  assert.equal(entryBefore(history, "2026-03-01")?.date, "2026-01-01");
});

test("boundary, the other side: a weigh-in logged TODAY still compares against the newest entry", () => {
  // The normal path is unchanged — this is not a fix that trades one wrong
  // baseline for another.
  assert.equal(entryBefore(history, "2026-04-01")?.date, "2026-03-01");
  assert.equal(entryBefore([], "2026-04-01"), null);
  assert.equal(entryBefore(history, "2025-12-31"), null, "nothing before the first entry");
});

test("defect: the server's warning is reworded for a row already committed, not dropped", () => {
  assert.equal(savedNotice(null), null);
  const notice = savedNotice("That is 4.5 kg down from 82 kg on 2026-01-01. Save it anyway?");
  assert.ok(notice?.startsWith("Saved."));
  assert.ok(!notice?.includes("Save it anyway?"), "it is already saved — that is not the question any more");
  assert.ok(notice?.includes("4.5 kg down from 82 kg on 2026-01-01"));
});

/*
 * Defect (archetype 2): `GET /api/physique/progress`, `progressVsGoal` and
 * `PhysiqueProgress` were all built and tested, and `api.physiqueProgress`
 * had exactly ONE occurrence in the client — its own declaration. The block
 * note promises "against what your goal actually needs"; that clause is the
 * part only this endpoint computes, and no screen asked for it.
 */

const CUT_GOAL = {
  id: "g_cut", type: "body_composition", discipline: "other", label: "Wedding",
  targetDate: "2026-11-15", priority: 1, successCriteria: "78 kg", targetMetrics: { targetWeightKg: 78 },
  active: true, createdAt: "2026-08-01T00:00:00.000Z",
};

const PROGRESS = {
  status: "behind",
  statusLabel: "Behind where this needs to be",
  observedWeeklyChangeKg: -0.32,
  requiredWeeklyChangeKg: -0.59,
  summary: "At 0.3 kg a week down you land on about 80.1 kg by 2026-11-15, 2.1 kg off the 78 kg Wedding asks for.",
};

function render(goals: unknown[], progress: unknown | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["physique"], { entries: history, trend: {} });
  qc.setQueryData(["goals"], goals);
  if (progress) qc.setQueryData(["physique", "progress", "g_cut"], progress);
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: qc }, React.createElement(PhysiquePanel)),
  );
}

test("defect: a body-composition goal's verdict is actually on the screen", () => {
  const html = render([CUT_GOAL], PROGRESS);
  assert.ok(html.includes("Behind where this needs to be"), "statusLabel, rendered as the module resolved it");
  assert.ok(html.includes("2.1 kg off the 78 kg"), "the summary sentence, with the target and the date in it");
  assert.ok(!html.includes("behind\""), "the status id itself never reaches the athlete (C7)");
});

test("boundary: physique tracking on with no body-composition goal renders trends and nothing more", () => {
  // The route 400s any other goal type and 404s an unknown id, so an
  // unfiltered loop would turn a HYROX athlete's page into error cards.
  const hyrox = { ...CUT_GOAL, id: "g_hyrox", type: "hyrox", label: "HYROX Manchester" };
  const html = render([hyrox], null);
  assert.ok(!html.includes("Behind where this needs to be"));
  assert.ok(!html.includes("HYROX Manchester"));
  assert.ok(html.includes("Log it"), "the panel itself still renders");
});

test("boundary: a goal that is over stops asking for a verdict", () => {
  const done = { ...CUT_GOAL, active: false };
  assert.ok(!render([done], PROGRESS).includes("Behind where this needs to be"));
});
