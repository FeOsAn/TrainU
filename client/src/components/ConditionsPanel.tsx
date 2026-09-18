import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, todayStr } from "../lib/api";
import {
  BODY_PARTS,
  BODY_PART_LABELS,
  CONDITION_KINDS,
  CONDITION_KIND_LABELS,
  RESTRICTIONS,
  RESTRICTION_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  SUGGESTED_RESTRICTIONS,
  crossTrainingAvailability,
  isSuspended,
  type BodyPart,
  type Condition,
  type ConditionKind,
  type Restriction,
  type Severity,
} from "@shared/conditions";
import { EQUIPMENT_FIX_LABELS } from "@shared/prescription/adjustments/conditions";
import type { Goal } from "@shared/goal";

/** What a completion tick hands over when the athlete said injury or illness. */
export interface ConditionPrefill {
  kind: ConditionKind;
  label: string;
  note: string | null;
  openedAt: string;
}

/*
 * "Something hurts?" — one line until something actually does.
 *
 * DECISIONS C8: this is a single line on a healthy week, because a healthy
 * week is most weeks, and a permanently-open injury form above the sessions
 * is a daily reminder of nothing.
 */
export function ConditionsPanel({ prefill, onPrefillUsed }: { prefill?: ConditionPrefill | null; onPrefillUsed?: () => void }) {
  const queryClient = useQueryClient();
  const today = todayStr();
  const { data: conditions } = useQuery({ queryKey: ["conditions"], queryFn: api.conditions });
  const { data: goals } = useQuery({ queryKey: ["goals"], queryFn: api.goals });
  const { data: preferences } = useQuery({ queryKey: ["preferences"], queryFn: api.preferences });

  const [formOpen, setFormOpen] = useState(false);
  const [kind, setKind] = useState<ConditionKind>("injury");
  const [label, setLabel] = useState("");
  const [bodyPart, setBodyPart] = useState<BodyPart | "">("");
  const [severity, setSeverity] = useState<Severity>(2);
  const [restrictions, setRestrictions] = useState<Restriction[]>([]);

  // A completion ticked "because I was injured" opens this form already
  // filled in — the athlete has just told the app what happened, and asking
  // them to type it a second time is how a feature goes unused.
  useEffect(() => {
    if (!prefill) return;
    setKind(prefill.kind);
    setLabel(prefill.label);
    setFormOpen(true);
  }, [prefill]);

  const create = useMutation({
    mutationFn: () =>
      api.openCondition({
        kind,
        label: label.trim(),
        bodyPart: bodyPart === "" ? null : bodyPart,
        severity,
        // "none" is an explicit "this rules nothing out" — distinguishable
        // from "the form didn't say", which the server would read as none
        // anyway and then silently record an injury that forbids nothing.
        restrictions: restrictions.length ? restrictions : "none",
        openedAt: prefill?.openedAt ?? today,
        note: prefill?.note ?? null,
      }),
    onSuccess: () => {
      setFormOpen(false);
      setLabel("");
      setBodyPart("");
      setRestrictions([]);
      onPrefillUsed?.();
      queryClient.invalidateQueries({ queryKey: ["conditions"] });
      queryClient.invalidateQueries({ queryKey: ["week"] });
    },
  });

  const closeIt = useMutation({
    mutationFn: ({ id, closedAt }: { id: string; closedAt: string | null }) => api.closeCondition(id, closedAt),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conditions"] });
      queryClient.invalidateQueries({ queryKey: ["week"] });
    },
  });

  /*
   * "Still true" is an empty patch on purpose. `patchCondition` moves
   * `updatedAt`, and staleness is measured from `updatedAt` — so confirming
   * it changes nothing about the condition and everything about whether the
   * engine is allowed to keep acting on it.
   */
  const confirmStillTrue = useMutation({
    mutationFn: (id: string) => api.patchCondition(id, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conditions"] });
      queryClient.invalidateQueries({ queryKey: ["week"] });
    },
  });

  const live = (conditions ?? []).filter((c) => c.closedAt === null);
  const available = crossTrainingAvailability(goals ?? [], preferences?.features ?? { physiqueTracking: false, hasBike: false, hasPool: false }, today);

  // Both of these are load-bearing for the engine, not a nicety: with no bike
  // and no pool, every session an injury forbids becomes rest rather than a
  // swap, and the reason string tells the athlete to tick exactly this box.
  const equipment = useMutation({
    mutationFn: (patch: { hasBike?: boolean; hasPool?: boolean }) => api.patchFeatures(patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["preferences"] });
      queryClient.invalidateQueries({ queryKey: ["week"] });
    },
  });

  return (
    <div className="panel" style={{ padding: live.length || formOpen ? 16 : "12px 16px", marginBottom: 12 }}>
      <button className="line-toggle" onClick={() => setFormOpen(!formOpen)} aria-expanded={formOpen}>
        <span>
          <span className="section-label" style={{ marginRight: 10 }}>Something hurts?</span>
          <span className="muted" style={{ fontSize: 13 }}>
            {live.length === 0 ? "Nothing on record" : live.map((c) => c.label).join(", ")}
          </span>
        </span>
        <span className="muted tiny">{formOpen ? "Close" : "Tell the app"}</span>
      </button>

      {live.map((condition) => (
        <ConditionRow
          key={condition.id}
          condition={condition}
          today={today}
          onClose={() => closeIt.mutate({ id: condition.id, closedAt: todayStr() })}
          onStillTrue={() => confirmStillTrue.mutate(condition.id)}
          pending={closeIt.isPending || confirmStillTrue.isPending}
        />
      ))}

      {formOpen && (
        <div className="surface-2" style={{ marginTop: 12 }}>
          <div className="section-label" style={{ marginBottom: 6 }}>What is it</div>
          <div className="chip-row" style={{ marginBottom: 12 }}>
            {CONDITION_KINDS.map((k) => (
              <button key={k} className={`chip${kind === k ? " chip-on" : ""}`} onClick={() => setKind(k)}>
                {CONDITION_KIND_LABELS[k]}
              </button>
            ))}
          </div>

          <label>
            <span className="section-label">In your words</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === "injury" ? "Left calf strain" : "Head cold"} />
          </label>

          {kind === "injury" && (
            <label>
              <span className="section-label">Where</span>
              <select
                value={bodyPart}
                onChange={(e) => {
                  const next = e.target.value as BodyPart | "";
                  setBodyPart(next);
                  // A SUGGESTION, pre-ticked and fully editable. The engine
                  // never reads bodyPart — it acts on what was confirmed
                  // below, because a guess the athlete silently disagreed
                  // with would be steering their whole week.
                  if (next !== "") setRestrictions([...SUGGESTED_RESTRICTIONS[next]]);
                }}
              >
                <option value="">Not sure / somewhere else</option>
                {BODY_PARTS.map((part) => (
                  <option key={part} value={part}>{BODY_PART_LABELS[part]}</option>
                ))}
              </select>
            </label>
          )}

          <div className="section-label" style={{ marginBottom: 6 }}>How bad</div>
          <div style={{ marginBottom: 12 }}>
            {SEVERITIES.map((s) => (
              <label key={s} className="check-row">
                <input type="radio" name="severity" checked={severity === s} onChange={() => setSeverity(s)} />
                <span>{SEVERITY_LABELS[kind][s]}</span>
              </label>
            ))}
          </div>

          <div className="section-label" style={{ marginBottom: 6 }}>What it rules out</div>
          <div style={{ marginBottom: 12 }}>
            {RESTRICTIONS.map((r) => (
              <label key={r} className="check-row">
                <input
                  type="checkbox"
                  checked={restrictions.includes(r)}
                  onChange={(e) => setRestrictions(e.target.checked ? [...restrictions, r] : restrictions.filter((x) => x !== r))}
                />
                <span>{RESTRICTION_LABELS[r]}</span>
              </label>
            ))}
            <div className="tiny muted" style={{ lineHeight: 1.5 }}>
              This is the part the plan acts on. Leave it all unticked and it's on record without changing any sessions.
            </div>
          </div>

          <div className="section-label" style={{ marginBottom: 6 }}>What you can swap onto</div>
          <div style={{ marginBottom: 12 }}>
            <label className="check-row">
              <input type="checkbox" checked={available.bike} disabled={equipment.isPending} onChange={(e) => equipment.mutate({ hasBike: e.target.checked })} />
              <span>{EQUIPMENT_FIX_LABELS.bike}</span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={available.swim} disabled={equipment.isPending} onChange={(e) => equipment.mutate({ hasPool: e.target.checked })} />
              <span>{EQUIPMENT_FIX_LABELS.swim}</span>
            </label>
            <div className="tiny muted" style={{ lineHeight: 1.5 }}>
              Without one of these, a session your injury rules out becomes rest rather than a swap.
            </div>
          </div>

          {create.error && <div className="notice notice-danger">{(create.error as Error).message}</div>}

          <button className="btn-primary" disabled={!label.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Saving…" : "Save it"}
          </button>
        </div>
      )}
    </div>
  );
}

