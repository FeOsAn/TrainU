import type { PlanSession } from "../lib/api";
import {
  COMPLETION_REASONS,
  COMPLETION_STATUSES,
  REASON_LABELS,
  RPE_RANGE,
  STATUS_ALLOWS,
  STATUS_LABELS,
  type CompletionReason,
  type CompletionStatus,
} from "@shared/prescription/completion";
import { ADJUSTMENT_SOURCE_LABELS } from "@shared/prescription/adjust";

const INTENSITY_PILL: Record<string, string> = {
  hard: "pill-seed",
  moderate: "pill-neutral",
  easy: "pill-neutral",
  rest: "pill-neutral",
};

const RPE_SCALE = Array.from({ length: RPE_RANGE.max - RPE_RANGE.min + 1 }, (_, i) => RPE_RANGE.min + i);

export interface TickPatch {
  status: CompletionStatus;
  rpe?: number | null;
  reason?: CompletionReason | null;
  /** Sent on the first tap only — the snapshot of what this session WAS. */
  prescribed?: PlanSession | null;
}

/**
 * One session, and everything the athlete can say about it.
 *
 * The RPE and reason rows are shown from `STATUS_ALLOWS` rather than from a
 * second copy of the same rule here. An RPE on a session that never happened
 * is not an odd number, it is a contradiction, and the server refuses it —
 * so the control that could produce one must not exist.
 */
export function SessionCard({ session, onTick, pending }: { session: PlanSession; onTick: (patch: TickPatch) => void; pending: boolean }) {
  const completion = session.completion;
  const status = completion?.status;
  const allows = status ? STATUS_ALLOWS[status] : null;
  const was = session.adjustedFrom;

  return (
    /* `data-intensity` drives a colour stripe down the left edge in index.css:
       what a session costs you is the first thing to read off a week, and it
       was previously only a small grey word at the far right of the card. */
    <div className={`session${status === "skipped" ? " session-skipped" : ""}`} data-intensity={session.intensity}>
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="stack" style={{ minWidth: 0 }}>
          <strong className="session-title">{session.title}</strong>
          <span className="tiny muted">
            {session.durationMinutes} min · {session.tss} TSS
            {/* The prescription this replaced, struck through rather than quietly gone. */}
            {was && <> · <span className="was">{was.title}, {was.durationMinutes} min</span></>}
          </span>
        </div>
        <div className="chip-row" style={{ justifyContent: "flex-end", flexShrink: 0 }}>
          {was && <span className="pill pill-seed">adjusted</span>}
          <span className={`pill ${status === "completed" ? "pill-verified" : INTENSITY_PILL[session.intensity] ?? "pill-neutral"}`}>
            {status ? STATUS_LABELS[status] : session.intensity}
          </span>
        </div>
      </div>

      {was && (
        <div className="tiny muted" style={{ marginBottom: 8, lineHeight: 1.5 }}>
          {was.reasons.map((reason, i) => (
            <div key={i} style={{ marginBottom: 3 }}>{reason}</div>
          ))}
          <div className="chip-row" style={{ marginTop: 5 }}>
            {was.sources.map((source, i) => (
              <span key={`${source}-${i}`} className="pill pill-neutral">{ADJUSTMENT_SOURCE_LABELS[source]}</span>
            ))}
          </div>
        </div>
      )}

      <ul className="targets">
        {session.targets.map((target, i) => (
          <li key={i}>{target}</li>
        ))}
      </ul>

      <div className="tiny muted" style={{ marginBottom: 10, lineHeight: 1.5 }}>{session.note}</div>

      <div className="chip-row" style={{ justifyContent: "flex-start" }}>
        {COMPLETION_STATUSES.map((option) => (
          <button
            key={option}
            className={status === option ? "chip chip-on" : "chip"}
            disabled={pending}
            // The first tap carries the snapshot; later taps carry only the
            // field being changed, so the patch semantics keep the rest.
            onClick={() => onTick({ status: option, prescribed: completion ? null : session })}
          >
            {STATUS_LABELS[option]}
          </button>
        ))}
      </div>

      {allows?.rpe && (
        <div style={{ marginTop: 10 }}>
          <div className="section-label" style={{ marginBottom: 5 }}>How hard did it feel?</div>
          <div className="chip-row">
            {RPE_SCALE.map((value) => (
              <button
                key={value}
                className={`chip chip-mini${completion?.rpe === value ? " chip-on" : ""}`}
                disabled={pending}
                // Tapping the selected chip again clears it: `null` means
                // "I no longer want to say", which is different from never
                // having said and different again from saying 5.
                onClick={() => onTick({ status: status!, rpe: completion?.rpe === value ? null : value })}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      )}

      {allows?.reason && (
        <div style={{ marginTop: 10 }}>
          <div className="section-label" style={{ marginBottom: 5 }}>What got in the way?</div>
          <div className="chip-row">
            {COMPLETION_REASONS.map((reason) => (
              <button
                key={reason}
                className={`chip chip-mini${completion?.reason === reason ? " chip-on" : ""}`}
                disabled={pending}
                onClick={() => onTick({ status: status!, reason: completion?.reason === reason ? null : reason })}
              >
                {REASON_LABELS[reason]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
