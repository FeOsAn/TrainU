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

The athlete does get their own app, assembled from a library of building
blocks off their goal model — see Phase 8. Assembled, not generated: a model
writing bespoke UI per user produces code nobody reviewed, can't test, and
can't hold to the one hard rule below. A curated library plus a deterministic
assembler is the same promise from the athlete's side and an asset on ours.
When an athlete's goals reach past the library, the assembler says so and
logs it, and we build the block — so the backlog is written by real goals
rather than guessed at.

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
  **Bug found later, when the UI first made it visible** (see "Client"
  below): a goal whose target date had passed was still taking part in
  arbitration. Its neutral 1.0x kept getting blended in — at priority 1, so
  weighted heavily — so a wedding that finished in October pulled the
  following June's race-week taper from 0.5x up to 0.83x, and manufactured a
  phantom "conflict" with a goal that no longer existed. The app would have
  under-tapered an athlete into their A-race on behalf of a dead goal. Past
  goals are now excluded from the nutrition stance, the load blend and
  conflict detection, while still being reported in `goalPhases` so the UI
  can show them. Three regression tests cover it. The Phase 3 tests missed
  this originally because they checked that a past goal reports `past` and
  reverts nutrition — never that it stops influencing *load*.
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
- **Phase 6 (done)** — the calibration loop actually closes end-to-end, not
  just as a report nobody reads. `shared/calibrationReport.ts` (pure, no DB —
  takes {confidenceRatio, predictedProbability, actualSuccess} records) computes
  a Brier score, buckets accuracy by mostly-guessed vs. mostly-measured
  inputs, and — once there are ≥20 resolved "confident" (≥70% or ≤30%)
  predictions — a `recommendedMultiplier`: >1 if confident calls were right
  less often than the stated probability implied (overconfident, widen
  future bands), <1 if more often (underconfident, narrow, floored at 0.5).
  `server/calibrationService.ts` extracts those records from `outcomeLog`
  and exposes `recordOutcome(id, {achieved})` / `getCalibrationReport()`.
  `shared/measured.ts`'s `widenForConfidence` gained an optional
  `calibrationMultiplier` parameter (default 1, so every existing caller is
  unaffected); `predictRunRace`/`predictTriathlon`/`predictHyrox` — the
  three predictors with a `goalProbability` — thread it through, and
  `routes.ts` passes `getCalibrationMultiplier()` on every call. Every
  `/api/predict/{run,triathlon,hyrox}` response now includes an `outcomeId`;
  `POST /api/outcomes/:id/record` and `GET /api/calibration/report` close
  the loop.
  **Verified live, not just unit-tested**: seeded 20 systematically
  overconfident predictions through the real running server (stated ~99%
  confidence, actually right ~19% of the time) via the real HTTP endpoints,
  confirmed the report detected it (`recommendedMultiplier: 1.8`), and
  confirmed the very next `/api/predict/run` call came back with a band
  widened from 16 points to 23 automatically — no restart, no manual
  intervention. That said: this is a synthetic proof the *mechanism* works,
  not evidence the app is well- or mis-calibrated — there is no real usage
  history yet, and there won't be a genuine signal here until real
  predictions accumulate real outcomes over months. That accumulation, not
  this session, is what actually makes it a moat.
  111 tests, `tsc` clean.
