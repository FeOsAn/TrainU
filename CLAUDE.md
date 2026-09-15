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
- **Phase 3 (done)** — `shared/arbitration/goalPhase.ts` computes what each
  goal wants in isolation (base/build/peak/taper for races, a cut/lean-gain
  window for body-composition goals derived directly from Phase 2's
  `predictBodyComposition` — no duplicated safe-rate logic).
  `shared/arbitration/arbitrate.ts` blends N goals' phases into one weekly
  instruction: a priority-weighted training-load multiplier, one resolved
  nutrition stance, and an explicit `GoalConflict` whenever two goals
  genuinely pull apart (a direct surplus/deficit contradiction, or load asks
  more than 0.15 apart) — contiguous weekly conflicts between the same pair
  get merged into one span by `arbitratePlan` rather than repeating weekly.
  `GET /api/plan/arbitrate` exposes it. Verified end-to-end against the
  canonical example: an Ironman 9 months out + a wedding 6 weeks out keeps
  the Ironman in base phase (not silently paused) while the wedding runs a
  deficit, and both revert to maintenance the week after the wedding date
  passes. 68 tests, `tsc` clean.
  `Goal` gained a `targetMetrics` field (structured numbers — target weight,
  body-fat %, lift id) since `successCriteria` is free text and the
  predictors/arbitration need real numbers to compute against.
- **Phase 4 (done)** — `server/onboarding.ts`: a tool-calling chat (Claude
  Sonnet 5, `@anthropic-ai/sdk`) that asks clarifying questions one or two
  at a time and calls `create_goal` once it has enough — copying the two
  rules HyroxNga's `llmCoach.ts` already proved out: tools do the writing
  with real server-side validation regardless of what the tool schema
  promised (`server/goalValidation.ts`, DB-free and independently tested —
  a hallucinated goal type or a mangled date is rejected the same way a bad
  form submission would be), and the model never claims an action a tool
  result didn't verify (retry/fallback/closing-call logic ported from
  `llmCoach.ts`'s `createWithRetry`). Also asks once about connector intent
  (Garmin/Whoop/Apple — `set_connector_preferences`) and optional features
  (`set_feature_preferences`); actual OAuth wiring is Phase 5. `create_goal`
  and the REST `POST /api/goals` now share one write path
  (`server/goalsService.ts`) instead of two that could drift apart.
  `POST /api/onboarding/chat` / `GET /api/onboarding/history` /
  `GET+PATCH /api/preferences*`. Degrades to a plain "set ANTHROPIC_API_KEY"
  message if the key's missing, rather than crashing.
  81 tests, `tsc` clean. **Caveat**: no ANTHROPIC_API_KEY is available in
  this environment, so the actual multi-turn tool-calling conversation is
  unverified beyond the no-key path and the tool-dispatch logic tested in
  isolation (`server/onboarding.test.ts`) — the first real conversation is
  the real test of the prompt/flow itself.
  Test suite now runs against a disposable `trainu.test.db`
  (`DB_PATH` env var, wired through `drizzle.config.ts` and
  `pretest`/`posttest`) instead of the dev database, so `npm test` is
  reproducible from a clean checkout and never pollutes real dev data.
- **Phase 5 (done)** — `server/connectors/`: Garmin (email/password via the
  unofficial `garmin-connect` package — Garmin has no public OAuth2 API for
  a hobbyist app, same approach both sibling apps use), Whoop (real OAuth2),
  Apple Health (no server API at all — parses an `export.xml` the athlete
  uploads by hand). All three normalize into the same `TrainingSession` and
  go through Phase 2's `findDuplicate` before insert — one dedupe pipeline,
  not three.
  Ported the one lesson from sub5-dashboard's `whoopSync.ts` worth carrying
  over verbatim: Whoop rotates its refresh token on every use, so two
  concurrent refreshes racing each other can burn the token and force a
  reconnect (a real production incident there). `refreshWhoopToken()` is
  single-flighted — tested by mocking concurrent callers and asserting
  exactly one network call happens.
  **Found and fixed a second real bug while testing**: `garmin-connect`
  builds its axios client with no `timeout` configured and exposes no way
  to set one, so a network hang would leave that request stuck forever
  (confirmed by reading its `HttpClient.js` — `axios.create()`, no timeout
  option anywhere). Wrapped every call into it in `withTimeout()`.
  97 tests, `tsc` clean. **Caveat, confirmed empirically rather than
  assumed**: this environment's network egress is host-allowlisted and
  actively blocks `sso.garmin.com`, `api.prod.whoop.com`, etc. (403 "not in
  allowlist") — so beyond confirming errors fail cleanly and fast rather
  than hanging, no real Garmin/Whoop login or sync, and no real Apple
  Health export, has been exercised here. The Apple Health parser IS fully
  tested, against synthetic export.xml data, since that path needs no
  network at all.
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
