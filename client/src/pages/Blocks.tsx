import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BlockChoiceRow } from "../lib/api";
import DeleteApp from "../components/DeleteApp";

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
        <h1 className="display">What's in it, and what isn't</h1>
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
            <div key={row.id} className="surface-2 block-row">
              <div className="row">
                <div className="stack" style={{ minWidth: 0, gap: 3 }}>
                  <strong>{row.title}</strong>
                  <span className="tiny muted">
                    {choiceLabel(row)}
                    {row.overridden ? " · your choice, not your goals'" : ""}
                  </span>
                </div>
                {row.status === "planned" && <span className="pill pill-seed">not built</span>}
              </div>

              {row.note && (
                <div className="tiny muted" style={{ marginTop: 8, lineHeight: 1.5 }}>
                  {row.note}
                </div>
              )}

              {/* Their own row, and chips rather than buttons: three controls and a
                  title do not fit on one line at phone width, and "Let my goals
                  decide" is the longest and the most important to keep readable. */}
              <div className="chip-row" style={{ marginTop: 10 }}>
                {([
                  ["on", "On"],
                  ["off", "Off"],
                  [null, "Let my goals decide"],
                ] as const).map(([choice, label]) => (
                  <button
                    key={label}
                    className={`chip chip-mini${row.choice === choice ? " chip-on" : ""}`}
                    disabled={patch.isPending || row.choice === choice}
                    onClick={() => patch.mutate({ [row.id]: choice })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}

      <DeleteApp />
    </div>
  );
}