- **Phase 7 (done)** — until now the arbitration engine's output was a
  *coefficient*: "0.83x load, deficit". True, defensible, and useless to an
  athlete on a Tuesday morning. This phase puts real sessions, real numbers
  and a real feedback channel underneath it.
  - `shared/prescription/` turns the weekly multiplier into actual sessions.
    `sessionKinds.ts` is the shared vocabulary (a runtime `SESSION_KINDS`
    value, not just a type — HyroxNga learned that hand-written copies of the
    same list drift apart). `templates.ts` holds the coaching IP as
    deterministic data: `GOAL_QUALITIES` per goal type ordered
    most-important-first, so when days are scarce the week drops from the
    right rather than losing its long run. `PHASE_SHAPES` only reshape a week
    (its intensity ceiling) and deliberately do NOT set its size — the
    arbitrated multiplier already encodes phase, and two mechanisms sizing
    the same week is how you get a 225-minute "easy run". `prescribe.ts` is
    the multi-goal allocator: each goal's qualities are charged
    `(index + 1) / weight` where `weight = 1/priority`, which deterministically
    interleaves competing goals by priority; sessions merge ACROSS goals (two
    goals both wanting an easy run get one session serving both, labelled as
    such) but never within a goal. Planned TSS runs through the same
    `estimateSessionTss` a logged session does, so prescribed and actual load
    are comparable rather than two scales.
  - `shared/nutrition.ts` puts numbers behind the stance. The deficit is
    derived from the `requiredWeeklyChangeKg` `predictBodyComposition` already
    computes (`GoalPhase` now carries it) — not a second, disagreeing copy of
    the safe-rate logic. Katch-McArdle RMR off fat-free mass, training energy
    from the day's prescribed TSS, deficit capped at 25% of maintenance,
    protein 2.4 g/kg FFM in a deficit and 1.8 otherwise. Per-day, so a rest
    day and a long-run day carry different targets.
  - `shared/schema.ts`'s `sessionCompletions` + `server/completionsService.ts`
    close the other loop. Keyed `date#kind`, storing a `prescribedJson`
    snapshot: the plan re-derives on every request, so without the snapshot,
    improving your threshold pace in March would silently rewrite what
    February's sessions "were". This is the dataset that actually compounds —
    `outcomeLog` gets a handful of predictions a year, adherence gets ~5 rows
    a week per athlete.
  - `GET /api/plan/week` returns the arbitrated week, 7 days of sessions,
    per-day nutrition, completions and adherence in one call;
    `POST /api/sessions/complete` and `GET /api/completions` record and read.
    `Plan.tsx` now leads with tick-off session cards.

  **Six bugs found by inspecting the generated weeks rather than by the tests
  passing** — worth recording because every one of them produced plausible
  output:
  1. A merge collapsed a goal's *second* easy run into its first, quietly
     giving 4 sessions where 5 were asked for. Merging is only legitimate
     across goals.
  2. A 225-minute "easy run" — two mechanisms (a `longShare` fraction and a
     per-kind budget) were sizing the same session. Removed one, added
     `KIND_MINUTES` bounds.
  3. A long run *shorter* than the week's easy run. Now explicitly forced to
     dominate.
  4. A 3h13 long run: the budget was `daysPerWeek * 60` but 3 of those 5 days
     were strength sessions that don't draw on it. Sized by aerobic slot count
     instead.
  5. A base week with two threshold runs — the intensity ceiling downgraded
     `run_intervals` into a `run_threshold` that already existed. Duplicated
     hard kinds now downgrade again. Base reads 3 easy + 1 threshold + 1 long;
     build correctly keeps both threshold and intervals.
  6. **A pre-existing cross-module bug the prescription work exposed**:
     `calibration.ts` writes an all-out 1 km time trial into
     `runThresholdSecPerKm`, but `enduranceRace.ts` anchored that number
     straight onto 15 km — reading a three-minute effort as an hour-long one.
     It predicted a **3:00 marathon off a 4:00/km kilometre**. The conversion
     now lives once in `shared/athlete.ts` (`FRESH_KM_TO_THRESHOLD`), next to
     the field it converts, with the field's doc comment saying what it holds;
     the fixed predictor gives 3:30, and Riegel straight off the kilometre
     independently agrees at 3:31. The general lesson, the same one
     `Measured<T>` encodes: a number crossing a module boundary needs its
     meaning attached, not assumed.

  151 tests, `tsc` clean. **Verified live**: full API sweep against a fresh
  DB; an edge-case battery (bad date/kind/status/rpe, empty bodies, garbage
  query params) returning clean 400s with no 500s and no hangs; `daysPerWeek`
  clamping 99 → 7; empty-state and all-goals-past weeks degrading to sane
  maintenance numbers. Then in a real browser: five tick-off cards, ticking
  one persists through a reload, adherence updates, and the week renders real
  paces ("5:30/km — conversational, nose-breathing"), real loads ("Back squat
  4 × 5 @ 112.5 kg"), per-day macros (2460 kcal on a rest day → 3231 on the
  long-run day) and the shared-session note "Serves Wedding and Ironman 70.3
  at once — one session, both goals" — zero console, page or HTTP errors.

