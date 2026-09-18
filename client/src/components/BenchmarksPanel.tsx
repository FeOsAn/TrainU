import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BenchmarkView } from "../lib/api";
import { formatBenchmarkSeconds, parseBenchmarkInput } from "@shared/predictors/hyroxStations";

/**
 * The eight HYROX stations in race order, then the roxzone.
 *
 * Declared `planned` through Phase 8 because nothing entered them: the
 * predictor could read a real sled-push time and no screen could write one,
 * so every HYROX athlete was quietly predicted off eight seeds. This is the
 * screen that makes "built" true.
 *
 * Input goes through `parseBenchmarkInput` and output through
 * `formatBenchmarkSeconds` — the same pair the format hint promises. A second
 * parser here would accept things the hint never offered, or reject things it
 * did.
 */
export function BenchmarksPanel() {
  const queryClient = useQueryClient();
  const { data: rows } = useQuery({ queryKey: ["benchmarks"], queryFn: api.benchmarks });

  const patch = useMutation({
    mutationFn: (body: Parameters<typeof api.patchBenchmarks>[0]) => api.patchBenchmarks(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["benchmarks"] });
      // A station time moves the HYROX prediction and its confidence band.
      queryClient.invalidateQueries({ queryKey: ["athlete"] });
      queryClient.invalidateQueries({ queryKey: ["week"] });
    },
  });

  if (!rows) return <div className="skeleton" style={{ width: "50%" }} />;

  return (
    <>
      {patch.error && <div className="notice notice-danger">{(patch.error as Error).message}</div>}
      {rows.map((row) => (
        <BenchmarkRow
          key={row.id}
          row={row}
          pending={patch.isPending}
          onSave={(seconds) => patch.mutate({ [row.id]: seconds })}
        />
      ))}
    </>
  );
}

function BenchmarkRow({ row, onSave, pending }: { row: BenchmarkView; onSave: (seconds: number | null) => void; pending: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.display);
  const [problem, setProblem] = useState<string | null>(null);

  const commit = () => {
    const seconds = parseBenchmarkInput(draft);
    if (seconds === null) {
      setProblem(row.formatHint);
      return;
    }
    const [min, max] = row.bounds;
    if (seconds < min || seconds > max) {
      // Said before the request rather than after the rejection — the bounds
      // are on the row precisely so the form can be the one to explain.
      setProblem(`That has to be between ${formatBenchmarkSeconds(min)} and ${formatBenchmarkSeconds(max)}.`);
      return;
    }
    setProblem(null);
    setEditing(false);
    onSave(seconds);
  };

  return (
    <div className="surface-2" style={{ marginBottom: 8 }}>
      <div className="row">
        <div className="stack" style={{ minWidth: 0 }}>
          <span className="tiny muted">{row.label}</span>
          {editing ? (
            <input
              autoFocus
              value={draft}
              placeholder={row.formatHint}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") { setEditing(false); setProblem(null); }
              }}
              style={{ marginTop: 3 }}
            />
          ) : (
            <span className="display-num" style={{ fontSize: 17 }}>{row.display}</span>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <span className={`pill ${row.value.verified ? "pill-verified" : "pill-seed"}`}>{row.value.verified ? "measured" : "seed"}</span>
          {!editing && (
            <button className="chip chip-mini" style={{ marginLeft: 6 }} disabled={pending} onClick={() => { setDraft(row.display); setEditing(true); }}>
              Edit
            </button>
          )}
          {/* Clearing back to the seed is the recovery path for an in-bounds typo — there is no per-benchmark history to roll back to. */}
          {!editing && row.value.verified && (
            <button className="chip chip-mini" style={{ marginLeft: 6 }} disabled={pending} onClick={() => onSave(null)}>
              Clear
            </button>
          )}
        </div>
      </div>
      {problem && <div className="tiny" style={{ color: "var(--warn)", marginTop: 6 }}>{problem}</div>}
      <div className="tiny muted" style={{ marginTop: 6, lineHeight: 1.45 }}>
        {row.value.source} · {row.hint}
      </div>
    </div>
  );
}
