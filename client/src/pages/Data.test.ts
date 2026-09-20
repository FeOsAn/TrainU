import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/*
 * These pages are compiled by Vite with the automatic JSX runtime; run
 * through tsx they get the classic one, which expects `React` in scope.
 * Hence the global and the dynamic import — nothing about the component.
 */
(globalThis as unknown as { React: typeof React }).React = React;
const { default: Data } = await import("./Data");

/*
 * Defect: the Data page ignored the assembled shell entirely, so switching
 * `data.load`, `data.sessions` or `data.calibration` off in "Your app" did
 * nothing to the page — the Your app screen reported a setting with no
 * effect, and Phase 9's "off means off" promise was false here.
 *
 * Why the existing suite missed it: `shared/appShell/assemble.test.ts`
 * switches ALL THREE off and asserts the surface (and so the nav tab)
 * disappears — the single case that happened to work. It asserts nothing
 * about the page body, and one block off is the case that breaks. Both
 * sides of that boundary are pinned below.
 */

function shellWith(blocks: string[]) {
  return {
    surfaces: [{ id: "data", title: "Data", blocks: blocks.map((id) => ({ id, title: id })) }],
    capabilities: [],
    gaps: [],
  };
}

function render(blocks: string[] | "loading") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (blocks !== "loading") qc.setQueryData(["app-shell"], shellWith(blocks));
  qc.setQueryData(["training-load"], {
    tsbStatus: "neutral", tsbStatusLabel: "Rested enough", currentCtl: 40, currentAtl: 38,
    currentTsb: 2, weeklyTss: 300, monthlyTss: 1200, acwr: 1.05,
  });
  qc.setQueryData(["calibration"], { note: "Not enough resolved predictions yet.", sampleSize: 0, brierScore: null, recommendedMultiplier: 1, buckets: [] });
  qc.setQueryData(["sessions"], []);
  qc.setQueryData(["preferences"], { connectors: { garmin: false, whoop: false, appleHealth: false }, features: {} });
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: qc }, React.createElement(Data)),
  );
}

const ALL = ["data.load", "data.sessions", "data.calibration"];

test("defect: switching ONE Data block off removes that panel from the page", () => {
  const withCalibration = render(ALL);
  assert.ok(withCalibration.includes("Calibration"), "sanity: on by default");

  const without = render(["data.load", "data.sessions"]);
  assert.ok(!without.includes("Calibration"), "the athlete switched the Brier-score panel off; it has to go");
  // …and only that one.
  assert.ok(without.includes("Training load"));
  assert.ok(without.includes("Recent sessions"));
});

test("defect: the same holds for training load and for recent sessions", () => {
  const noLoad = render(["data.sessions", "data.calibration"]);
  assert.ok(!noLoad.includes("Training load"));
  assert.ok(noLoad.includes("Recent sessions"));

  const noSessions = render(["data.load", "data.calibration"]);
  assert.ok(!noSessions.includes("Recent sessions"));
  assert.ok(noSessions.includes("Training load"));
});

test("boundary: Connectors is not a block and never disappears", () => {
  // It has no entry in the catalog, so it is offered nowhere in "Your app" —
  // and it is what keeps /data from being a blank screen once the tab has
  // collapsed but the route is still registered.
  assert.ok(render([]).includes("Connectors"));
});

test("boundary: while the shell is still loading, everything renders", () => {
  // A page that flashes empty on every load is worse than one that briefly
  // shows a panel the athlete is about to lose — same rule as Plan.tsx.
  const html = render("loading");
  for (const panel of ["Training load", "Connectors", "Calibration", "Recent sessions"]) {
    assert.ok(html.includes(panel), panel);
  }
});