- **Phase 8 (done)** — the app is now ASSEMBLED per athlete rather than being
  one fixed shell for everyone. The distinction that matters: TrainU does not
  *generate* an app (an LLM writing bespoke UI per user can't be reviewed,
  tested, or held to the `Measured<T>` rule, because nobody wrote it). It
  assembles one from a curated block library, deterministically, off the goal
  model. Same promise from the athlete's side — "I told it my goals and the
  app is about my goals" — on code that was validated once and reused.
  - `shared/appShell/blocks.ts` is the catalog. Every block declares what
    capabilities it PROVIDES and who it applies to (goal types, disciplines,
    stated preferences); every goal type declares what it NEEDS. Engine blocks
    (`surface: "engine"`) provide without rendering, so "the prescriber can do
    X for this athlete" and "this panel shows for this athlete" resolve
    through ONE matching rule rather than two that drift — the same mistake
    `SESSION_KINDS` exists to prevent a layer down.
  - `shared/appShell/assemble.ts` is the assembler: pure, no DB, no model
    call. Goals + preferences → which surfaces exist, which blocks sit on
    each, what the app can do, and **what it can't**.
  - **The gap loop is the point.** A capability a live goal needs that no
    built block provides is reported to the athlete ("Not built yet", naming
    which goal wanted it) and logged to `capabilityGaps` via
    `server/appShellService.ts`. So the build queue gets written by real
    athlete goals instead of guessed at — the same loop Phase 6 runs for
    predictions, one level up: `outcomeLog` records where a prediction was
    wrong, `capabilityGaps` records where the app was simply absent.
    `GET /api/app-shell` and `GET /api/app-shell/gaps`.

  **The gap mechanism found a real bug before it was even finished.** `Goal`
  had no way to say which sports it involved, so `endurance_race` covered a
  marathon and an Ironman identically and every endurance goal took the
  run-only quality list. Meanwhile `prescribe.ts` contained *complete* swim
  and bike sessions — targets off CSS and FTP, TSS weights, duration bounds,
  rationale strings — that nothing could ever request. **An Ironman athlete
  was being handed a marathon plan**, with the correct sessions sitting built
  and unreachable in the same file. Fixed by adding `Discipline` to `Goal`
  (run / triathlon / cycling / swimming / other) and a discipline-aware
  `qualitiesFor()`; a regression test now asserts a triathlon week contains a
  ride and a swim. Generalized into a catalog-integrity test: any *targeted*
  block providing a capability no goal type it serves ever asks for is
  unreachable, and fails the suite.

  Three further findings from inspecting generated weeks rather than trusting
  green tests:
  1. **The week's anchor was hardcoded to `run_long`.** Once triathlon weeks
     existed, that rule actively fought the fix — pushing the long run back
     above the ride it was meant to sit beneath. Split into two rules: the
     long run outlasts every other RUN, and the discipline's `ANCHOR_KIND`
     outlasts everything. For a runner both resolve to the long run, so the
     marathon week is byte-identical to before.
  2. **`KIND_WEIGHT` was tuned for a runner**, where a ride is cross-training.
     In a triathlon the same `bike_endurance` session is the main event. A
     70.3 week came out 49% running / 41% bike by minutes against a race
     that's roughly 55% bike. `DISCIPLINE_KIND_WEIGHT` overrides per
     discipline (triathlon now lands 57/33/10) while leaving every other goal
     type on exactly the weights it had.
  3. **`athlete.stations` claimed to be built and rendered nothing.**
     `AthleteParams.benchmarks` holds HYROX station times and
     `calibrateBenchmark()` can write them, but no screen enters them — so a
     HYROX athlete was silently short-changed. Re-declared `planned`, which
     makes it an honest gap instead. The catalog is only worth something if
     "built" means built.

  Also fixed: onboarding has asked every athlete about physique tracking since
  Phase 4 and written the answer to `preferences.features.physiqueTracking` —
  which **nothing has ever read**. It's now a declared-but-unbuilt block, so
  the athlete is told it isn't built rather than the preference vanishing.
  A stated preference is a stated need; storing it silently was the one
  option that wasn't acceptable.

  Client: the Athlete page's field groups ARE blocks and render in assembled
  order, and the seed counter now counts only VISIBLE fields (telling a
  marathoner 18 numbers are seeds when 3 are bike/swim fields they'll never
  see sends them hunting for measurements nothing will ask for). The Goals
  form gained a "Which sports" selector, shown only for endurance races where
  it changes anything. The Plan page ends with "Not built yet".

  175 tests, `tsc` clean. **Verified live in a browser**: the same athlete
  with a triathlon goal sees `RUNNING / BIKE & SWIM / HEART RATE / STRENGTH /
  BODY`, 18 seeds, and a week containing a 109-minute ride and a swim; flipped
  to a running race, the app reshapes to `RUNNING / HEART RATE / STRENGTH /
  BODY`, 15 seeds, and no ride or swim — zero console, page or HTTP errors.
  Edge cases: bad dates 400, a hallucinated discipline rejected 400, an empty
  discipline on an old row falling back to its type's default, and an athlete
  with no live goals degrading to the universal blocks plus an honest gap.

  **Known limitation, not a bug**: durations are per-KIND, so two rides in one
  week come out the same length. A real triathlon week has one long weekend
  ride and a shorter midweek one. Fixing it means per-occurrence sizing, which
  would also change every multi-easy-run week — worth doing deliberately, not
  as a side effect of this phase.

