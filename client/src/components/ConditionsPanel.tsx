import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, invalidateEngineAnswer, todayStr } from "../lib/api";
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
  type CrossTraining,
  type BodyPart,
  type Condition,
  type ConditionKind,
  type Restriction,
  type Severity,
} from "@shared/conditions";
import { EQUIPMENT_FIX_LABELS } from "@shared/prescription/adjustments/conditions";
import type { Goal } from "@shared/goal";
import { DEFAULT_FEATURE_PREFERENCES, type FeaturePreferences } from "@shared/preferences";

/** What a completion tick hands over when the athlete said injury or illness. */
export interface ConditionPrefill {
  kind: ConditionKind;
  label: string;
  note: string | null;
  openedAt: string;
}

/*
 * ─── What the two "what you can swap onto" boxes actually say ─────────────
 *
 * `crossTrainingAvailability` is an OR: a live triathlon or cycling goal
 * makes `bike` true whatever the athlete stored. The boxes were bound
 * `checked={available.bike}` and wrote `features.hasBike`, so for a
 * triathlete they READ a derived value and WROTE a raw one: untick it, the
 * preference goes false, the derived value stays true, and React puts the
 * tick straight back. The control moved and changed nothing — and the engine
 * kept prescribing rides to someone whose bike was in the shop, while the
 * substitution's own reason string told them to tick this very box.
 *
 * Read and write now denote the same thing. Where a GOAL is what makes it
 * true, the box says so in that goal's own words (never its discipline id —
 * DECISIONS C7) and is not the athlete's to untick here; where it is their
 * own answer, it is exactly their own answer.
 *
 * A fuller fix — an explicit "no" that OVERRIDES the goal — needs
 * `FeaturePreferences.hasBike/hasPool` to become tri-state (`true` / `false`
 * / `null` = "let my goals decide", the shape `BlockPreferences` already
 * uses), because today a stored `false` is indistinguishable from "never
 * answered". That is a change to `shared/preferences.ts`,
 * `shared/conditions.ts` and the PATCH validator, which this pass does not
 * own; see the report.
 */
export interface EquipmentChoice {
  /** What the engine will do — the shared rule's own answer, not a second copy of it. */
  checked: boolean;
  /** The live goal that makes it true, in the athlete's words, or null when the answer is theirs. */
  impliedBy: string | null;
}

/**
 * Asked per goal, through the SAME shared rule, so neither the discipline
 * predicate nor the "a past goal proves nothing" rule is re-spelled here.
 *
 * The athlete's own answers are reset to the DEFAULTS rather than to a
 * hard-coded `false`, so if `hasBike`/`hasPool` ever become tri-state
 * (`true` / `false` / `null` = "let my goals decide" — see the note above)
 * this keeps asking what it means to ask: what would be true of someone who
 * had never answered?
 */
function goalImplying(goals: Goal[], features: FeaturePreferences, today: string, need: keyof CrossTraining): string | null {
  const unanswered: FeaturePreferences = {
    ...features,
    hasBike: DEFAULT_FEATURE_PREFERENCES.hasBike,
    hasPool: DEFAULT_FEATURE_PREFERENCES.hasPool,
  };
  return goals.find((goal) => crossTrainingAvailability([goal], unanswered, today)[need])?.label ?? null;
}

export function equipmentChoices(
  goals: Goal[],
  features: FeaturePreferences,
  today: string,
): Record<keyof CrossTraining, EquipmentChoice> {
  const resolved = crossTrainingAvailability(goals, features, today);
  return {
    bike: { checked: resolved.bike, impliedBy: goalImplying(goals, features, today, "bike") },
    swim: { checked: resolved.swim, impliedBy: goalImplying(goals, features, today, "swim") },
  };
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

  /*
   * ONE list, three mutations.
   *
   * Opening an injury used to refetch `["conditions"]` and `["week"]` and not
   * `["plan"]` — so the sessions turned to rest and the nutrition tile flipped
   * Deficit → Maintenance while "Tradeoffs being made", which is fed only by
   * `["plan"]`, went on showing the pre-injury list. The DECISIONS B5 sentence
   * that EXPLAINS the flip ("your cut is paused while … is open") never
   * reached the screen until a reload. Closing one had the mirror bug: the
   * deficit resumed while the panel still blamed a healed condition.
   *
   * `invalidateEngineAnswer` owns the week/plan pair (see lib/api.ts) so the
   * three lists here cannot drift apart again.
   */
  const invalidate = () => invalidateEngineAnswer(queryClient, ["conditions"]);

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
      invalidate();
    },
  });

  const closeIt = useMutation({
    mutationFn: ({ id, closedAt }: { id: string; closedAt: string | null }) => api.closeCondition(id, closedAt),
    onSuccess: invalidate,
  });

  /*
   * "Still true" is an empty patch on purpose. `patchCondition` moves
   * `updatedAt`, and staleness is measured from `updatedAt` — so confirming
   * it changes nothing about the condition and everything about whether the
   * engine is allowed to keep acting on it.
   */
  const confirmStillTrue = useMutation({
    mutationFn: (id: string) => api.patchCondition(id, {}),
    onSuccess: invalidate,
  });

  const live = (conditions ?? []).filter((c) => c.closedAt === null);
  const equipmentBoxes = equipmentChoices(goals ?? [], preferences?.features ?? DEFAULT_FEATURE_PREFERENCES, today);

  // Both of these are load-bearing for the engine, not a nicety: with no bike
  // and no pool, every session an injury forbids becomes rest rather than a
  // swap, and the reason string tells the athlete to tick exactly this box.
  const equipment = useMutation({
    mutationFn: (patch: { hasBike?: boolean; hasPool?: boolean }) => api.patchFeatures(patch),
    onSuccess: () => invalidateEngineAnswer(queryClient, ["preferences"]),
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
            <EquipmentBox
              choice={equipmentBoxes.bike}
              label={EQUIPMENT_FIX_LABELS.bike}
              pending={equipment.isPending}
              onChange={(checked) => equipment.mutate({ hasBike: checked })}
            />
            <EquipmentBox
              choice={equipmentBoxes.swim}
              label={EQUIPMENT_FIX_LABELS.swim}
              pending={equipment.isPending}
              onChange={(checked) => equipment.mutate({ hasPool: checked })}
            />
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

function EquipmentBox({
  choice,
  label,
  pending,
  onChange,
}: {
  choice: EquipmentChoice;
  label: string;
  pending: boolean;
  onChange: (checked: boolean) => void;
}) {
  const locked = choice.impliedBy !== null;
  return (
    <>
      <label className="check-row">
        <input
          type="checkbox"
          checked={choice.checked}
          // Not "greyed out for neatness": a box that springs back when you
          // tap it is a worse answer than one that says who is holding it.
          disabled={pending || locked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{label}</span>
      </label>
      {locked && (
        <div className="tiny muted" style={{ marginBottom: 6, lineHeight: 1.5 }}>
          “{choice.impliedBy}” already assumes it, so the plan works on that — change the goal to change this.
        </div>
      )}
    </>
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
