/**
 * "What if I moved the race?" — the read-only half of the goal model.
 *
 * Everything that decides anything lives in `shared/arbitration/whatIf.ts`,
 * which produces both plans by calling `arbitratePlan` twice and nothing
 * else. This file is the database half: read the goals, the athlete and the
 * open conditions, and hand them over.
 *
 * Two rules, and they are the whole point of the file:
 *
 *  1. It PERSISTS NOTHING. No goal is touched, and — unlike every other
 *     planning endpoint — no `outcome_log` row is written. A hypothetical is
 *     not a prediction: logging one would put a row in the calibration
 *     dataset that can never resolve, quietly poisoning the Phase 6 numbers
 *     with plans nobody ever trained.
 *  2. The patched goal is validated by the SAME `validateGoalInput` a real
 *     goal goes through. A hypothetical that could not be saved should not be
 *     modelled either — otherwise the app answers a question about a goal it
 *     would have refused to create.
 */

import { startOfWeek, todayISO } from "@shared/dates";
import { type GoalPatch, WHAT_IF_OPS, WhatIfPatchError, applyGoalPatch, whatIf, type WhatIfResult } from "@shared/arbitration/whatIf";
import { validateGoalInput } from "./goalValidation";
import { listGoals } from "./goalsService";
import { getAthleteParams, plannableConditions } from "./athleteStateService";

export { WhatIfPatchError };

function asPatch(value: unknown): GoalPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WhatIfPatchError("Send one change to try, as an object.");
  }
  const op = (value as { op?: unknown }).op;
  if (typeof op !== "string" || !(WHAT_IF_OPS as readonly string[]).includes(op)) {
    throw new WhatIfPatchError("That is not a change this app can try out.");
  }
  return value as GoalPatch;
}

export interface RunWhatIfOptions {
  today?: string;
}

export function runWhatIf(body: unknown, options: RunWhatIfOptions = {}): WhatIfResult {
  const today = options.today ?? todayISO();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new WhatIfPatchError("Send a body with the change to try.");
  }
  const { patch: rawPatch, fromDate, toDate } = body as { patch?: unknown; fromDate?: unknown; toDate?: unknown };
  const patch = asPatch(rawPatch);

  if (fromDate !== undefined && typeof fromDate !== "string") throw new WhatIfPatchError("fromDate must be a date in YYYY-MM-DD form.");
  if (toDate !== undefined && typeof toDate !== "string") throw new WhatIfPatchError("toDate must be a date in YYYY-MM-DD form.");

  const goals = listGoals();

  // The same rules a real goal is held to. `applyGoalPatch` throws its own
  // WhatIfPatchError for an unknown goal or an out-of-range value; this
  // catches the case where a legal patch produces an illegal goal.
  for (const goal of applyGoalPatch(goals, patch)) {
    if (!goal.active) continue;
    validateGoalInput(goal);
  }

  /*
   * The same conditions the real plan is built from — including the staleness
   * rule. Reading the table directly let a suspended condition (28 days
   * untouched, changing no session, shown greyed out asking "is this still
   * true?") keep steering every week of a what-if, so the answer to "what if I
   * moved my race?" disagreed with the plan it was supposed to be predicting.
   * One definition of "open and still trusted", used everywhere.
   */
  const conditions = plannableConditions(today);

  return whatIf(
    goals,
    patch,
    {
      // Weeks must line up with /api/plan/week or "the week of the 7th"
      // means two different weeks on two screens.
      fromDate: fromDate ?? startOfWeek(today),
      toDate,
      today,
    },
    getAthleteParams(),
    conditions,
  );
}
