import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { PacingResult, PacingPlan, Split } from "@shared/pacing/pacing";
import { PACING_DISCIPLINE_LABELS, PACING_LEG_LABELS } from "@shared/pacing/profiles";

/*
 * Race day, split by split.
 *
 * The seeds and the warning go ABOVE the splits, and that ordering is the
 * feature, not a layout preference: a 3:29:58 marathon plan built off an
 * assumed threshold pace is a number someone will pace an actual race to.
 * Telling them afterwards that half the inputs were guesses is telling them
 * at the wrong time.
 */
export function PacingPanel() {
  const { data: plans, error } = useQuery({ queryKey: ["pacing"], queryFn: api.pacing });
  if (error) return <div className="notice notice-danger">{(error as Error).message}</div>;
  if (!plans || plans.length === 0) return null;

  return (
    <div className="panel">
      <h2>Race day</h2>
      {plans.map((plan) => (
        <PacingCard key={plan.goalId} plan={plan} />
      ))}
    </div>
  );
}

function PacingCard({ plan }: { plan: PacingResult }) {
  const [open, setOpen] = useState(false);

  if (!plan.available) {
    return (
      <div className="surface-2" style={{ marginBottom: 8 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <strong style={{ fontSize: 14 }}>{plan.goalLabel}</strong>
          <span className="pill pill-seed">no plan yet</span>
        </div>
        {/* Athlete-ready prose from the module; `fix.field` names the form field to go and fill in. */}
        <div className="tiny muted" style={{ lineHeight: 1.5 }}>{plan.message}</div>
      </div>
    );
  }

  return (
    <div className="surface-2" style={{ marginBottom: 8 }}>
      <button className="line-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="stack" style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 14 }}>{plan.goalLabel}</strong>
          <span className="tiny muted">{PACING_DISCIPLINE_LABELS[plan.discipline]} · {plan.finish.lowFormatted}–{plan.finish.highFormatted}</span>
        </span>
        <span className="display-num" style={{ fontSize: 19 }}>{plan.planFormatted}</span>
      </button>

      {open && <PacingDetail plan={plan} />}
    </div>
  );
}

function PacingDetail({ plan }: { plan: PacingPlan }) {
  return (
    <div style={{ marginTop: 12 }}>
      {/* ── Above the splits, always. ── */}
      {plan.seedWarning && <div className="notice notice-warn">{plan.seedWarning}</div>}
      {plan.seeds.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {plan.seeds.map((seed) => (
            <div key={seed.field} className="row tiny" style={{ marginBottom: 4 }}>
              <span>{seed.label}</span>
              <span className="muted" style={{ textAlign: "right" }}>{seed.source}</span>
            </div>
          ))}
        </div>
      )}

      <div className="tiny muted" style={{ marginBottom: 12, lineHeight: 1.5 }}>{plan.basisReason}</div>

      {plan.discipline === "run" && <SplitsTable splits={plan.splits} />}

      {plan.discipline === "triathlon" && (
        <>
          <LegRow label={PACING_LEG_LABELS.swim} value={plan.swim.formatted} note={`${plan.swim.paceFormatted} · ${plan.swim.note}`} />
          <LegRow label="T1" value={plan.t1.formatted} note={plan.t1.note} />
          <LegRow label={PACING_LEG_LABELS.bike} value={plan.bike.formatted} note={`${plan.bike.targetWatts} W, ceiling ${plan.bike.ceilingWatts} W · ${plan.bike.note}`} />
          <LegRow label="T2" value={plan.t2.formatted} note={plan.t2.note} />
          <LegRow label={PACING_LEG_LABELS.run} value={plan.run.formatted} note={plan.run.brickNote} />
          <div style={{ marginTop: 10 }}><SplitsTable splits={plan.run.splits} /></div>
        </>
      )}

      {plan.discipline === "hyrox" && (
        <table>
          <thead>
            <tr><th>Segment</th><th>Time</th><th>Elapsed</th></tr>
          </thead>
          <tbody>
            {plan.segments.map((segment) => (
              <tr key={segment.index}>
                <td>
                  {segment.label}
                  <div className="tiny muted" style={{ marginTop: 3, lineHeight: 1.45 }}>{segment.note}</div>
                </td>
                <td className="display-num">{segment.formatted}</td>
                <td className="display-num">{segment.cumulativeFormatted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="notice notice-neutral" style={{ marginTop: 12 }}>{plan.bailOut.trigger}</div>

      <div className="row" style={{ marginTop: 12 }}>
        <span className="section-label">Finish</span>
        <span className="display-num" style={{ fontSize: 15 }}>
          {plan.finish.lowFormatted} – {plan.finish.highFormatted}
        </span>
      </div>

      {plan.goalComparison && (
        <div className="tiny muted" style={{ marginTop: 8, lineHeight: 1.5 }}>{plan.goalComparison.requirement}</div>
      )}
    </div>
  );
}

function LegRow({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="row">
        <span className="section-label">{label}</span>
        <span className="display-num" style={{ fontSize: 15 }}>{value}</span>
      </div>
      <div className="tiny muted" style={{ lineHeight: 1.5 }}>{note}</div>
    </div>
  );
}

function SplitsTable({ splits }: { splits: Split[] }) {
  return (
    <table>
      <thead>
        <tr><th>Split</th><th>Pace</th><th>Elapsed</th></tr>
      </thead>
      <tbody>
        {splits.map((split) => (
          <tr key={split.label}>
            <td>
              {split.label}
              <div className="tiny muted" style={{ marginTop: 3, lineHeight: 1.45 }}>{split.note}</div>
            </td>
            <td className="display-num">{split.paceFormatted}</td>
            <td className="display-num">{split.cumulativeFormatted}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
