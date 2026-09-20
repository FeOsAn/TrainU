import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, invalidateEngineAnswer, todayStr } from "../lib/api";
import { Sparkline } from "./Sparkline";
import {
  PHYSIQUE_BOUNDS,
  PHYSIQUE_METRICS,
  PHYSIQUE_METRIC_LABELS,
  PHYSIQUE_METRIC_UNITS,
  weightChangeWarning,
  type PhysiqueEntry,
  type PhysiqueMetric,
} from "@shared/physique";
import type { Goal } from "@shared/goal";

/**
 * The weigh-in this one is judged against: the latest entry STRICTLY BEFORE
 * the chosen date.
 *
 * It used to be `entries[entries.length - 1]` — the newest weigh-in in the
 * whole history — while the date field above it is free, and this panel
 * advertises back-dating. So back-dating a forgotten 81.9 kg from January,
 * against a March history of 78 kg, told an athlete mid-cut they had gained
 * 3.9 kg; and back-dating a typo'd 77.5 kg where 82.5 was meant raised
 * nothing at all, because it is close to March's 78. Same-date is excluded
 * on purpose: correcting a day is judged against the day BEFORE it, not
 * against the value being replaced.
 *
 * This is `physiqueSaveWarning`'s rule (server/physiqueService.ts), spelled
 * the same way, so the question the client asks is the question the server
 * would have asked.
 */
export function entryBefore(entries: PhysiqueEntry[], date: string): PhysiqueEntry | null {
  // `listPhysiqueEntries` sorts oldest-first, so the last match is the latest.
  return entries.filter((e) => e.date < date).at(-1) ?? null;
}

/**
 * The server's own warning, reworded for a row that is already committed.
 *
 * `physiqueSaveWarning` answers the same question against what is actually
 * STORED, and the panel was throwing its answer away: `onSuccess` never
 * looked at `save.data`. So the only warning an athlete ever saw was the
 * client's — and when the two disagreed (which is precisely when it matters,
 * because the client was comparing against the wrong entry) the correct one
 * was the one discarded.
 *
 * "Save it anyway?" is the wrong question once it is saved, so the question
 * becomes a flag pointing at the Delete control below it.
 */
export function savedNotice(warning: string | null): string | null {
  if (!warning) return null;
  return `Saved. ${warning.replace(" Save it anyway?", "")} Delete it below if that was a typo.`;
}

/**
 * Weigh-ins, and what they add up to.
 *
 * Entries fold into the athlete's numbers at READ time, so a delete or a
 * back-dated correction simply works — nothing here writes an athlete row.
 */