function ConditionRow({
  condition,
  today,
  onClose,
  onStillTrue,
  pending,
}: {
  condition: Condition;
  today: string;
  onClose: () => void;
  onStillTrue: () => void;
  pending: boolean;
}) {
  /*
   * DECISIONS C10: after 28 days with no edit a condition stops steering the
   * plan, and the app asks rather than deciding. It never closes one on its
   * own — it does not know that anyone healed, and guessing that they did
   * would put a still-injured athlete back on a full week.
   */
  const stale = isSuspended(condition, today);

  return (
    <div className="surface-2" style={{ marginTop: 10 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="stack" style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 14 }}>{condition.label}</strong>
          <span className="tiny muted">
            {CONDITION_KIND_LABELS[condition.kind]} · {SEVERITY_LABELS[condition.kind][condition.severity]} · since {condition.openedAt}
          </span>
        </div>
        <button className="chip chip-mini" disabled={pending} onClick={onClose}>Healed</button>
      </div>

      {condition.restrictions.length > 0 && (
        <div className="chip-row">
          {condition.restrictions.map((r) => (
            <span key={r} className="pill pill-seed">{RESTRICTION_LABELS[r]}</span>
          ))}
        </div>
      )}

      {stale && (
        <div className="notice notice-warn" style={{ marginTop: 10, marginBottom: 0 }}>
          You logged this a month ago and haven't touched it since, so the plan has stopped working around it.
          Is it still true?
          <div className="chip-row" style={{ marginTop: 8 }}>
            <button className="chip" disabled={pending} onClick={onStillTrue}>Still true</button>
            <button className="chip" disabled={pending} onClick={onClose}>All healed</button>
          </div>
        </div>
      )}
    </div>
  );
}
