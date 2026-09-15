# TrainU

## What this is

Not "AI generates you a custom fitness app" — that's a front door, not a
product; it's a feature the model providers themselves will ship for free.
The actual product is a **goal-arbitration training engine**: an athlete
states one or more simultaneous goals (marathon in 9 months, wedding in 6
weeks, etc.), the app reconciles them into one coherent plan instead of
either ignoring the conflict or silently picking one, and it gets measurably
better over time because every prediction and plan decision is logged
against what actually happened.

Two sibling apps already exist and are the reference material for this one:
`FeOsAn/sub5-dashboard` (triathlon, sub-5 Ironman) and `FeOsAn/HyroxNga`
(HYROX doubles). Both are read-only from this session — nothing gets copied
in verbatim, patterns get adapted and generalized here. See Phase 2 below.

## The one hard rule: `shared/measured.ts`

Both sibling apps have the same bug in different places: a physiological
input (bike aero position in sub5-dashboard, `strengthEnduranceIndex` in
HyroxNga — the single highest-leverage HYROX parameter per that codebase's
own comments) silently defaults to a guess and gets fed into a prediction
with the exact same displayed confidence as a real measurement. sub5 patched
this once, narrowly, for FTP only (`ftpVerified`). HyroxNga's
`calibration.ts` has the right shape — provenance strings like "1 km time
trial, 12 Oct" vs "seed — not yet measured" — but only for running pace.

Here, every physiological/performance input is a `Measured<T>` from the
start (value + verified + source), and every predictor factors that into
the confidence it displays, via the shared `assessConfidence` /
`widenForConfidence` utilities — not a bolt-on per field, once, after it
causes a support conversation.

## Roadmap

- **Phase 0 (done)** — scaffold: Vite+React client, Express+TS server,
  Drizzle/better-sqlite3, matching the sibling apps' stack so ported code is
  an adaptation, not a rewrite. DB guard in `server/db.ts` (adapted from
  HyroxNga's) refuses to boot against a `sub5-dashboard` or `HyroxNga`
  database file.
- **Phase 1** — `Goal` object model (`shared/goal.ts`), `Measured<T>`
  (`shared/measured.ts`), outcome-log schema (`shared/schema.ts`:
  `outcomeLog`). A thin `/api/goals` CRUD slice exists so Phase 4 has
  something to write to.
- **Phase 2 (done)** — `shared/athlete.ts` (generalized `Measured<AthleteParams>`
  across all goal types), `shared/trainingLoad.ts` (CTL/ATL/TSB, sport-
  agnostic), `shared/calibration.ts` (provenance-tracked running calibration
  + a generic `calibrateBenchmark()` replacing what would've been one
  bespoke function per station/test), `shared/sessionDedupe.ts` (cross-
  source duplicate detection), `server/fitIngest.ts` (FIT upload), and four
  per-goal-type predictors under `shared/predictors/`: `enduranceRace.ts`
  (running + triathlon), `hyrox.ts`, `bodyComposition.ts`, `strength.ts` —
  every one reads `Measured<AthleteParams>` and widens its confidence band
  by how much of its input is still guessed, closing the CdA/SEI-shaped gap
  this whole rewrite started from. 54 tests, `tsc` clean.
  **Found and fixed a real bug during testing**: a malformed FIT upload
  could make `fit-file-parser` block the entire Node event loop for 10+
  seconds — confirmed by sending a concurrent request during a bad parse
  and getting no response. Fixed by sniffing the FIT header before parsing
  at all, and isolating the actual parse in a killable subprocess
  (`server/fitParseWorker.ts`) so a bad file can never freeze the app for
  everyone. Not yet verified against a real Garmin-exported .fit file (no
  fixture available in this environment) — the extraction logic is a
  faithful port of sub5-dashboard's already-proven `fitUpload.ts`, but treat
  the first real upload as the actual first test of that path.
- **Phase 3** — the goal-arbitration scheduler itself. Takes 2+ active goals
  and produces one plan, surfacing conflicts explicitly (marathon volume vs.
  a pre-wedding deficit) rather than picking a winner silently. This is the
  actual differentiator and gets the most design attention.
- **Phase 4** — conversational onboarding: ask clarifying questions (goals,
  priorities, deadlines, connector toggles) until there's enough to
  generate a first plan.
- **Phase 5** — Garmin/Whoop/Apple Health connectors.
- **Phase 6** — wire `outcomeLog` into an actual calibration loop: when the
  app says "high confidence," is it right more often than "low confidence"?
  If not, the confidence labels are lying and need to be pulled in. This is
  the mechanism that turns logged data into an actual moat over time.

## Running it

```
npm install
npm run dev     # http://localhost:5000
npm run check   # tsc
npm test        # shared/*.test.ts, shared/predictors/*.test.ts, server/*.test.ts
```