- **Phase 9 (done)** — deployable, and the athlete gets a say.

  **Three things blocked or endangered a real deploy**, found by building the
  production bundle and booting it against an empty volume rather than by
  reasoning about it:
  1. **No schema on boot.** `drizzle-kit push` is a dev command and isn't
     available in a deployed container, so a fresh volume gave a database
     containing nothing but the identity stamp and every endpoint 500'd on
     "no such table". Migrations are now generated, committed, and applied by
     `migrate()` at startup. `pretest` no longer runs `push` either, so the
     test suite builds its schema through the same path a deploy does.
     (Ordering matters: `app_identity` is part of the schema, so stamping
     before migrating made the migration fail trying to create a table that
     already existed. Migrate first, then stamp.)
  2. **No auth.** Every row is keyed `"self"` — correct for a personal app,
     dangerous the moment it has a public URL. `server/auth.ts` gates every
     `/api` route behind one shared password in an HTTP-only cookie. It
     **fails closed in production**: with no `APP_PASSWORD` set it refuses to
     serve rather than serving openly, because an app that silently publishes
     a training history because an env var was forgotten is worse than one
     that won't start.
  3. **Garmin passwords in plaintext.** Garmin has no OAuth for a hobbyist
     app, so syncing means holding the athlete's actual account password — on
     a laptop that's roughly as safe as the laptop, on hosted infrastructure
     it is a real credential in someone else's database, very often shared
     with other accounts. `server/secrets.ts` does AES-256-GCM under
     `CREDENTIAL_KEY`, applied in `credentialsService.ts` so that *every*
     secret crosses one boundary — a future connector cannot forget to
     encrypt. Also fails closed in production. Legacy plaintext rows read
     through unchanged and get sealed on the next write, so no migration.

  **Athlete overrides**, because inference alone was too rigid. The assembler
  gets the default right most of the time, and "most of the time" can't be the
  only mechanism: a runner who also rides wants their FTP tracked, someone on
  a cut who finds progress photos miserable wants that gone. Neither is
  expressible as a goal. `BlockPreferences` is an explicit `on`/`off` per
  block that beats inference in both directions, with `null` handing the
  decision back — "let my goals decide" has to stay reachable once you've
  overridden something. Two consequences worth stating:
  - switching a block **off** silences its gap, because telling someone a
    feature they declined isn't built yet is nagging dressed up as honesty;
  - switching an unbuilt block **on** *creates* a gap, since that's the
    clearest statement of need an athlete can make.

  **Surfaces collapse when empty**, so five tabs is a default rather than a
  fixed shape — the nav is assembled from the same answer the pages are, since
  a hardcoded nav leaves a tab pointing at a page with nothing on it, which
  looks broken rather than plain. Plan, Goals and Coach survive regardless:
  an athlete who switched everything off must still be able to switch
  something back on. A new **Your app** page (`/app`) lists every block with
  what the assembler decided, what the athlete chose instead, and whether the
  two differ.

  191 tests, `tsc` clean. **Verified against the real production bundle**, not
  the dev server: built, booted against an empty directory, migrations created
  12 tables, `/api/goals` 401 without a cookie and 200 with one, a wrong
  password rejected, `NODE_ENV=production` with no `APP_PASSWORD` refusing to
  serve, and a stored Garmin password confirmed as `enc.v1:…` ciphertext on
  disk while round-tripping correctly through the service. Then in a browser:
  switching all three Data blocks off removes the Data tab, "let my goals
  decide" brings it back, and bad override input (unknown block, invalid
  choice, array body) returns 400 — zero console, page or HTTP errors.


