import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, todayStr, type CheckInRecord } from "../lib/api";
import {
  type CheckIn,
  CHECK_IN_CAPTIONS,
  CHECK_IN_MAX,
  CHECK_IN_MIN,
  READINESS_BAND_LABELS,
  READINESS_BAND_MEANINGS,
  type Readiness,
} from "@shared/readiness";

/*
 * The morning check-in, as ONE LINE above the accent panel.
 *
 * DECISIONS C8 is binding here and it is the difference between this being
 * good and being clutter. Phase 7's win was that an athlete opens the app and
 * sees what to do today rather than a wall of reasoning; a readiness card
 * with three sliders, a score, a band, an explanation and an override toggle
 * would push the session cards below the fold on every phone, every morning,
 * for a feature that on most mornings changes nothing.
 *
 * So: collapsed it is a line. Expanded it is three chip rows and an answer.
 * Either way the sessions stay where they were.
 */

const FIELDS = ["sleepQuality", "soreness", "energy"] as const;
type Field = (typeof FIELDS)[number];

const SCALE = Array.from({ length: CHECK_IN_MAX - CHECK_IN_MIN + 1 }, (_, i) => CHECK_IN_MIN + i);

/*
 * `GET /api/plan/week` types its check-in as the shared `CheckIn` (that is
 * what `AthleteState` declares), while the row it actually sends is a
 * `CheckInRecord` carrying what the layer changed. Reading it back through
 * the narrower type, rather than asserting the wider one, keeps "we have
 * last time's answer" honestly optional — the POST below is the authoritative
 * source for what THIS check-in changed either way.
 */
function storedAdjustments(checkIn: CheckIn | null): CheckInRecord["adjustments"] | null {
  const rows = (checkIn as Partial<CheckInRecord> | null)?.adjustments;
  return Array.isArray(rows) ? rows : null;
}

export function CheckInStrip({ checkIn, readiness }: { checkIn: CheckIn | null; readiness: Readiness | null }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<Field, number>>({
    sleepQuality: checkIn?.sleepQuality ?? 3,
    soreness: checkIn?.soreness ?? 3,
    energy: checkIn?.energy ?? 3,
  });
  /** Set from the POST's own answer, so the card can never claim a change the plan does not show. */
  const [changed, setChanged] = useState<CheckInRecord["adjustments"] | null>(null);

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.recordCheckIn>[0]) => api.recordCheckIn(body),
    onSuccess: (result) => {
      setChanged(result.adjustments);
      setDraft({ sleepQuality: result.checkIn.sleepQuality, soreness: result.checkIn.soreness, energy: result.checkIn.energy });
      queryClient.invalidateQueries({ queryKey: ["week"] });
    },
  });

  const answered = checkIn?.date === todayStr();
  const submit = (patch: Partial<Record<Field, number>> & { trainAnywayOverride?: boolean }) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    save.mutate({ date: todayStr(), ...next, trainAnywayOverride: patch.trainAnywayOverride });
  };

  // Collapsed: the whole feature is one line. A band label and a score when
  // this morning is answered; an invitation when it is not.
  const summary = answered && readiness
    ? `${READINESS_BAND_LABELS[readiness.band]} · ${readiness.score.value}/100`
    : "Not yet — three taps";

  const shown = changed ?? storedAdjustments(checkIn);

  return (
    <div className="panel" style={{ padding: open ? 16 : "12px 16px", marginBottom: 12 }}>
      <button className="line-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          <span className="section-label" style={{ marginRight: 10 }}>This morning</span>
          <span className={answered ? "display-num" : "muted"} style={{ fontSize: 13 }}>{summary}</span>
        </span>
        <span className="muted tiny">{open ? "Close" : answered ? "Change" : "Check in"}</span>
      </button>

      {open && (
        <div style={{ marginTop: 14 }}>
          {FIELDS.map((field) => (
            <div key={field} style={{ marginBottom: 10 }}>
              <div className="section-label" style={{ marginBottom: 5 }}>{CHECK_IN_CAPTIONS[field].label}</div>
              <div className="chip-row">
                {SCALE.map((value) => (
                  <button
                    key={value}
                    className={`chip${draft[field] === value ? " chip-on" : ""}`}
                    disabled={save.isPending}
                    onClick={() => submit({ [field]: value } as Partial<Record<Field, number>>)}
                  >
                    {value} · {CHECK_IN_CAPTIONS[field].scale[value - 1]}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {save.error && <div className="notice notice-danger">{(save.error as Error).message}</div>}

          {answered && readiness && (
            <div className="surface-2" style={{ marginTop: 12 }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <div className="stack">
                  <strong style={{ fontSize: 14 }}>{READINESS_BAND_LABELS[readiness.band]}</strong>
                  <span className="tiny muted">{READINESS_BAND_MEANINGS[readiness.band]}</span>
                </div>
                <div className="display-num" style={{ fontSize: 22 }}>{readiness.score.value}</div>
              </div>

              {/* The Measured<T> rule, same as every number on the Athlete page. */}
              <div className="tiny muted" style={{ marginBottom: 8 }}>{readiness.score.source}</div>

              <ul style={{ margin: "0 0 10px", paddingLeft: 16 }}>
                {readiness.explanation.map((line, i) => (
                  <li key={i} className="tiny muted" style={{ lineHeight: 1.55 }}>{line}</li>
                ))}
              </ul>

              {/*
               * When the score is NOT acting, say why in the engine's own
               * words. "Nothing changed" would be a different and misleading
               * claim: a flagged morning that cannot act yet is not the same
               * as a morning that needed nothing.
               */}
              {!readiness.acting && <div className="tiny muted" style={{ marginBottom: 8, lineHeight: 1.5 }}>{readiness.actingReason}</div>}

              <div className="section-label" style={{ marginBottom: 5 }}>What it changed</div>
              {shown && shown.length > 0 ? (
                shown.map((row, i) => (
                  <div key={i} className="tiny" style={{ marginBottom: 5, lineHeight: 1.5 }}>
                    <strong>{row.action}</strong> — {row.reason}
                  </div>
                ))
              ) : (
                <div className="tiny muted" style={{ marginBottom: 5 }}>Nothing changed — today's session stands.</div>
              )}

              {/*
               * DECISIONS B7. Without a visible way to say "I know what it
               * says, I'm training anyway", the only route to the session as
               * written is to go back and lie about how you slept — which
               * makes lying to the app the price of training as prescribed.
               */}
              <div className="chip-row" style={{ marginTop: 10 }}>
                <button
                  className={`chip${readiness.trainAnywayOverride ? " chip-on" : ""}`}
                  disabled={save.isPending}
                  onClick={() => submit({ trainAnywayOverride: !readiness.trainAnywayOverride })}
                >
                  {readiness.trainAnywayOverride ? "Training as prescribed ✓" : "Train as prescribed anyway"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
