/**
 * The front door.
 *
 * Everything in TrainU is assembled off the goal model (shared/appShell/), so
 * until there is a goal model there is nothing to assemble — which is what
 * this screen exists to get. It is the whole app until it is finished, and
 * after that it is gone: `appBuild.completedAt` is set and App.tsx routes
 * past it forever, unless the athlete deletes the app from "Your app".
 *
 * Two rules it is built around:
 *
 *  - It finishes offline. Dictation is a browser API and the narrative
 *    read-back is an optional button, so an instance with no ANTHROPIC_API_KEY
 *    and a browser with no speech support still gets you a complete app. A
 *    front door that needs a paid service to open is not a front door.
 *  - Optional means optional. Every physiological number here can be skipped,
 *    and skipping it leaves a seed that says on the Athlete page that it is a
 *    guess. That is the `Measured<T>` rule doing its job at the moment it
 *    matters most — onboarding is exactly where an app is tempted to demand
 *    numbers nobody has, and then treat the invented ones as facts.
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, todayStr, type SurveyAnswers, type SurveyGoalAnswer } from "../lib/api";
import {
  DISCIPLINE_LABELS,
  EMPTY_SURVEY,
  GOAL_TYPES,
  GOAL_TYPE_HINTS,
  GOAL_TYPE_LABELS,
  MAX_TRAINING_DAYS,
  MIN_TRAINING_DAYS,
  emptyGoal,
} from "@shared/onboarding/survey";
import type { Discipline, GoalType } from "@shared/goal";
import { DISCIPLINES } from "@shared/goal";
import VoiceField from "../components/VoiceField";

type StepId = "welcome" | "goals" | "you" | "week" | "numbers" | "connect" | "build";

const STEPS: Array<{ id: StepId; title: string; kicker: string }> = [
  { id: "welcome", title: "Tell it about you", kicker: "In your own words" },
  { id: "goals", title: "What are you training for?", kicker: "One or several" },
  { id: "you", title: "Your numbers", kicker: "The basics" },
  { id: "week", title: "Your week", kicker: "What you can actually do" },
  { id: "numbers", title: "Where you're at", kicker: "All optional" },
  { id: "connect", title: "Anything to plug in?", kicker: "Last one" },
  { id: "build", title: "Building your app", kicker: "Almost there" },
];

const DRAFT_KEY = "trainu.survey.draft";

/** Kept in the browser, not the database: a half-finished survey is a draft, and a draft that outlives the tab it was typed in is not worth a table. */
function loadDraft(): SurveyAnswers {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return { ...EMPTY_SURVEY, ...JSON.parse(raw) };
  } catch {
    /* private mode, cleared storage, corrupted value — start clean. */
  }
  return { ...EMPTY_SURVEY };
}

function saveDraft(answers: SurveyAnswers) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(answers));
  } catch {
    /* nothing to do about a full or blocked localStorage, and it isn't fatal. */
  }
}

