import type { PlanSession, PlanWeek } from "../lib/api";
import type { TickPatch } from "./SessionCard";
import { ADJUSTMENT_ACTION_LABELS, ADJUSTMENT_SOURCE_LABELS } from "@shared/prescription/adjust";
import { STATUS_LABELS, COMPLETION_STATUSES } from "@shared/prescription/completion";

/**
 * What the app changed about this week, and the way back.
 *
 * The second half is DECISIONS B7 and it is not optional. A session the
 * modulation layer turned into rest — for a fever, for a restriction with
 * nothing to swap onto, for a wiped-out morning — is on no day card. Without
 * a way to tick it here, an athlete who trained anyway either loses the
 * record entirely or has to go back and falsify their check-in, which makes
 * lying to the app the only route to training as prescribed.
 *
 * The layer protects it afterwards: an answered session is immune to every
 * mutator, so what they did stands and is not dropped again tomorrow.
 */
export function ChangesPanel({ week, onTick, pending }: { week: PlanWeek; onTick: (session: PlanSession, patch: TickPatch) => void; pending: boolean }) {
  if (week.adjustments.length === 0 && week.dropped.length === 0) return null;

  return (
    <div className="panel">
      <h2>Changes this week</h2>
      <p className="small muted" style={{ marginTop: -6 }}>
        The week was planned at {week.original.totalMinutes} minutes and {week.original.totalTss} TSS. It now
        stands at {week.totalMinutes} and {week.totalTss}.
      </p>

      {week.adjustments.map((adjustment, i) => (
        <div key={`${adjustment.date}-${adjustment.originalKind}-${i}`} className="surface-2" style={{ marginBottom: 8 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <strong style={{ fontSize: 13.5 }}>{ADJUSTMENT_ACTION_LABELS[adjustment.action]}</strong>
            <span className="tiny muted">{adjustment.date}</span>
          </div>
          <div className="tiny muted" style={{ lineHeight: 1.5, marginBottom: 6 }}>{adjustment.reason}</div>
          <span className="pill pill-neutral">{ADJUSTMENT_SOURCE_LABELS[adjustment.source]}</span>
        </div>
      ))}

      {week.dropped.length > 0 && (
        <>
          <div className="divider" />
          <div className="section-label" style={{ marginBottom: 4 }}>Taken out of the week</div>
          <p className="tiny muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
            If you did one of these anyway, say so — the app would rather have the record than be right.
          </p>
          {week.dropped.map((session, i) => (
            <div key={`${session.date}-${session.kind}-${i}`} className="surface-2" style={{ marginBottom: 8 }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <div className="stack" style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 13.5 }}>{session.title}</strong>
                  <span className="tiny muted">{session.date} · {session.durationMinutes} min · {session.tss} TSS</span>
                </div>
                {session.completion && <span className="pill pill-verified">{STATUS_LABELS[session.completion.status]}</span>}
              </div>

              {session.adjustedFrom?.reasons.map((reason, j) => (
                <div key={j} className="tiny muted" style={{ lineHeight: 1.5, marginBottom: 6 }}>{reason}</div>
              ))}

              <div className="chip-row">
                {session.completion ? (
                  COMPLETION_STATUSES.map((option) => (
                    <button
                      key={option}
                      className={`chip chip-mini${session.completion!.status === option ? " chip-on" : ""}`}
                      disabled={pending}
                      onClick={() => onTick(session, { status: option })}
                    >
                      {STATUS_LABELS[option]}
                    </button>
                  ))
                ) : (
                  <button className="chip" disabled={pending} onClick={() => onTick(session, { status: "completed", prescribed: session })}>
                    Actually, I did this
                  </button>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