- **Phase 10 (done)** — the plan starts reacting to the athlete, and the two
  features that would have reacted *wrongly* are deliberately not built.

  Ten features were designed in parallel, reconciled into one architecture, and
  then attacked by three adversarial reviews (coaching validity, architecture
  and drift, athlete experience). Those reviews returned **9 blockers and 25
  majors**, and several were serious enough that shipping the design as written
  would have been worse than shipping nothing. The rulings are recorded as
  binding decisions; the four that mattered most:
  - **A threshold run prescribed to an ill athlete.** `applyCeiling(kind,
    "easy")` walks `DOWNGRADE` exactly ONE step, so `run_intervals` became
    `run_threshold` — `3 × 10 min` at threshold pace for someone with a fever.
    `downgradeToEasy()` is a fixed-point walk and is now used everywhere an
    easy ceiling is meant; `applyCeiling`'s easy branch delegates to it so the
    two cannot disagree. Pinned by a test asserting no session emitted while
    any illness is open has `intensity === "hard"`.
  - **Sessions silently shrinking 15–50%.** The conditions modulator was
    scheduled twice as an "idempotent guard", but its scaling branches are
    multiplicative (0.85 × 0.85 = 0.72) — and because the session is rebuilt
    from the new minutes, the card reads as a coherent, deliberate
    prescription. Split into `applyConditions` (the full rules, once) and
    `enforceConditions` (only the two predicates on the current kind, which
    are genuinely idempotent, last). Pinned by a test that runs the pipeline
    over its own output and asserts zero new adjustments — **plus a companion
    test proving a scaling step does compound**, which is what makes the first
    test meaningful rather than accidentally green.
  - **Taper weeks losing their intensity.** Two slices removed hard sessions
    with no phase gate, in exactly the week `PHASE_SHAPES.taper` says
    "intensity held". The design's guard read `loadMultiplier <= 0.6`, which
    the multi-goal blend this app exists to perform defeats: an Ironman taper
    (0.5, priority 1) with a cut (0.9, priority 2) blends to 0.633. So
    `PrescribedWeek` now carries `phaseName` and the gate reads it. In
    taper/peak a low morning **shortens** the hard session rather than
    downgrading it — which is what a coach does, and race week is exactly when
    self-reported readiness is systematically worst.
  - **A deficit running through an injury.** The conditions slice strips
    training TSS out of the day, which lowers maintenance energy, and a 25%
    deficit was then applied to that already-reduced number — a double hit
    precisely when tissue repair needs substrate. While a condition of
    severity ≥ 2 is open the stance is forced to `maintenance`, explained in
    the same channel a goal-vs-goal tradeoff uses.

  **Built**: `shared/prescription/adjust.ts` (the one modulation layer) and its
  two slices; session feedback (RPE + a structured reason whose *signal* —
  circumstance / recovery / health / engagement — is DATA, so "travelling" and
  "knees hurt" can never be read the same way); injury and illness as
  first-class state; morning check-in; race-day pacing; what-if on goals;
  per-occurrence session sizing; HYROX station entry; physique tracking.

  **Deliberately NOT built, and declared as honest gaps**: adherence
  tendencies (`plan.learned`) and mid-week re-plan (`plan.adjustments`).
  Every tendency rule has a minimum-evidence threshold, so on a fresh database
  all of them return nothing — shipping logic whose first real action is two
  months away, that has never run against real data, is what Phase 6's own
  caveat warns against. Both data-corruption blockers also live there: their
  evidence table records "shown and never answered", and the app's own
  adjustments manufacture phantom skips in it (a session *the app removed*
  counted as one the athlete skipped — the Phase 3 archetype). The reviews
  also found the learning loop only ever subtracts: four rules remove load,
  none restore it. Session feedback, which *collects* what both need, ships
  now; the learners get built when there is real signal to build against.

  **A real bug found by verifying rather than trusting a report.** The healing
  rule was implemented correctly but anchored on the week's Monday, so an
  injury opened on a Wednesday left the stance reading `deficit` in the very
  response that already carried two sessions the same injury had turned into
  rest. A week is seven days long; whether a condition is open during it cannot
  be answered from its first day. `asOf` now clamps today into the week — the
  current week asks about today, a past week asks about its own last day (so
  news that arrived afterwards never rewrites what it said), and a future week
  asks about its first. Four cases pinned by a regression test.

  **Two rules that look like details and are not:**
  - *Nutrition targets follow the plan, not the performance.* A day's macros
    come from the adjusted week, never from completions. Skipping a long run
    must not retroactively drop that day from 3231 to 2460 kcal: the athlete
    ate to the number the app gave them, and silently replacing it implies
    they overate. Verified live — skip a session, the target does not move.
  - *"Actually, I did this" must always work.* A session the layer turned into
    rest stays recordable from the Changes panel. Without it, an athlete who
    trains anyway either loses the record or has to go back and falsify their
    check-in — making lying to the app the only route to training as
    prescribed. Verified live: a rested long run, ticked anyway, returns to
    its day card and is immune on the next re-derive while the injury is still
    open.

  568 tests, `tsc` clean, production build green. **Verified live**: B5 and B6
  end to end against a real server; an edge-case battery (bad severities,
  unknown restrictions and stations, RPE on a skipped session, absurd weights,
  unknown goal ids, garbage patches, empty bodies) returning clean 400s and
  404s with **zero 5xx**. Then in a browser at 430×900 phone width: zero
  console errors, zero page errors, zero failed calls, and **zero enum, kind or
  block ids on screen** — the athlete reads "Can't run", never `no_running`.

  **Known limitations, stated rather than discovered later**: physique photos
  are not built (an authenticated file-serving path on a volume is its own
  piece of work — measurements and the trend are there); the Plan page does not
  gate on its four original blocks, which predates this phase; and the check-in
  uses the server's UTC date, so an athlete far from UTC checking in early can
  have the app's "today" disagree with theirs.

