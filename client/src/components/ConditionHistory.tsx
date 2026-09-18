import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, todayStr } from "../lib/api";
import { CONDITION_KIND_LABELS, RESTRICTION_LABELS, SEVERITY_LABELS, daysOff, rampStageOn } from "@shared/conditions";

/**
 * Everything logged, healed or not — the Plan page's panel is for the one
 * that is happening now.
 *
 * Closed rows stay because they are still steering the week: the
 * return-to-training ramp reads `closedAt`, so a strain that healed last
 * Tuesday is why this week's ceiling is where it is. And reopening one has to
 * be reachable, because "healed" ticked three days early is the normal
 * mistake, not a rare one.
 */
export function ConditionHistory() {
  const queryClient = useQueryClient();
  const today = todayStr();
  const { data: conditions } = useQuery({ queryKey: ["conditions"], queryFn: api.conditions });

  const reopen = useMutation({
    mutationFn: (id: string) => api.closeCondition(id, null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conditions"] });
      queryClient.invalidateQueries({ queryKey: ["week"] });
    },
  });

  if (!conditions || conditions.length === 0) {
    return <div className="tiny muted">Nothing logged. Report an injury or an illness from the plan and the week works around it.</div>;
  }

  return (
    <>
      {reopen.error && <div className="notice notice-danger">{(reopen.error as Error).message}</div>}
      {conditions.map((condition) => {
        const ramp = condition.closedAt ? rampStageOn(condition, today) : null;
        return (
          <div key={condition.id} className="surface-2" style={{ marginBottom: 8 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <div className="stack" style={{ minWidth: 0 }}>
                <strong style={{ fontSize: 14 }}>{condition.label}</strong>
                <span className="tiny muted">
                  {CONDITION_KIND_LABELS[condition.kind]} · {SEVERITY_LABELS[condition.kind][condition.severity]}
                </span>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <span className={`pill ${condition.closedAt ? "pill-verified" : "pill-seed"}`}>
                  {condition.closedAt ? "healed" : "open"}
                </span>
              </div>
            </div>

            <div className="tiny muted" style={{ marginBottom: 6 }}>
              {condition.openedAt} → {condition.closedAt ?? "still going"}
              {condition.closedAt && <> · {daysOff(condition)} days lost</>}
            </div>

            {condition.restrictions.length > 0 && (
              <div className="chip-row" style={{ marginBottom: 6 }}>
                {condition.restrictions.map((r) => (
                  <span key={r} className="pill pill-neutral">{RESTRICTION_LABELS[r]}</span>
                ))}
              </div>
            )}

            {/* Named dates, not a vague "ease back in" — the ramp knows exactly when steady and full training return. */}
            {ramp && (
              <div className="tiny muted" style={{ lineHeight: 1.5, marginBottom: 6 }}>
                Building back up: {ramp.stage.label}. Steady work from {ramp.thresholdFrom}, everything from {ramp.fullFrom}.
              </div>
            )}

            {condition.note && <div className="tiny muted" style={{ lineHeight: 1.5, marginBottom: 6 }}>{condition.note}</div>}

            {condition.closedAt && (
              <button className="chip chip-mini" disabled={reopen.isPending} onClick={() => reopen.mutate(condition.id)}>
                Actually, it's back
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}