export function PhysiquePanel() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["physique"], queryFn: () => api.physique() });
  /*
   * ── The verdict, which nothing could ask for until now ─────────────────
   *
   * `GET /api/physique/progress`, `progressVsGoal` and `PhysiqueProgress`
   * (whose `statusLabel` exists precisely so a screen never maps an id) were
   * all built, tested and unreachable: `api.physiqueProgress` had exactly one
   * occurrence in the whole client — its own declaration. Meanwhile the
   * block's note promises "against what your goal actually needs", and that
   * clause is the part only this endpoint computes. The Phase 8 archetype:
   * a complete capability with nothing able to request it.
   *
   * Filtered to live body-composition goals because the route 400s any other
   * type and 404s an unknown id — an unfiltered loop would turn a HYROX
   * athlete's page into error cards. "Physique tracking on, no
   * body-composition goal" is a normal state: trends, and nothing more.
   */
  const { data: goals } = useQuery({ queryKey: ["goals"], queryFn: api.goals });
  const weightGoals = (goals ?? []).filter((g) => g.active && g.type === "body_composition");

  const [date, setDate] = useState(todayStr());
  const [values, setValues] = useState<Partial<Record<PhysiqueMetric, string>>>({});
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  /** What the SERVER said about the weigh-in it just committed, if anything. */
  const [saved, setSaved] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const invalidate = () => {
    // The fold is at read time, so the athlete's numbers and the whole plan
    // move with a weigh-in — all of them have to be refetched, not just this
    // panel. `["physique"]` is a PREFIX, so it also covers each goal's
    // `["physique", "progress", id]`: a deleted weigh-in moves the verdict
    // exactly as much as a saved one does.
    invalidateEngineAnswer(queryClient, ["physique"], ["athlete"]);
  };

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { date };
      for (const metric of PHYSIQUE_METRICS) {
        const raw = values[metric];
        if (raw === undefined || raw.trim() === "") continue;
        body[metric] = parseFloat(raw);
      }
      if (note.trim()) body.note = note.trim();
      return api.savePhysique(body as never);
    },
    onSuccess: (result) => {
      setValues({});
      setNote("");
      setConfirm(null);
      setProblem(null);
      /*
       * The server answers the same question against what is actually
       * stored, and it was being dropped on the floor. The row is already
       * committed by now, so this is a flag next to the entry rather than a
       * question — the athlete can delete it if it was a typo.
       */
      setSaved(result.warning);
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (entryDate: string) => api.deletePhysique(entryDate),
    onSuccess: invalidate,
  });

  const entries = data?.entries ?? [];

  const attemptSave = () => {
    /*
     * Out of bounds is NOT a "save it anyway?" question.
     *
     * The confirmation exists for a plausible-but-surprising number — 4 kg
     * down since Tuesday is usually a typo and occasionally a bad week, so
     * the athlete gets to look at it. A weight of 400 kg is neither: offering
     * to save it anyway promises something the server will refuse a moment
     * later. Bounds first, then the delta question.
     */
    for (const metric of PHYSIQUE_METRICS) {
      const raw = values[metric];
      if (raw === undefined || raw.trim() === "") continue;
      const value = parseFloat(raw);
      const [min, max] = PHYSIQUE_BOUNDS[metric];
      if (!Number.isFinite(value) || value < min || value > max) {
        setProblem(`${PHYSIQUE_METRIC_LABELS[metric]} has to be between ${min} and ${max} ${PHYSIQUE_METRIC_UNITS[metric]}.`);
        setConfirm(null);
        return;
      }
    }
    setProblem(null);

    const weightRaw = values.weightKg;
    const weight = weightRaw && weightRaw.trim() !== "" ? parseFloat(weightRaw) : null;
    // ONE rule for "is that a typo?", the one the module exports — a second
    // threshold invented here would eventually disagree with the server's.
    const warning = weightChangeWarning(weight, entryBefore(entries, date));
    if (warning && confirm !== warning) {
      setConfirm(warning);
      return;
    }
    save.mutate();
  };

  return (
    <>
      <div className="grid grid-3" style={{ marginBottom: 12 }}>
        {PHYSIQUE_METRICS.map((metric) => (
          <label key={metric} style={{ marginBottom: 0 }}>
            <span className="section-label">{PHYSIQUE_METRIC_LABELS[metric]} ({PHYSIQUE_METRIC_UNITS[metric]})</span>
            <input
              type="number"
              step="any"
              value={values[metric] ?? ""}
              onChange={(e) => {
                setValues({ ...values, [metric]: e.target.value });
                setConfirm(null);
                setProblem(null);
              }}
            />
          </label>
        ))}
      </div>

      <div className="grid grid-2" style={{ marginBottom: 12 }}>
        <label style={{ marginBottom: 0 }}>
          <span className="section-label">Date</span>
          {/* Changing the date changes the baseline, so a confirmation given
            * for a different day is no longer an answer to anything. */}
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setConfirm(null);
              setProblem(null);
            }}
          />
        </label>
        <label style={{ marginBottom: 0 }}>
          <span className="section-label">Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="first thing, after the bathroom" />
        </label>
      </div>

      {problem && <div className="notice notice-warn">{problem}</div>}
      {savedNotice(saved) && <div className="notice notice-warn">{savedNotice(saved)}</div>}
      {confirm && <div className="notice notice-warn">{confirm}</div>}
      {save.error && <div className="notice notice-danger">{(save.error as Error).message}</div>}
      {remove.error && <div className="notice notice-danger">{(remove.error as Error).message}</div>}

      <button className="btn-primary" disabled={save.isPending} onClick={attemptSave}>
        {save.isPending ? "Saving…" : confirm ? "Save it anyway" : "Log it"}
      </button>

      {weightGoals.map((goal) => (
        <GoalProgressCard key={goal.id} goal={goal} />
      ))}

      {PHYSIQUE_METRICS.map((metric) => {
        const trend = data?.trend?.[metric];
        if (!trend) return null;
        return (
          <div key={metric} className="surface-2" style={{ marginTop: 12 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <div className="stack">
                <span className="section-label">{PHYSIQUE_METRIC_LABELS[metric]}</span>
                <span className="tiny muted">
                  {trend.samples} entries over {trend.spanDays} days · {trend.change > 0 ? "+" : ""}
                  {Math.round(trend.change * 10) / 10} {PHYSIQUE_METRIC_UNITS[metric]}
                </span>
              </div>
              <div style={{ textAlign: "right" }}>
                {/*
                 * `null` is "not enough yet", never 0. Rendering a missing
                 * rate as zero tells someone mid-cut that they have stalled
                 * when what actually happened is that they have weighed in
                 * twice.
                 */}
                {trend.changePerWeek === null ? (
                  <span className="tiny muted">not enough yet</span>
                ) : (
                  <>
                    <div className="display-num" style={{ fontSize: 16 }}>
                      {trend.changePerWeek > 0 ? "+" : ""}
                      {Math.round(trend.changePerWeek * 100) / 100}
                    </div>
                    <div className="tiny muted">{PHYSIQUE_METRIC_UNITS[metric]} / week</div>
                  </>
                )}
              </div>
            </div>
            <Sparkline points={trend.series} />
          </div>
        );
      })}

      {entries.length > 0 && (
        <>
          <div className="divider" />
          {[...entries].reverse().map((entry) => (
            <div key={entry.id} className="row tiny" style={{ marginBottom: 8 }}>
              <span className="display-num">{entry.date}</span>
              <span className="muted" style={{ flex: 1, textAlign: "right" }}>
                {PHYSIQUE_METRICS.filter((m) => entry[m] !== null)
                  .map((m) => `${entry[m]} ${PHYSIQUE_METRIC_UNITS[m]}`)
                  .join(" · ")}
                {entry.note ? ` · ${entry.note}` : ""}
              </span>
              <button className="chip chip-mini" disabled={remove.isPending} onClick={() => remove.mutate(entry.date)}>
                Delete
              </button>
            </div>
          ))}
        </>
      )}
    </>
  );
}