export default function Survey({ onBuilt }: { onBuilt: () => void }) {
  const today = todayStr();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [answers, setAnswersRaw] = useState<SurveyAnswers>(loadDraft);
  const [error, setError] = useState<string | null>(null);

  const setAnswers = (next: SurveyAnswers | ((prev: SurveyAnswers) => SurveyAnswers)) => {
    setAnswersRaw((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      saveDraft(value);
      return value;
    });
  };
  const patch = (fields: Partial<SurveyAnswers>) => setAnswers((prev) => ({ ...prev, ...fields }));

  const submit = useMutation({
    mutationFn: () => api.submitSurvey(answers),
    onSuccess: () => {
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* see saveDraft */
      }
      queryClient.clear();
      onBuilt();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Couldn't build it.");
      setStep(STEPS.findIndex((s) => s.id === "goals"));
    },
  });

  const current = STEPS[step]!;
  const blocked = blockerFor(current.id, answers, today);

  function next() {
    setError(null);
    if (blocked) return;
    const target = step + 1;
    setStep(target);
    if (STEPS[target]?.id === "build") submit.mutate();
    window.scrollTo({ top: 0 });
  }

  function back() {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="survey">
      <header className="survey-head">
        <div className="survey-brand">
          <span className="logo-mark" aria-hidden="true" />
          TrainU
        </div>
        <div className="survey-progress" role="progressbar" aria-valuenow={step + 1} aria-valuemin={1} aria-valuemax={STEPS.length}>
          {STEPS.map((s, i) => (
            <span key={s.id} className={`seg${i < step ? " seg-done" : i === step ? " seg-now" : ""}`} />
          ))}
        </div>
      </header>

      <main className="survey-step">
        <div className="kicker">{current.kicker}</div>
        <h1 className="display">{current.title}</h1>

        {current.id === "welcome" && <StepWelcome answers={answers} patch={patch} setAnswers={setAnswers} today={today} />}
        {current.id === "goals" && <StepGoals answers={answers} setAnswers={setAnswers} today={today} />}
        {current.id === "you" && <StepYou answers={answers} patch={patch} />}
        {current.id === "week" && <StepWeek answers={answers} patch={patch} />}
        {current.id === "numbers" && <StepNumbers answers={answers} patch={patch} today={today} />}
        {current.id === "connect" && <StepConnect answers={answers} patch={patch} />}
        {current.id === "build" && <StepBuild pending={submit.isPending} error={error} onRetry={() => submit.mutate()} />}

        {error && current.id !== "build" && <div className="notice notice-danger" style={{ marginTop: 16 }}>{error}</div>}
      </main>

      {current.id !== "build" && (
        <footer className="survey-foot">
          {step > 0 ? (
            <button type="button" className="btn-ghost" onClick={back}>
              Back
            </button>
          ) : (
            <span />
          )}
          <div className="stack" style={{ alignItems: "flex-end", gap: 6 }}>
            {blocked && <span className="tiny muted">{blocked}</span>}
            <button type="button" className="btn-primary btn-lg" onClick={next} disabled={Boolean(blocked)}>
              {STEPS[step + 1]?.id === "build" ? "Build my app" : "Continue"}
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}

/** What stops this step continuing, in the athlete's words — or null. Mirrors validateSurvey, which is what actually enforces it server-side. */
function blockerFor(id: StepId, answers: SurveyAnswers, today: string): string | null {
  if (id === "goals") {
    if (answers.goals.length === 0) return "Add at least one goal";
    const unnamed = answers.goals.find((g) => !g.label.trim());
    if (unnamed) return "Every goal needs a name";
    const past = answers.goals.find((g) => g.targetDate < today);
    if (past) return `"${past.label}" is dated in the past`;
  }
  return null;
}

/* ─── Step 1: the narrative ──────────────────────────────────────────── */

function StepWelcome({
  answers,
  patch,
  setAnswers,
  today,
}: {
  answers: SurveyAnswers;
  patch: (fields: Partial<SurveyAnswers>) => void;
  setAnswers: (next: (prev: SurveyAnswers) => SurveyAnswers) => void;
  today: string;
}) {
  const [readBack, setReadBack] = useState<{ filled: string[]; message?: string } | null>(null);

  const interpret = useMutation({
    mutationFn: () => api.interpretNarrative(answers.narrative),
    onSuccess: (result) => {
      // Merged UNDER what the athlete has already entered, never over it —
      // a model reading a paragraph does not get to overwrite a number
      // someone typed. Everything it fills is shown on the steps that follow,
      // and nothing is written until the survey is finished.
      setAnswers((prev) => ({
        ...prev,
        ...result.draft,
        name: prev.name || result.draft.name || "",
        goals: prev.goals.length > 0 ? prev.goals : (result.draft.goals ?? []),
      }));
      setReadBack({ filled: result.filled, message: result.message });
    },
  });

  return (
    <>
      <p className="lede">
        Say what you're training for, what shape you're in, and anything that matters — a race, a date, an
        injury, a week that's already full. It builds the app around that.
      </p>

      <div className="panel">
        <label className="field">
          <span className="section-label">What should it call you?</span>
          <input value={answers.name} placeholder="Your name" maxLength={40} onChange={(e) => patch({ name: e.target.value })} />
        </label>

        <VoiceField
          label="In your own words"
          rows={7}
          value={answers.narrative}
          onChange={(narrative) => patch({ narrative })}
          placeholder="I've got a HYROX on 14 November and I want to go sub-70. I train five or six days a week, I've got a gym and a bike but no pool. I'd also like to be a bit leaner by Christmas without wrecking the HYROX prep."
          hint="Your browser doesn't do speech recognition — type it instead, it all works the same."
        />

        <div className="divider" />

        <div className="row">
          <div className="stack" style={{ gap: 2 }}>
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>Fill the rest in from that</span>
            <span className="tiny muted">Optional. You'll see and can change everything it puts in.</span>
          </div>
          <button
            type="button"
            className="btn-ghost"
            disabled={!answers.narrative.trim() || interpret.isPending}
            onClick={() => interpret.mutate()}
          >
            {interpret.isPending ? "Reading…" : "Read it back"}
          </button>
        </div>

        {readBack && readBack.filled.length > 0 && (
          <div className="notice" style={{ marginTop: 12 }}>
            Filled in {readBack.filled.join(", ")}. Check it on the next few screens.
          </div>
        )}
        {readBack && readBack.filled.length === 0 && readBack.message && (
          <div className="notice notice-warn" style={{ marginTop: 12 }}>{readBack.message}</div>
        )}
        {interpret.error && (
          <div className="notice notice-warn" style={{ marginTop: 12 }}>{(interpret.error as Error).message}</div>
        )}
      </div>

      <p className="tiny muted">
        You can skip this entirely and answer the next few screens instead — {new Date(`${today}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })} onwards, either way.
      </p>
    </>
  );
}

/* ─── Step 2: goals ──────────────────────────────────────────────────── */

function StepGoals({
  answers,
  setAnswers,
  today,
}: {
  answers: SurveyAnswers;
  setAnswers: (next: (prev: SurveyAnswers) => SurveyAnswers) => void;
  today: string;
}) {
  const update = (index: number, fields: Partial<SurveyGoalAnswer>) =>
    setAnswers((prev) => ({ ...prev, goals: prev.goals.map((g, i) => (i === index ? { ...g, ...fields } : g)) }));

  const move = (index: number, delta: number) =>
    setAnswers((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.goals.length) return prev;
      const goals = [...prev.goals];
      [goals[index], goals[target]] = [goals[target]!, goals[index]!];
      return { ...prev, goals };
    });

  return (
    <>
      <p className="lede">
        Add everything, not just the main one. Two goals that pull against each other is the situation this
        app is actually built for — it reconciles them rather than picking one.
      </p>

      {answers.goals.map((goal, index) => (
        <GoalCard
          key={index}
          goal={goal}
          index={index}
          total={answers.goals.length}
          today={today}
          onChange={(fields) => update(index, fields)}
          onRemove={() => setAnswers((prev) => ({ ...prev, goals: prev.goals.filter((_, i) => i !== index) }))}
          onMove={(delta) => move(index, delta)}
        />
      ))}

      <button
        type="button"
        className="add-card"
        onClick={() => setAnswers((prev) => ({ ...prev, goals: [...prev.goals, emptyGoal(today)] }))}
      >
        <span className="add-plus">+</span>
        {answers.goals.length === 0 ? "Add your first goal" : "Add another goal"}
      </button>

      {answers.goals.length > 1 && (
        <p className="tiny muted" style={{ marginTop: 14 }}>
          Order is priority order — #1 is the one that wins when two of them want different weeks. Use the
          arrows to change it.
        </p>
      )}
    </>
  );
}

function GoalCard({
  goal,
  index,
  total,
  today,
  onChange,
  onRemove,
  onMove,
}: {
  goal: SurveyGoalAnswer;
  index: number;
  total: number;
  today: string;
  onChange: (fields: Partial<SurveyGoalAnswer>) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const metrics = goal.targetMetrics ?? {};
  const setMetric = (fields: Partial<SurveyGoalAnswer["targetMetrics"]>) =>
    onChange({ targetMetrics: { ...metrics, ...fields } });

  return (
    <div className="panel goal-card">
      <div className="row" style={{ marginBottom: 14 }}>
        <span className="rank">#{index + 1}</span>
        <div className="chip-row">
          {total > 1 && (
            <>
              <button type="button" className="chip chip-mini" disabled={index === 0} onClick={() => onMove(-1)} aria-label="More important">
                ↑
              </button>
              <button type="button" className="chip chip-mini" disabled={index === total - 1} onClick={() => onMove(1)} aria-label="Less important">
                ↓
              </button>
            </>
          )}
          <button type="button" className="chip chip-mini" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>

      <div className="opt-grid">
        {GOAL_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            className={`opt${goal.type === type ? " opt-on" : ""}`}
            onClick={() => onChange({ type, discipline: type === "endurance_race" ? goal.discipline : "other", targetMetrics: {} })}
          >
            <span className="opt-title">{GOAL_TYPE_LABELS[type]}</span>
            <span className="opt-hint">{GOAL_TYPE_HINTS[type]}</span>
          </button>
        ))}
      </div>

      <label className="field">
        <span className="section-label">What is it called?</span>
        <input
          value={goal.label}
          maxLength={80}
          placeholder={goal.type === "body_composition" ? "Sister's wedding" : "Berlin Marathon"}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </label>

      {goal.type === "endurance_race" && (
        <div className="field">
          <span className="section-label">Which sport?</span>
          <div className="chip-row">
            {DISCIPLINES.filter((d) => d !== "other").map((d) => (
              <button
                key={d}
                type="button"
                className={`chip${goal.discipline === d ? " chip-on" : ""}`}
                onClick={() => onChange({ discipline: d as Discipline })}
              >
                {DISCIPLINE_LABELS[d]}
              </button>
            ))}
          </div>
        </div>
      )}

      <label className="field">
        <span className="section-label">{goal.type === "general_fitness" ? "Check in by" : "When is it?"}</span>
        <input type="date" value={goal.targetDate} min={today} onChange={(e) => onChange({ targetDate: e.target.value })} />
      </label>

      {(goal.type === "endurance_race" || goal.type === "hyrox") && (
        <>
          {goal.type === "endurance_race" && (
            <label className="field">
              <span className="section-label">How far? (km, optional)</span>
              <NumberInput
                value={metrics.targetDistanceKm}
                placeholder="42.2"
                onChange={(targetDistanceKm) => setMetric({ targetDistanceKm })}
              />
            </label>
          )}
          <div className="field">
            <span className="section-label">Goal time (optional)</span>
            <DurationInput value={metrics.targetTimeSeconds} onChange={(targetTimeSeconds) => setMetric({ targetTimeSeconds })} />
          </div>
        </>
      )}

      {goal.type === "body_composition" && (
        <div className="grid grid-2">
          <label className="field">
            <span className="section-label">Target weight (kg)</span>
            <NumberInput value={metrics.targetWeightKg} placeholder="74" onChange={(targetWeightKg) => setMetric({ targetWeightKg })} />
          </label>
          <label className="field">
            <span className="section-label">Target body fat (%)</span>
            <NumberInput value={metrics.targetBodyFatPercent} placeholder="10" onChange={(targetBodyFatPercent) => setMetric({ targetBodyFatPercent })} />
          </label>
        </div>
      )}

      {goal.type === "strength" && (
        <>
          <div className="field">
            <span className="section-label">Which lift?</span>
            <div className="chip-row">
              {([
                ["squat1RmKg", "Squat"],
                ["deadlift1RmKg", "Deadlift"],
                ["bench1RmKg", "Bench"],
                ["ohp1RmKg", "Overhead press"],
              ] as const).map(([id, label]) => (
                <button key={id} type="button" className={`chip${metrics.liftId === id ? " chip-on" : ""}`} onClick={() => setMetric({ liftId: id })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span className="section-label">Target (kg)</span>
            <NumberInput value={metrics.targetWeightKg} placeholder="140" onChange={(targetWeightKg) => setMetric({ targetWeightKg })} />
          </label>
        </>
      )}

      <label className="field" style={{ marginBottom: 0 }}>
        <span className="section-label">What does success look like? (optional)</span>
        <input
          value={goal.successCriteria}
          maxLength={240}
          placeholder="Finish it without walking"
          onChange={(e) => onChange({ successCriteria: e.target.value })}
        />
      </label>
    </div>
  );
}

/* ─── Step 3: the basics ─────────────────────────────────────────────── */

function StepYou({ answers, patch }: { answers: SurveyAnswers; patch: (fields: Partial<SurveyAnswers>) => void }) {
  return (
    <>
      <p className="lede">
        These size your calorie and protein targets. Skip any of them and the app uses a stand-in and says
        so on the Athlete screen — it never presents a guess as a measurement.
      </p>
      <div className="panel">
        <div className="grid grid-2">
          <label className="field">
            <span className="section-label">Age</span>
            <NumberInput value={answers.ageYears} placeholder="30" suffix="yrs" onChange={(ageYears) => patch({ ageYears })} />
          </label>
          <label className="field">
            <span className="section-label">Height</span>
            <NumberInput value={answers.heightCm} placeholder="178" suffix="cm" onChange={(heightCm) => patch({ heightCm })} />
          </label>
          <label className="field">
            <span className="section-label">Weight</span>
            <NumberInput value={answers.weightKg} placeholder="75" suffix="kg" onChange={(weightKg) => patch({ weightKg })} />
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="section-label">Body fat</span>
            <NumberInput value={answers.bodyFatPercent} placeholder="15" suffix="%" onChange={(bodyFatPercent) => patch({ bodyFatPercent })} />
          </label>
        </div>
      </div>
      <p className="tiny muted">
        Don't know your body fat? Leave it. A rough visual estimate is fine too — you can correct it any time
        and everything downstream re-derives.
      </p>
    </>
  );
}

/* ─── Step 4: the week ───────────────────────────────────────────────── */

function StepWeek({ answers, patch }: { answers: SurveyAnswers; patch: (fields: Partial<SurveyAnswers>) => void }) {
  const days = useMemo(
    () => Array.from({ length: MAX_TRAINING_DAYS - MIN_TRAINING_DAYS + 1 }, (_, i) => MIN_TRAINING_DAYS + i),
    [],
  );

  return (
    <>
      <p className="lede">
        Be honest rather than ambitious. The plan is built to this number, so a week you can't hit is a week
        of sessions marked skipped.
      </p>

      <div className="panel">
        <span className="section-label">Days a week you can train</span>
        <div className="day-picker">
          {days.map((n) => (
            <button
              key={n}
              type="button"
              className={`day-pick${answers.trainingDaysPerWeek === n ? " day-pick-on" : ""}`}
              onClick={() => patch({ trainingDaysPerWeek: n })}
            >
              {n}
            </button>
          ))}
        </div>
        <p className="tiny muted" style={{ margin: "10px 0 0" }}>
          Three is the fewest the plan builder works with — below that it can't shape a week.
        </p>
      </div>

      <div className="panel">
        <span className="section-label">What have you got access to?</span>
        <p className="tiny muted" style={{ margin: "6px 0 12px" }}>
          This isn't a nicety: when something hurts and running is out, whether there's a bike decides
          between a ride and a rest day.
        </p>
        <Toggle label="A bike or turbo" on={answers.hasBike} onChange={(hasBike) => patch({ hasBike })} />
        <Toggle label="A pool" on={answers.hasPool} onChange={(hasPool) => patch({ hasPool })} />
      </div>
    </>
  );
}

/* ─── Step 5: current numbers ────────────────────────────────────────── */

function StepNumbers({
  answers,
  patch,
  today,
}: {
  answers: SurveyAnswers;
  patch: (fields: Partial<SurveyAnswers>) => void;
  today: string;
}) {
  const types = new Set(answers.goals.map((g) => g.type));
  const disciplines = new Set(answers.goals.map((g) => g.discipline));
  const runs = types.has("hyrox") || disciplines.has("run") || disciplines.has("triathlon") || types.has("general_fitness");
  const lifts = types.has("strength") || types.has("hyrox");
  const rides = answers.hasBike || disciplines.has("triathlon") || disciplines.has("cycling");

  const effort = answers.recentEffort;
  const setEffort = (fields: Partial<NonNullable<SurveyAnswers["recentEffort"]>>) =>
    patch({ recentEffort: { distanceKm: 0, timeSeconds: 0, date: today, ...effort, ...fields } });

  return (
    <>
      <p className="lede">
        Every one of these is optional. Give it what you actually know — anything you skip stays a stand-in,
        flagged as one, until a real session or a test measures it.
      </p>

      {runs && (
        <div className="panel">
          <span className="section-label">A recent hard run</span>
          <p className="tiny muted" style={{ margin: "6px 0 12px" }}>
            The single most useful thing you can hand over. Every pace on every session comes off this — a
            parkrun, a race, a hard tempo, anything you went properly at.
          </p>
          <div className="grid grid-2">
            <label className="field">
              <span className="section-label">Distance</span>
              <NumberInput value={effort?.distanceKm} placeholder="5" suffix="km" onChange={(distanceKm) => setEffort({ distanceKm: distanceKm ?? 0 })} />
            </label>
            <label className="field">
              <span className="section-label">When</span>
              <input type="date" max={today} value={effort?.date ?? today} onChange={(e) => setEffort({ date: e.target.value })} />
            </label>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <span className="section-label">Time</span>
            <DurationInput value={effort?.timeSeconds} onChange={(timeSeconds) => setEffort({ timeSeconds: timeSeconds ?? 0 })} />
          </div>
          {effort?.distanceKm ? (
            <button type="button" className="chip chip-mini" style={{ marginTop: 12 }} onClick={() => patch({ recentEffort: undefined })}>
              Clear this
            </button>
          ) : null}
        </div>
      )}

      {lifts && (
        <div className="panel">
          <span className="section-label">Your lifts — best single, or a solid estimate</span>
          <div className="grid grid-2" style={{ marginTop: 12 }}>
            {([
              ["squat1RmKg", "Squat"],
              ["deadlift1RmKg", "Deadlift"],
              ["bench1RmKg", "Bench"],
              ["ohp1RmKg", "Overhead press"],
            ] as const).map(([id, label]) => (
              <label key={id} className="field" style={{ marginBottom: 0 }}>
                <span className="section-label">{label}</span>
                <NumberInput
                  value={answers.lifts[id]}
                  placeholder="—"
                  suffix="kg"
                  onChange={(value) => patch({ lifts: { ...answers.lifts, [id]: value } })}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="grid grid-2">
          {rides && (
            <label className="field" style={{ marginBottom: 0 }}>
              <span className="section-label">FTP</span>
              <NumberInput value={answers.ftpWatts} placeholder="240" suffix="W" onChange={(ftpWatts) => patch({ ftpWatts })} />
            </label>
          )}
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="section-label">Max heart rate</span>
            <NumberInput value={answers.maxHrBpm} placeholder="185" suffix="bpm" onChange={(maxHrBpm) => patch({ maxHrBpm })} />
          </label>
        </div>
      </div>
    </>
  );
}

/* ─── Step 6: connectors ─────────────────────────────────────────────── */

function StepConnect({ answers, patch }: { answers: SurveyAnswers; patch: (fields: Partial<SurveyAnswers>) => void }) {
  const set = (key: keyof SurveyAnswers["connectors"], value: boolean) =>
    patch({ connectors: { ...answers.connectors, [key]: value } });

  return (
    <>
      <p className="lede">
        Say which of these you want and the app puts them on the Data screen, ready to connect. Nothing is
        connected now — you'll sign in when you get there.
      </p>

      <div className="panel">
        <Toggle label="Garmin" hint="Pulls your activities in automatically." on={answers.connectors.garmin} onChange={(v) => set("garmin", v)} />
        <Toggle label="Whoop" hint="Recovery and sleep alongside the training." on={answers.connectors.whoop} onChange={(v) => set("whoop", v)} />
        <Toggle label="Apple Health" hint="An export file you upload — no account needed." on={answers.connectors.appleHealth} onChange={(v) => set("appleHealth", v)} />
      </div>

      <div className="panel">
        <Toggle
          label="Track how you look"
          hint="Weight, waist and a trend line over a cut or a gaining block."
          on={answers.physiqueTracking}
          onChange={(physiqueTracking) => patch({ physiqueTracking })}
        />
      </div>

      <p className="tiny muted">
        All of this is changeable later, on "Your app" — including turning whole sections of the app off.
      </p>
    </>
  );
}

/* ─── Step 7: the build ──────────────────────────────────────────────── */

function StepBuild({ pending, error, onRetry }: { pending: boolean; error: string | null; onRetry: () => void }) {
  if (error) {
    return (
      <>
        <div className="notice notice-danger" style={{ marginTop: 20 }}>{error}</div>
        <button type="button" className="btn-primary btn-lg" style={{ marginTop: 16 }} onClick={onRetry}>
          Try again
        </button>
      </>
    );
  }

  return (
    <div className="build-stage">
      <div className="build-rings" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p className="lede" style={{ textAlign: "center" }}>
        {pending ? "Reconciling your goals into one week…" : "Done."}
      </p>
    </div>
  );
}

/* ─── Small shared controls ──────────────────────────────────────────── */

function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" className="toggle-row" onClick={() => onChange(!on)} aria-pressed={on}>
      <span className="stack" style={{ gap: 2, textAlign: "left" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
        {hint && <span className="tiny muted">{hint}</span>}
      </span>
      <span className={`switch${on ? " switch-on" : ""}`} aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

/**
 * A number field that can hold NOTHING.
 *
 * `<input type="number">` bound to a number can't distinguish "empty" from
 * "zero", and in this survey empty is a real, common and meaningful answer —
 * it means "leave that one a seed". So the text is kept as text while the
 * athlete types, and only a parseable value is handed up.
 */
function NumberInput({
  value,
  onChange,
  placeholder,
  suffix,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder?: string;
  suffix?: string;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));

  return (
    <span className="num-wrap">
      <input
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value.replace(",", ".");
          setText(raw);
          if (raw.trim() === "") return onChange(undefined);
          const parsed = Number.parseFloat(raw);
          onChange(Number.isFinite(parsed) ? parsed : undefined);
        }}
      />
      {suffix && <span className="num-suffix">{suffix}</span>}
    </span>
  );
}

/**
 * Hours / minutes / seconds as three boxes.
 *
 * One box would be ambiguous in the one place it matters: "3:30" is three and
 * a half hours for a marathon and three and a half minutes for a kilometre,
 * and a survey that guesses wrong writes a target the whole plan is then
 * built around.
 */
function DurationInput({ value, onChange }: { value: number | undefined; onChange: (seconds: number | undefined) => void }) {
  const total = value ?? 0;
  const parts = { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };

  const set = (key: "h" | "m" | "s", raw: string) => {
    const next = { ...parts, [key]: Math.max(0, Math.floor(Number.parseFloat(raw) || 0)) };
    const seconds = next.h * 3600 + next.m * 60 + next.s;
    onChange(seconds > 0 ? seconds : undefined);
  };

  return (
    <span className="duration">
      {(["h", "m", "s"] as const).map((key) => (
        <span key={key} className="num-wrap">
          <input
            inputMode="numeric"
            value={value === undefined ? "" : String(parts[key])}
            placeholder="0"
            onChange={(e) => set(key, e.target.value)}
          />
          <span className="num-suffix">{key}</span>
        </span>
      ))}
    </span>
  );
}
