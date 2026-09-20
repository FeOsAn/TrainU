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

/** The three answers, and nothing else — what the chips show and what the POST carries. */
export type Scores = Record<Field, number>;

/**
 * What a morning nobody has answered is worth.
 *
 * It is a PLACEHOLDER for the chips, never a value to send on behalf of a
 * question the athlete did not answer — see `submittedScores`.
 */
export const NEUTRAL_SCORES: Scores = { sleepQuality: 3, soreness: 3, energy: 3 };

function scoresOf(checkIn: { sleepQuality: number; soreness: number; energy: number } | null): Scores | null {
  if (!checkIn) return null;
  return { sleepQuality: checkIn.sleepQuality, soreness: checkIn.soreness, energy: checkIn.energy };
}

/**
 * What the chips highlight: this session's own tap if there has been one,
 * otherwise THE STORED MORNING, read fresh from the prop on every render.
 *
 * Deriving it rather than seeding it is the whole fix: a value copied into
 * state at mount cannot know that the week arrived a moment later.
 */
export function shownScores(tapped: Scores | null, stored: { sleepQuality: number; soreness: number; energy: number } | null): Scores {
  return tapped ?? scoresOf(stored) ?? NEUTRAL_SCORES;
}

/**
 * The body of the POST. `upsertCheckIn` requires all three scores and
 * overwrites all three, so the two the athlete did not touch have to be the
 * two that are STORED — never a neutral placeholder standing in for them.
 */
export function submittedScores(
  tapped: Scores | null,
  stored: { sleepQuality: number; soreness: number; energy: number } | null,
  patch: Partial<Scores>,
): Scores {
  return { ...shownScores(tapped, stored), ...patch };
}

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
  /*
   * ONLY this session's own taps live here, and it starts EMPTY.
   *
   * It used to be seeded from `checkIn` by a `useState` initializer — and
   * Plan.tsx mounts this strip before the week query resolves (deliberately,
   * so the line does not shove the session cards down a beat later), so the
   * initializer always ran against `null` and froze {3,3,3} into state. The
   * chips then showed 3/3/3 beside a summary reading the athlete's real
   * score, and because the POST sent the whole triple, re-answering ONE
   * question rewrote the other two as average: a 5/1/5 morning became
   * 3/4/3 on a single tap, silently, and "Train as prescribed anyway"
   * overwrote the very morning it was overriding.
   *
   * Everything shown is now DERIVED from the stored check-in (see
   * `shownScores`) and only replaced while the athlete's own tap is the
   * newest thing either side knows about.
   */
  const [tapped, setTapped] = useState<Scores | null>(null);
  /** Set from the POST's own answer, so the card can never claim a change the plan does not show. */
  const [changed, setChanged] = useState<CheckInRecord["adjustments"] | null>(null);

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.recordCheckIn>[0]) => api.recordCheckIn(body),
    onSuccess: (result) => {
      setChanged(result.adjustments);
      setTapped(scoresOf(result.checkIn));
      /*
       * `["week"]` only, and deliberately: readiness is not an input to
       * `arbitrateWeek`, so no goal conflict can move — unlike a condition,
       * which is why `invalidateEngineAnswer` exists for that panel.
       */
      queryClient.invalidateQueries({ queryKey: ["week"] });
    },
  });

  const answered = checkIn?.date === todayStr();
  const scores = shownScores(tapped, checkIn);
  const submit = (patch: Partial<Record<Field, number>> & { trainAnywayOverride?: boolean }) => {
    const { trainAnywayOverride, ...scores } = patch;
    const next = submittedScores(tapped, checkIn, scores);
    setTapped(next);
    save.mutate({ date: todayStr(), ...next, trainAnywayOverride });
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
                    className={`chip${scores[field] === value ? " chip-on" : ""}`}
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
