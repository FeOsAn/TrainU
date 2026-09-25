import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, daysUntil, GOAL_TYPE_LABELS, tenYearsFrom, todayStr } from "../lib/api";
import { useSurfaceBlocks } from "../lib/appShell";
import { WhatIfPanel } from "../components/WhatIfPanel";
import { type Discipline, type GoalType, defaultDiscipline } from "@shared/goal";

const TYPES = Object.keys(GOAL_TYPE_LABELS) as GoalType[];

/*
 * Only endurance races are ambiguous about which sports they involve, and the
 * answer changes the plan completely — a triathlon discipline is what makes
 * the prescriber schedule rides and swims instead of handing an Ironman
 * athlete a marathon week. Every other goal type implies its own sports, so
 * asking would be a question with one answer.
 */
const DISCIPLINE_LABELS: Partial<Record<Discipline, string>> = {
  run: "Running only",
  triathlon: "Triathlon (swim / bike / run)",
  cycling: "Cycling",
  swimming: "Swimming",
};
const DISCIPLINE_CHOICES = Object.keys(DISCIPLINE_LABELS) as Discipline[];

/** Only the target fields that actually mean something for the chosen goal type. */
function metricFieldsFor(type: GoalType): Array<{ key: string; label: string; placeholder: string }> {
  switch (type) {
    case "body_composition":
      return [
        { key: "targetWeightKg", label: "Target weight (kg)", placeholder: "78" },
        { key: "targetBodyFatPercent", label: "Target body fat (%)", placeholder: "12" },
      ];
    case "endurance_race":
    case "hyrox":
      return [
        { key: "targetTimeSeconds", label: "Target time (seconds)", placeholder: "12600" },
        { key: "targetDistanceKm", label: "Distance (km)", placeholder: "42.2" },
      ];
    default:
      return [];
  }
}