## Client

Everything above was API-only until the client was built — five routes under
`client/src/pages/`, wired with wouter + react-query against `client/src/lib/api.ts`
(same-origin, since the Express server serves the Vite middleware):

- **Plan** (`/`) — the hero, because the arbitration engine is the product.
  Since Phase 7 it opens on this week's actual sessions, day by day, each with
  its concrete targets, its per-day kcal/protein/fat/carb, and Done/Partial/
  Skipped buttons — then the blended load multiplier and nutrition stance with
  adherence, then "why this week looks like this" (what each goal wants in
  isolation), the tradeoffs where goals genuinely pull apart, and the weeks
  ahead. The reasoning is still there; it's just no longer the first thing the
  athlete has to read to know what to do today.
- **Athlete** (`/athlete`) — every `Measured<T>` with a seed/measured pill and
  its provenance string underneath, plus a live count of how many numbers are
  still guesses. This is the one hard rule made visible to the athlete rather
  than only enforced in code — the CdA field that started this whole project
  now literally reads "seed — relaxed road position assumed, not measured".
- **Goals** (`/goals`), **Coach** (`/coach`, the onboarding chat),
  **Data** (`/data` — training load, connectors, calibration, sessions).

Styling is hand-rolled CSS adapting sub5-dashboard's `docs/design-system.md`
tokens (flat panels on hairline borders, one accent, display numerals for
metrics), with system fonts rather than Google Fonts — this app has to render
correctly with no outbound network at all, which is exactly the situation in
the sandbox it was built in.

