import { test } from "node:test";
import assert from "node:assert/strict";
import { NEUTRAL_SCORES, shownScores, submittedScores } from "./CheckInStrip";

/*
 * Defect: the check-in draft never synced from the loaded check-in, so
 * re-answering ONE question silently rewrote the other two as 3.
 *
 * Why the existing suite missed it entirely: there are no client tests, and
 * the server's own `upsertCheckIn` tests all pass three real scores — they
 * pin that the server stores what it is given, which is exactly the
 * behaviour that makes a fabricated neutral triple destructive rather than
 * harmless. The bug lives in WHICH triple the client sends.
 */

/** A real 07:00 check-in: slept well, not sore, energetic. */
const morning = { date: "2026-09-20", sleepQuality: 5, soreness: 1, energy: 5 };

test("defect: the chips read the STORED morning, not a seed frozen before the week loaded", () => {
  // Plan.tsx mounts the strip while /api/plan/week is still in flight, so
  // this is the state the component is first constructed in. Pre-fix a
  // `useState` initializer ran here and froze {3,3,3} for the page's life.
  assert.deepEqual(shownScores(null, null), NEUTRAL_SCORES);

  // The week resolves. Post-fix this is re-derived from the prop on render;
  // pre-fix nothing re-read it — no effect, no key, no other writer.
  assert.deepEqual(shownScores(null, morning), { sleepQuality: 5, soreness: 1, energy: 5 });
});

test("defect: tapping soreness at 18:00 keeps the morning's sleep and energy", () => {
  // The whole triple goes out on every POST (upsertCheckIn overwrites all
  // three by design), so the two untouched fields have to be the stored ones.
  assert.deepEqual(submittedScores(null, morning, { soreness: 4 }), {
    sleepQuality: 5,
    soreness: 4,
    energy: 5,
  });
});

test("defect: 'train as prescribed anyway' asserts no scores of its own", () => {
  // The worst case of the same bug: the override rewrote the terrible
  // morning that was the reason for overriding, destroying the record of why.
  assert.deepEqual(submittedScores(null, morning, {}), { sleepQuality: 5, soreness: 1, energy: 5 });
});

test("boundary, the other side: with nothing stored, the neutral placeholder is what fills the unanswered two", () => {
  // Not a regression — the server requires all three and a first check-in
  // genuinely has no prior answers. The defect is sending these INSTEAD of a
  // stored morning, never sending them when there is no morning.
  assert.deepEqual(submittedScores(null, null, { sleepQuality: 5 }), { sleepQuality: 5, soreness: 3, energy: 3 });
});

test("boundary: a tap the week query has not caught up with still wins over the stale prop", () => {
  // Taps arrive faster than ["week"] refetches. The athlete's own newest
  // answer is the base for the next one — otherwise fixing the fix reverts it.
  const justTapped = { sleepQuality: 5, soreness: 4, energy: 5 };
  assert.deepEqual(submittedScores(justTapped, morning, { energy: 2 }), {
    sleepQuality: 5,
    soreness: 4,
    energy: 2,
  });
});
