import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, todayStr } from "../lib/api";
import { Sparkline } from "./Sparkline";
import {
  PHYSIQUE_BOUNDS,
  PHYSIQUE_METRICS,
  PHYSIQUE_METRIC_LABELS,
  PHYSIQUE_METRIC_UNITS,
  weightChangeWarning,
  type PhysiqueMetric,
} from "@shared/physique";

/**
 * Weigh-ins, and what they add up to.
 *
 * Entries fold into the athlete's numbers at READ time, so a delete or a
 * back-dated correction simply works — nothing here writes an athlete row.
 */
export function PhysiquePanel() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["physique"], queryFn: () => api.physique() });

  const [date, setDate] = useState(todayStr());
  const [values, setValues] = useState<Partial<Record<PhysiqueMetric, string>>>({});
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["physique"] });
    // The fold is at read time, so the athlete's numbers and the whole plan
    // move with a weigh-in — both have to be refetched, not just this panel.
    queryClient.invalidateQueries({ queryKey: ["athlete"] });
    queryClient.invalidateQueries({ queryKey: ["week"] });
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
    onSuccess: () => {
      setValues({});
      setNote("");
      setConfirm(null);
      setProblem(null);
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (entryDate: string) => api.deletePhysique(entryDate),
    onSuccess: invalidate,
  });

  const entries = data?.entries ?? [];
  const previous = entries.length ? entries[entries.length - 1]! : null;

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
    const warning = weightChangeWarning(weight, previous);
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
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label style={{ marginBottom: 0 }}>
          <span className="section-label">Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="first thing, after the bathroom" />
        </label>
      </div>

      {problem && <div className="notice notice-warn">{problem}</div>}
      {confirm && <div className="notice notice-warn">{confirm}</div>}
      {save.error && <div className="notice notice-danger">{(save.error as Error).message}</div>}
      {remove.error && <div className="notice notice-danger">{(remove.error as Error).message}</div>}

      <button className="btn-primary" disabled={save.isPending} onClick={attemptSave}>
        {save.isPending ? "Saving…" : confirm ? "Save it anyway" : "Log it"}
      </button>

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