export default function Goals() {
  const queryClient = useQueryClient();
  const { data: goals, isLoading } = useQuery({ queryKey: ["goals"], queryFn: api.goals });
  const goalBlocks = useSurfaceBlocks("goals");
  const canWhatIf = goalBlocks === undefined || goalBlocks.includes("goals.whatIf");
  const [tryingOut, setTryingOut] = useState<string | null>(null);

  const [type, setType] = useState<GoalType>("endurance_race");
  const [discipline, setDiscipline] = useState<Discipline>("run");
  const [label, setLabel] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [priority, setPriority] = useState(1);
  const [successCriteria, setSuccessCriteria] = useState("");
  const [metrics, setMetrics] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: () => {
      const targetMetrics: Record<string, number> = {};
      for (const [key, raw] of Object.entries(metrics)) {
        const n = parseFloat(raw);
        if (Number.isFinite(n)) targetMetrics[key] = n;
      }
      return api.createGoal({ type, discipline: type === "endurance_race" ? discipline : defaultDiscipline(type), label, targetDate, priority, successCriteria, targetMetrics });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      queryClient.invalidateQueries({ queryKey: ["plan"] });
      setLabel("");
      setTargetDate("");
      setSuccessCriteria("");
      setMetrics({});
    },
  });

  // Goals drive everything — the plan, the assembled app, pacing — so after a
  // removal every cached answer is stale.
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteGoal(id),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  const canSubmit = label.trim() && targetDate && successCriteria.trim() && !create.isPending;

  return (
    <div className="page">
      <div className="page-header">
        <div className="kicker">Goals</div>
        <h1>What you're training for</h1>
      </div>

      {isLoading && <div className="panel"><div className="skeleton" style={{ width: "50%" }} /></div>}

      {goals?.map((goal) => {
        const days = daysUntil(goal.targetDate);
        return (
          <div key={goal.id} className="panel">
            <div className="row">
              <div className="stack">
                <strong style={{ fontSize: 15 }}>{goal.label}</strong>
                <span className="tiny muted">
                  {GOAL_TYPE_LABELS[goal.type]} · {goal.successCriteria}
                </span>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0, whiteSpace: "nowrap" }}>
                <div className="display-num" style={{ fontSize: 20 }}>
                  {days >= 0 ? days : "—"}
                </div>
                <div className="tiny muted">{days >= 0 ? "days out" : "passed"}</div>
              </div>
            </div>
            <div className="divider" />
            <div className="row tiny muted">
              <span>{goal.targetDate}</span>
              <span className={`pill ${goal.priority === 1 ? "pill-verified" : "pill-neutral"}`}>priority {goal.priority}</span>
            </div>

            <button
              className="btn-ghost"
              style={{ marginTop: 12, marginRight: 8, padding: "6px 12px", fontSize: 12 }}
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Remove "${goal.label}"? Your logged sessions stay; only the goal goes.`)) remove.mutate(goal.id);
              }}
            >
              Remove
            </button>

            {/* Only for a goal that is still ahead of you — there is nothing to try out about a race that has happened. */}
            {canWhatIf && goal.active && goal.targetDate >= todayStr() && (
              <>
                <button
                  className="btn-ghost"
                  style={{ marginTop: 12, padding: "6px 12px", fontSize: 12 }}
                  onClick={() => setTryingOut(tryingOut === goal.id ? null : goal.id)}
                >
                  {tryingOut === goal.id ? "Close" : "What if…"}
                </button>
                {tryingOut === goal.id && <WhatIfPanel goal={goal} />}
              </>
            )}
          </div>
        );
      })}

      <div className="panel">
        <h2>Add a goal</h2>
        <p className="small muted" style={{ marginTop: -6 }}>
          Priority is the one that matters most — 1 outranks 2, and it's what decides which goal yields
          when two of them want opposite things in the same week.
        </p>

        <label>
          <span className="section-label">Type</span>
          <select value={type} onChange={(e) => { setType(e.target.value as GoalType); setMetrics({}); }}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {GOAL_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        {type === "endurance_race" && (
          <label>
            <span className="section-label">Which sports</span>
            <select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline)}>
              {DISCIPLINE_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {DISCIPLINE_LABELS[d]}
                </option>
              ))}
            </select>
            <span className="tiny muted" style={{ display: "block", marginTop: 5, lineHeight: 1.45 }}>
              This decides the week you get. A triathlon is planned around the bike; a running race isn't.
            </span>
          </label>
        )}

        <label>
          <span className="section-label">Name</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Berlin Marathon" />
        </label>

        <div className="grid grid-2">
          <label>
            <span className="section-label">Target date</span>
            <input type="date" value={targetDate} max={tenYearsFrom(todayStr())} onChange={(e) => setTargetDate(e.target.value)} />
          </label>
          <label>
            <span className="section-label">Priority</span>
            <input type="number" min={1} value={priority} onChange={(e) => setPriority(Math.max(1, parseInt(e.target.value, 10) || 1))} />
          </label>
        </div>

        <label>
          <span className="section-label">What success looks like</span>
          <input value={successCriteria} onChange={(e) => setSuccessCriteria(e.target.value)} placeholder="sub-3:30, feeling strong at 30k" />
        </label>

        {metricFieldsFor(type).length > 0 && (
          <div className="grid grid-2">
            {metricFieldsFor(type).map((field) => (
              <label key={field.key}>
                <span className="section-label">{field.label}</span>
                <input
                  type="number"
                  value={metrics[field.key] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(e) => setMetrics({ ...metrics, [field.key]: e.target.value })}
                />
              </label>
            ))}
          </div>
        )}

        {create.error && <div className="notice notice-danger">{(create.error as Error).message}</div>}

        <button className="btn-primary" disabled={!canSubmit} onClick={() => create.mutate()}>
          {create.isPending ? "Saving…" : "Add goal"}
        </button>
      </div>
    </div>
  );
}
