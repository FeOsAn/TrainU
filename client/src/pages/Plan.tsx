import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { api, daysUntil, type CompletionStatus, type PlanDay } from "../lib/api";
import type { GoalConflict } from "@shared/goal";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const INTENSITY_PILL: Record<string, string> = {
  hard: "pill-seed",
  moderate: "pill-neutral",
  easy: "pill-neutral",
  rest: "pill-neutral",
};

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function ConflictCard({ conflict }: { conflict: GoalConflict }) {
  return (
    <div className="notice notice-warn">
      <div className="section-label" style={{ color: "var(--warn)", marginBottom: 4 }}>
        Goal conflict · {conflict.window.from} → {conflict.window.to}
      </div>
      <div>{conflict.description}</div>
    </div>
  );
}

function DayCard({ day, onTick, pending }: { day: PlanDay; onTick: (date: string, kind: any, status: CompletionStatus, prescribed: any) => void; pending: boolean }) {
  const isToday = day.date === todayStr();
  const weekday = DAY_NAMES[(new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7];

  return (
    <div className="panel" style={isToday ? { borderColor: "rgba(36,204,107,0.35)" } : undefined}>
      <div className="row" style={{ marginBottom: day.sessions.length ? 12 : 0 }}>
        <div className="stack">
          <span className="section-label" style={isToday ? { color: "var(--primary)" } : undefined}>
            {weekday} {isToday ? "· today" : ""}
          </span>
          <span className="display-num" style={{ fontSize: 14 }}>
            {day.date}
          </span>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="display-num" style={{ fontSize: 15 }}>
            {day.nutrition.kcal} kcal
          </div>
          <div className="tiny muted">
            P{day.nutrition.proteinG} · F{day.nutrition.fatG} · C{day.nutrition.carbG}
          </div>
        </div>
      </div>

      {day.sessions.length === 0 && <div className="tiny muted">Rest day — adaptation happens here, not in the sessions.</div>}

      {day.sessions.map((session) => {
        const status = session.completion?.status;
        return (
          <div key={session.kind} className="surface-2" style={{ marginBottom: 8, opacity: status === "skipped" ? 0.55 : 1 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <div className="stack" style={{ minWidth: 0 }}>
                <strong style={{ fontSize: 14 }}>{session.title}</strong>
                <span className="tiny muted">
                  {session.durationMinutes} min · {session.tss} TSS
                </span>
              </div>
              <span className={`pill ${status === "completed" ? "pill-verified" : INTENSITY_PILL[session.intensity] ?? "pill-neutral"}`}>
                {status ?? session.intensity}
              </span>
            </div>

            <ul style={{ margin: "0 0 8px", paddingLeft: 16 }}>
              {session.targets.map((target, i) => (
                <li key={i} className="tiny" style={{ lineHeight: 1.55 }}>
                  {target}
                </li>
              ))}
            </ul>

            <div className="tiny muted" style={{ marginBottom: 8 }}>
              {session.note}
            </div>

            <div className="row" style={{ gap: 6, justifyContent: "flex-start" }}>
              {(["completed", "partial", "skipped"] as CompletionStatus[]).map((option) => (
                <button
                  key={option}
                  className={status === option ? "btn-primary" : "btn-ghost"}
                  style={{ padding: "5px 10px", fontSize: 11.5 }}
                  disabled={pending}
                  onClick={() => onTick(session.date, session.kind, option, session)}
                >
                  {option === "completed" ? "Done" : option === "partial" ? "Partial" : "Skipped"}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Plan() {
  const queryClient = useQueryClient();
  const { data: goals } = useQuery({ queryKey: ["goals"], queryFn: api.goals });
  const { data: week, isLoading, error } = useQuery({ queryKey: ["week"], queryFn: () => api.week() });
  const { data: plan } = useQuery({ queryKey: ["plan"], queryFn: () => api.plan() });

  const tick = useMutation({
    mutationFn: (body: { date: string; kind: any; status: CompletionStatus; prescribed: any }) => api.completeSession(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["week"] }),
  });

  const activeGoals = goals?.filter((g) => g.active) ?? [];
  const arbitrated = week?.arbitrated;

  return (
    <div className="page">
      <div className="page-header">
        <div className="kicker">This week</div>
        <h1>Your plan</h1>
      </div>

      {isLoading && <div className="panel"><div className="skeleton" style={{ width: "60%" }} /></div>}
      {error && <div className="notice notice-danger">Couldn't load the week: {(error as Error).message}</div>}

      {week && activeGoals.length === 0 && (
        <div className="panel">
          <h2>No active goals yet</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            The point of this app is reconciling several goals at once — a race, a body-composition
            deadline, a lift — into one plan. Add one and it'll start prescribing.
          </p>
          <Link href="/goals" className="btn-primary" style={{ display: "inline-block", marginTop: 4 }}>
            Add a goal
          </Link>
        </div>
      )}

      {arbitrated && activeGoals.length > 0 && (
        <div className="panel panel-accent">
          <div className="grid grid-3">
            <div>
              <div className="section-label">Load</div>
              <div className="display-num" style={{ fontSize: 22, marginTop: 4 }}>
                {arbitrated.loadMultiplier}×
              </div>
            </div>
            <div>
              <div className="section-label">Nutrition</div>
              <div className="display-num" style={{ fontSize: 22, marginTop: 4, textTransform: "capitalize" }}>
                {arbitrated.nutritionStance}
              </div>
            </div>
            <div>
              <div className="section-label">Week</div>
              <div className="display-num" style={{ fontSize: 22, marginTop: 4 }}>
                {week.totalMinutes}m
              </div>
              <div className="tiny muted">{week.totalTss} TSS</div>
            </div>
          </div>
          <div className="tiny muted" style={{ marginTop: 10 }}>
            {week.note}
          </div>
          {week.adherence.adherenceRate !== null && (
            <div className="tiny muted" style={{ marginTop: 6 }}>
              Adherence {Math.round(week.adherence.adherenceRate * 100)}% — {week.adherence.completed} done, {week.adherence.skipped} skipped of {week.adherence.prescribed} prescribed.
            </div>
          )}
        </div>
      )}

      {tick.error && <div className="notice notice-danger">{(tick.error as Error).message}</div>}

      {week?.days.map((day) => (
        <DayCard
          key={day.date}
          day={day}
          pending={tick.isPending}
          onTick={(date, kind, status, prescribed) => tick.mutate({ date, kind, status, prescribed })}
        />
      ))}

      {arbitrated && arbitrated.goalPhases.length > 0 && (
        <div className="panel">
          <div className="section-label" style={{ marginBottom: 10 }}>
            Why this week looks like this
          </div>
          {arbitrated.goalPhases.map((phase) => {
            const goal = activeGoals.find((g) => g.id === phase.goalId);
            return (
              <div key={phase.goalId} className="surface-2" style={{ marginBottom: 8 }}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <div className="stack">
                    <strong style={{ fontSize: 14 }}>{phase.goalLabel}</strong>
                    <span className="tiny muted">{goal ? `${daysUntil(goal.targetDate)} days out · priority ${goal.priority}` : phase.goalType}</span>
                  </div>
                  <span className="display-num" style={{ fontSize: 15 }}>
                    {phase.phaseName}
                  </span>
                </div>
                <div className="tiny muted" style={{ lineHeight: 1.5 }}>
                  {phase.notes}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {plan && plan.conflicts.length > 0 && (
        <div className="panel">
          <h2>Tradeoffs being made</h2>
          <p className="small muted" style={{ marginTop: -6 }}>
            Where two goals genuinely pull against each other, the plan picks by priority — and says so
            rather than quietly dropping one.
          </p>
          {plan.conflicts.map((conflict, i) => (
            <ConflictCard key={i} conflict={conflict} />
          ))}
        </div>
      )}
    </div>
  );
}