**Verified in a real browser, not just compiled**: Chromium via Playwright
(installed with `--no-save`, so it is deliberately not a project dependency)
across all five routes — zero console errors, zero page errors, zero failed
API calls; then driven interactively to create a goal through the form, confirm
validation blocks an incomplete one, edit an athlete number and watch it flip
seed → measured with the seed counter decrementing, confirm the new goal flows
through into the arbitrated plan, and confirm the chat degrades gracefully
without an API key. That interactive pass is what surfaced the past-goal
arbitration bug noted in Phase 3 — it was invisible until a real plan was
rendered on screen.

## What's next

**Deploy it and use it.** Everything below needs things this environment
cannot provide, and each is the first real test of a phase that has only ever
been verified synthetically: connect a real Garmin/Whoop account or import an
Apple Health export (Phase 5), have the onboarding chat hold a real multi-turn
conversation with an `ANTHROPIC_API_KEY` set (Phase 4), and start logging real
outcomes so Phase 6's calibration has something to say.

Phase 10 adds a fourth, and it is the one that compounds: **tick sessions off
every week.** The two deferred features — learning what you actually do, and
rearranging the week when you miss a day — are declared gaps precisely because
they need that history before any rule of theirs can fire. Four to eight weeks
of real completions, with real reasons attached, is what turns them from
plausible logic into logic anyone can check.

The block library is the other thing that compounds: every gap
`capabilityGaps` records is a block that, once built, serves every future
athlete whose goals ask for it. Two are already queued and named — a
race-day pacing plan and physique tracking — plus HYROX station-benchmark
entry. Per-occurrence session sizing (one long ride and one shorter one,
rather than two identical) is the known limitation worth closing deliberately.

Phase 7 makes that last one materially easier: adherence rows arrive weekly
rather than a few times a year, and they carry both what was prescribed and
what actually happened. The obvious next build is to feed them back — when an
athlete systematically skips the second threshold session, the prescriber
should learn that about *them*, not just report it. That closes the same loop
Phase 6 opened for predictions, one level down at the session.

## Running it

```
npm install
npm run dev     # http://localhost:5000
npm run check   # tsc
npm test        # shared/, shared/predictors/, shared/arbitration/,
                # shared/prescription/, shared/appShell/, server/
npm run build   # vite + esbuild -> dist/
npm start       # production, serves dist/public
```

## Deploying

See `.env.example` for every variable and what happens without it. The short
version: `APP_PASSWORD` and `CREDENTIAL_KEY` are required — a production
instance refuses to serve data without the first and refuses to store a
third-party credential without the second. `DB_PATH` must point inside a
mounted volume or every deploy wipes the athlete's history; it defaults to
`/data/trainu.db`, which matches a volume mounted at `/data`.

Migrations run automatically on boot, so a fresh volume comes up with a
complete schema. `migrations/` is generated by `npx drizzle-kit generate` and
**must be committed** — the deployed container has no drizzle-kit.
