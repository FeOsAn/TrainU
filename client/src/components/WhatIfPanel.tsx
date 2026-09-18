import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Goal } from "@shared/goal";
import { MAX_PRIORITY, WHAT_IF_OP_LABELS, type GoalPatch, type WhatIfOp } from "@shared/arbitration/whatIf";

/** Wider than this and the control stops being a nudge; the endpoint still allows ±52 for scripting. */
const SHIFT_LIMIT_WEEKS = 12;

/**
 * "What if I moved the race?"
 *
 * Three controls, one at a time, one patch per request — the honest surface
 * for a question that is really "does this still work". The summary lines ARE
 * the product: most athletes read those and nothing else, which is why there
 * is no spans table under them.
 */
export function WhatIfPanel({ goal }: { goal: Goal }) {
  const [op, setOp] = useState<WhatIfOp>("shift");
  const [byWeeks, setByWeeks] = useState(0);
  const [priority, setPriority] = useState(goal.priority);

  // Debounced so dragging the slider does not fire an arbitration per pixel;
  // each answer is up to 105 weeks of plan on both sides.
  const [settled, setSettled] = useState({ op, byWeeks, priority });
  useEffect(() => {
    const timer = setTimeout(() => setSettled({ op, byWeeks, priority }), 250);
    return () => clearTimeout(timer);
  }, [op, byWeeks, priority]);

  const patch = useMemo<GoalPatch | null>(() => {
    if (settled.op === "remove") return { op: "remove", goalId: goal.id };
    if (settled.op === "reprioritise") {
      return settled.priority === goal.priority ? null : { op: "reprioritise", goalId: goal.id, priority: settled.priority };
    }
    return settled.byWeeks === 0 ? null : { op: "shift", goalId: goal.id, byWeeks: settled.byWeeks };
  }, [settled, goal.id, goal.priority]);

  const { data, error, isFetching } = useQuery({
    queryKey: ["what-if", goal.id, patch],
    queryFn: () => api.whatIf({ patch: patch! }),
    enabled: patch !== null,
    placeholderData: keepPreviousData,
  });

  return (
    <div className="surface-2" style={{ marginTop: 12 }}>
      <div className="chip-row" style={{ marginBottom: 12 }}>
        {(Object.keys(WHAT_IF_OP_LABELS) as WhatIfOp[]).map((option) => (
          <button key={option} className={`chip${op === option ? " chip-on" : ""}`} onClick={() => setOp(option)}>
            {WHAT_IF_OP_LABELS[option]}
          </button>
        ))}
      </div>

      {op === "shift" && (
        <label style={{ marginBottom: 12 }}>
          <span className="section-label">
            {byWeeks === 0 ? "Leave it where it is" : byWeeks > 0 ? `${byWeeks} weeks later` : `${-byWeeks} weeks earlier`}
          </span>
          <input
            type="range"
            min={-SHIFT_LIMIT_WEEKS}
            max={SHIFT_LIMIT_WEEKS}
            step={1}
            value={byWeeks}
            onChange={(e) => setByWeeks(parseInt(e.target.value, 10))}
          />
        </label>
      )}

      {op === "reprioritise" && (
        <label style={{ marginBottom: 12 }}>
          <span className="section-label">Priority (1 outranks 2)</span>
          <input
            type="number"
            min={1}
            max={MAX_PRIORITY}
            value={priority}
            onChange={(e) => setPriority(Math.max(1, Math.min(MAX_PRIORITY, parseInt(e.target.value, 10) || 1)))}
          />
        </label>
      )}

      {op === "remove" && (
        <div className="tiny muted" style={{ marginBottom: 12, lineHeight: 1.5 }}>
          What the other goals' weeks would look like without this one in the mix.
        </div>
      )}

      {error && <div className="notice notice-danger">{(error as Error).message}</div>}
      {patch === null && <div className="tiny muted">Move the control to see what changes.</div>}

      {data && patch !== null && (
        <div style={{ opacity: isFetching ? 0.6 : 1 }}>
          {data.caveats.map((caveat, i) => (
            <div key={i} className="notice notice-warn">{caveat}</div>
          ))}

          {/* The headline list. Everything else on this panel is context for it. */}
          {data.summary.map((line, i) => (
            <div key={i} className="tiny" style={{ lineHeight: 1.6, marginBottom: 7 }}>{line}</div>
          ))}

          <div className="row tiny muted" style={{ marginTop: 10 }}>
            <span>{data.fromDate} → {data.toDate}</span>
            <span>{data.diff.changedWeekCount} of {data.diff.weekCount} weeks change</span>
          </div>

          {/*
           * Required footer. Without it the after-plan reads as a promise: it
           * is arbitration alone, before any of the day-to-day modulation an
           * injury, a bad morning or a load ceiling would apply on top — and
           * none of it is saved.
           */}
          <div className="tiny muted" style={{ marginTop: 10, lineHeight: 1.5 }}>
            This is what the goals would ask for, before anything the app does day to day about how you're
            actually feeling or what's injured. Nothing here has been saved.
          </div>
        </div>
      )}
    </div>
  );
}
