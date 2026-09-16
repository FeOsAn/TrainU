import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { api, daysUntil } from "../lib/api";
import type { ArbitratedWeek } from "@shared/arbitration/arbitrate";
import type { GoalConflict } from "@shared/goal";

const STANCE_COPY: Record<string, { label: string; className: string }> = {
  deficit: { label: "Calorie deficit", className: "notice-warn" },
  surplus: { label: "Calorie surplus", className: "notice" },
  maintenance: { label: "Maintenance", className: "notice-neutral" },
};

function loadCopy(multiplier: number): string {
  if (multiplier >= 1.1) return "Elevated — building";
  if (multiplier >= 1.02) return "Slightly elevated";
  if (multiplier > 0.95) return "Normal";
  if (multiplier > 0.7) return "Trimmed back";
  return "Tapering hard";
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

function WeekRow({ week }: { week: ArbitratedWeek }) {
  return (
    <div className="surface-2" style={{ marginBottom: 8 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="display-num" style={{ fontSize: 14 }}>
          {week.date}
        </span>
        <span className="row" style={{ gap: 8 }}>
          <span className={`pill ${week.nutritionStance === "maintenance" ? "pill-neutral" : week.nutritionStance === "deficit" ? "pill-seed" : "pill-verified"}`}>{week.nutritionStance}</span>
          <span className="display-num tiny muted">{week.loadMultiplier}× load</span>
        </span>
      </div>
      <div className="stack">
        {week.goalPhases.map((phase) => (
          <div key={phase.goalId} className="row tiny">
            <span className="muted">{phase.goalLabel}</span>
            <span className="display-num">{phase.phaseName}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Plan() {
  const { data: goals } = useQuery({ queryKey: ["goals"], queryFn: api.goals });
  const { data: plan, isLoading, error } = useQuery({ queryKey: ["plan"], queryFn: () => api.plan() });

  const activeGoals = goals?.filter((g) => g.active) ?? [];
  const thisWeek = plan?.weeks[0];

  return (
    <div className="page">
      <div className="page-header">
        <div className="kicker">This week</div>
        <h1>Arbitrated plan</h1>
      </div>

      {isLoading && <div className="panel"><div className="skeleton" style={{ width: "60%" }} /></div>}

      {error && (
        <div className="notice notice-danger">Couldn't load the plan: {(error as Error).message}</div>
      )}

      {plan && activeGoals.length === 0 && (
        <div className="panel">
          <h2>No active goals yet</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            The whole point of this app is reconciling several goals at once — a race, a body-composition
            deadline, a lift — into one plan. Add at least one and it'll start arbitrating.
          </p>
          <Link href="/goals" className="btn-primary" style={{ display: "inline-block", marginTop: 4 }}>
            Add a goal
          </Link>
        </div>
      )}

      {thisWeek && (
        <>
          <div className="panel panel-accent">
            <div className="grid grid-2">
              <div>
                <div className="section-label">Nutrition</div>
                <div className="display-num" style={{ fontSize: 24, marginTop: 4 }}>
                  {STANCE_COPY[thisWeek.nutritionStance]?.label ?? thisWeek.nutritionStance}
                </div>
              </div>
              <div>
                <div className="section-label">Training load</div>
                <div className="display-num" style={{ fontSize: 24, marginTop: 4 }}>
                  {thisWeek.loadMultiplier}×
                </div>
                <div className="tiny muted">{loadCopy(thisWeek.loadMultiplier)}</div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="section-label" style={{ marginBottom: 10 }}>
              What each goal wants this week
            </div>
            {thisWeek.goalPhases.map((phase) => {
              const goal = activeGoals.find((g) => g.id === phase.goalId);
              return (
                <div key={phase.goalId} className="surface-2" style={{ marginBottom: 8 }}>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <div className="stack">
                      <strong style={{ fontSize: 14 }}>{phase.goalLabel}</strong>
                      <span className="tiny muted">
                        {goal ? `${daysUntil(goal.targetDate)} days out · priority ${goal.priority}` : phase.goalType}
                      </span>
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
        </>
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

      {plan && plan.weeks.length > 1 && (
        <div className="panel">
          <h2>Ahead</h2>
          {plan.weeks.slice(1, 13).map((week) => (
            <WeekRow key={week.date} week={week} />
          ))}
          {plan.weeks.length > 13 && (
            <div className="tiny muted" style={{ textAlign: "center", paddingTop: 6 }}>
              +{plan.weeks.length - 13} more weeks through {plan.toDate}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
