import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { api, daysUntil, todayStr, type PlanDay, type PlanSession, type PlanWeek } from "../lib/api";
import { useAppShell, useSurfaceBlocks } from "../lib/appShell";
import { CheckInStrip } from "../components/CheckInStrip";
import { ConditionsPanel, type ConditionPrefill } from "../components/ConditionsPanel";
import { SessionCard, type TickPatch } from "../components/SessionCard";
import { ChangesPanel } from "../components/ChangesPanel";
import { PacingPanel } from "../components/PacingPanel";
import type { GoalConflict } from "@shared/goal";
import { CONDITION_KIND_LABELS, RISK_LEVEL_LABELS } from "@shared/conditions";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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

function DayCard({ day, onTick, pending }: { day: PlanDay; onTick: (session: PlanSession, patch: TickPatch) => void; pending: boolean }) {
  const isToday = day.date === todayStr();
  const weekday = DAY_NAMES[(new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7];

  return (
    <div className="panel" style={isToday ? { borderColor: "rgba(36,204,107,0.35)" } : undefined}>
      <div className="row" style={{ marginBottom: day.sessions.length ? 12 : 0 }}>
        <div className="stack">
          <span className="section-label" style={isToday ? { color: "var(--primary)" } : undefined}>
            {weekday} {isToday ? "· today" : ""}
          </span>
          <span className="display-num" style={{ fontSize: 14 }}>{day.date}</span>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="display-num" style={{ fontSize: 15 }}>{day.nutrition.kcal} kcal</div>
          <div className="tiny muted">
            P{day.nutrition.proteinG} · F{day.nutrition.fatG} · C{day.nutrition.carbG}
          </div>
        </div>
      </div>

      {day.sessions.length === 0 && <div className="tiny muted">Rest day — adaptation happens here, not in the sessions.</div>}

      {day.sessions.map((session) => (
        <SessionCard key={session.kind} session={session} pending={pending} onTick={(patch) => onTick(session, patch)} />
      ))}
    </div>
  );
}

export default function Plan() {
  const { data: shell } = useAppShell();
  const planBlocks = useSurfaceBlocks("plan");
  const queryClient = useQueryClient();
  const { data: goals } = useQuery({ queryKey: ["goals"], queryFn: api.goals });
  const { data: week, isLoading, error } = useQuery({ queryKey: ["week"], queryFn: () => api.week() });
  const { data: plan } = useQuery({ queryKey: ["plan"], queryFn: () => api.plan() });

  /*
   * A tick that said "injury" or "illness" comes back with a `followUp`: the
   * offer to open a condition, already filled in from what was just said.
   * Only offered when the athlete actually has that block — a dead button
   * for someone who switched "Something hurts?" off would be worse than the
   * honest line below it.
   */
  const [prefill, setPrefill] = useState<ConditionPrefill | null>(null);
  const [onRecord, setOnRecord] = useState<string | null>(null);
  const canOpenConditions = shell?.capabilities.includes("condition_adjustment") ?? false;

  const tick = useMutation({
    mutationFn: (body: Parameters<typeof api.completeSession>[0]) => api.completeSession(body),
    onSuccess: (record) => {
      queryClient.invalidateQueries({ queryKey: ["week"] });
      if (!record.followUp) return;
      if (canOpenConditions) {
        setPrefill({
          kind: record.followUp.reason === "injury" ? "injury" : "illness",
          label: "",
          note: record.followUp.prefill.note,
          openedAt: record.followUp.prefill.date,
        });
      } else {
        setOnRecord(
          `Noted — that's on record as ${CONDITION_KIND_LABELS[record.followUp.reason === "injury" ? "injury" : "illness"].toLowerCase()}. ` +
            `Turn on "Something hurts?" in Your app and the week will work around it.`,
        );
      }
    },
  });

  const onTick = (session: PlanSession, patch: TickPatch) =>
    tick.mutate({ date: session.date, kind: session.kind, ...patch });

  const activeGoals = goals?.filter((g) => g.active) ?? [];
  const arbitrated = week?.arbitrated;
  const has = (id: string) => planBlocks === undefined || planBlocks.includes(id);

  return (
    <div className="page">
      <div className="page-header">
        <div className="kicker">This week</div>
        <h1>Your plan</h1>
      </div>

      {/*
       * ── DECISIONS C8 ────────────────────────────────────────────────────
       * Two single lines, then the accent panel, then the sessions. Phase 7's
       * win was that the athlete sees what to do today rather than a wall of
       * reasoning; everything Phase 10 added above the fold is collapsed to
       * one tappable line each so that stays true.
       */}
      {/*
        * Rendered as soon as the SHELL says this athlete has it, not once the
        * week has loaded. Waiting for the week would make this line appear a
        * beat late and shove the session cards down after the athlete had
        * already started reading them — the C8 failure by a different route.
        */}
      {has("plan.checkIn") && <CheckInStrip checkIn={week?.checkIn ?? null} readiness={week?.readiness ?? null} />}
      {has("plan.conditions") && <ConditionsPanel prefill={prefill} onPrefillUsed={() => setPrefill(null)} />}

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

      {arbitrated && activeGoals.length > 0 && week && (
        <div className="panel panel-accent">
          <div className="grid grid-3">
            <div>
              <div className="section-label">Load</div>
              <div className="display-num" style={{ fontSize: 22, marginTop: 4 }}>{arbitrated.loadMultiplier}×</div>
              {/*
                * `week.phaseName` deliberately does NOT go here. It is a free
                * string, not an enum with a label table, and it can read
                * "maintain" — a word for the engine, not the athlete. Each
                * goal's phase is named with a full explanation in "why this
                * week looks like this" below, which is where it belongs.
                */}
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
                {/* What it was before the layer touched it — shown, not swapped out silently. */}
                {week.original.totalMinutes !== week.totalMinutes && (
                  <span className="was" style={{ fontSize: 13, marginLeft: 6 }}>{week.original.totalMinutes}m</span>
                )}
              </div>
              <div className="tiny muted">{week.totalTss} TSS</div>
            </div>
          </div>
          <div className="tiny muted" style={{ marginTop: 10 }}>{week.note}</div>
          {week.adherence.adherenceRate !== null && (
            <div className="tiny muted" style={{ marginTop: 6 }}>
              Adherence {Math.round(week.adherence.adherenceRate * 100)}% — {week.adherence.completed} done,{" "}
              {week.adherence.skipped} skipped of {week.adherence.prescribed} prescribed
              {week.adherence.actualTss !== null && <> · {week.adherence.actualTss} of {week.totalTss} TSS done</>}.
            </div>
          )}
        </div>
      )}

      {tick.error && <div className="notice notice-danger">{(tick.error as Error).message}</div>}
      {onRecord && <div className="notice notice-neutral">{onRecord}</div>}

      {week?.days.map((day) => (
        <DayCard key={day.date} day={day} pending={tick.isPending} onTick={onTick} />
      ))}

      {week && <ChangesPanel week={week as PlanWeek} pending={tick.isPending} onTick={onTick} />}

      {has("plan.pacing") && <PacingPanel />}

      {arbitrated && arbitrated.goalPhases.length > 0 && (
        <div className="panel">
          <div className="section-label" style={{ marginBottom: 10 }}>Why this week looks like this</div>
          {arbitrated.goalPhases.map((phase) => {
            const goal = activeGoals.find((g) => g.id === phase.goalId);
            return (
              <div key={phase.goalId} className="surface-2" style={{ marginBottom: 8 }}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <div className="stack">
                    <strong style={{ fontSize: 14 }}>{phase.goalLabel}</strong>
                    <span className="tiny muted">{goal ? `${daysUntil(goal.targetDate)} days out · priority ${goal.priority}` : phase.goalType}</span>
                  </div>
                  <span className="display-num" style={{ fontSize: 15 }}>{phase.phaseName}</span>
                </div>
                <div className="tiny muted" style={{ lineHeight: 1.5 }}>{phase.notes}</div>

                {/*
                 * What an injury has actually cost this goal. Only when there
                 * is something to read — "On track" under every goal every
                 * week is noise that trains the athlete to skip the line that
                 * matters.
                 */}
                {phase.risk && phase.risk.level !== "none" && (
                  <div className="notice notice-warn" style={{ marginTop: 8, marginBottom: 0 }}>
                    <div className="section-label" style={{ color: "var(--warn)", marginBottom: 4 }}>
                      {RISK_LEVEL_LABELS[phase.risk.level]}
                    </div>
                    {phase.risk.note}
                  </div>
                )}
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

      {shell && shell.gaps.length > 0 && (
        <div className="panel">
          <h2>Not built yet</h2>
          <p className="small muted" style={{ marginTop: -6 }}>
            Your goals ask for these and the app can't do them yet. Saying so beats quietly leaving them
            out — and it's how we decide what to build next.
          </p>
          {shell.gaps.map((gap) => (
            <div key={gap.capability} className="surface-2" style={{ marginBottom: 8 }}>
              <div className="row">
                <strong>{gap.label}</strong>
                <span className="pill pill-seed">not built</span>
              </div>
              <div className="tiny muted" style={{ marginTop: 6, lineHeight: 1.45 }}>
                {gap.note ?? `Wanted by ${gap.wantedBy.join(" and ")}.`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