/**
 * Where one body-composition goal stands, in the module's own words.
 *
 * `statusLabel` and `summary` are rendered as given: the type's doc comments
 * say the caller never maps a status id itself (DECISIONS C7), and a second
 * sentence assembled in TSX is how the wording drifts from the module that
 * computed the verdict. `unknown` is shown rather than hidden — "no target
 * weight on this goal" and "that date has passed" are things the athlete can
 * act on, and silence about them would be the same defect one level down.
 */
function GoalProgressCard({ goal }: { goal: Goal }) {
  // Prefixed with ["physique"], so the panel's own invalidate() covers it.
  const { data: progress, error } = useQuery({
    queryKey: ["physique", "progress", goal.id],
    queryFn: () => api.physiqueProgress(goal.id),
  });
  if (error || !progress) return null;

  return (
    <div className="surface-2" style={{ marginTop: 12 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="stack" style={{ minWidth: 0 }}>
          <span className="section-label">{goal.label}</span>
          <strong style={{ fontSize: 14 }}>{progress.statusLabel}</strong>
        </div>
        {progress.observedWeeklyChangeKg !== null && (
          <div style={{ textAlign: "right" }}>
            <div className="display-num" style={{ fontSize: 16 }}>
              {progress.observedWeeklyChangeKg > 0 ? "+" : ""}
              {Math.round(progress.observedWeeklyChangeKg * 100) / 100}
            </div>
            <div className="tiny muted">kg / week</div>
          </div>
        )}
      </div>
      <div className="tiny muted" style={{ lineHeight: 1.55 }}>{progress.summary}</div>
    </div>
  );
}
