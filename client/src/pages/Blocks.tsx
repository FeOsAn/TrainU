import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BlockChoiceRow } from "../lib/api";

/**
 * What's in your app, and your say over it.
 *
 * The assembler infers a sensible default from the goal model, and that
 * default is right most of the time — but "most of the time" can't be the
 * only mechanism. A runner who also rides wants their FTP tracked; someone
 * on a cut who finds progress photos miserable wants that gone entirely.
 * Neither is expressible as a goal, so both need a switch.
 */
const SURFACE_TITLES: Record<string, string> = {
  plan: "Plan",
  athlete: "Athlete",
  data: "Data",
  goals: "Goals",
  coach: "Coach",
};

function choiceLabel(row: BlockChoiceRow): string {
  if (row.choice === "on") return "always on";
  if (row.choice === "off") return "off";
  return row.active ? "on — from your goals" : "off — not implied by your goals";
}

export default function Blocks() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["block-choices"], queryFn: api.blockChoices });

  const patch = useMutation({
    mutationFn: (p: Record<string, "on" | "off" | null>) => api.patchBlocks(p),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["block-choices"] });
      queryClient.invalidateQueries({ queryKey: ["app-shell"] });
    },
  });

  const bySurface = new Map<string, BlockChoiceRow[]>();
  for (const row of data?.blocks ?? []) {
    if (!bySurface.has(row.surface)) bySurface.set(row.surface, []);
    bySurface.get(row.surface)!.push(row);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="kicker">Your app</div>
        <h1>What's in it, and what isn't</h1>
      </div>

      <div className="notice notice-neutral">
        Your app is assembled from your goals — a triathlon puts bike and swim numbers in, a marathon
        leaves them out. That's a default, not a verdict: switch anything on or off here, and{" "}
        <strong>let my goals decide</strong> hands it back.
      </div>

      {isLoading && <div className="panel"><div className="skeleton" style={{ width: "45%" }} /></div>}
      {patch.error && <div className="notice notice-danger">{(patch.error as Error).message}</div>}

      {[...bySurface.entries()].map(([surface, rows]) => (
        <div key={surface} className="panel">
          <div className="section-label" style={{ marginBottom: 10 }}>
            {SURFACE_TITLES[surface] ?? surface}
          </div>
          {rows.map((row) => (
            <div key={row.id} className="surface-2" style={{ marginBottom: 8 }}>
              <div className="row">
                <div className="stack" style={{ minWidth: 0 }}>
                  <strong>{row.title}</strong>
                  <span className="tiny muted" style={{ marginTop: 3 }}>
                    {choiceLabel(row)}
                    {row.overridden ? " · your choice, not your goals'" : ""}
                  </span>
                </div>
                <div style={{ flexShrink: 0, display: "flex", gap: 6 }}>
                  {row.status === "planned" && <span className="pill pill-seed">not built</span>}
                  <button
                    className="btn-ghost"
                    style={{ padding: "4px 9px", fontSize: 11 }}
                    disabled={patch.isPending || row.choice === "on"}
                    onClick={() => patch.mutate({ [row.id]: "on" })}
                  >
                    On
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ padding: "4px 9px", fontSize: 11 }}
                    disabled={patch.isPending || row.choice === "off"}
                    onClick={() => patch.mutate({ [row.id]: "off" })}
                  >
                    Off
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ padding: "4px 9px", fontSize: 11 }}
                    disabled={patch.isPending || row.choice === null}
                    onClick={() => patch.mutate({ [row.id]: null })}
                  >
                    Let my goals decide
                  </button>
                </div>
              </div>
              {row.note && (
                <div className="tiny muted" style={{ marginTop: 6, lineHeight: 1.45 }}>
                  {row.note}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
