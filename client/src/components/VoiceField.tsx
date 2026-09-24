/**
 * A textarea you can talk into.
 *
 * The microphone is an addition to the field, never a replacement for it:
 * where dictation isn't supported (Firefox) or was refused, this is an
 * ordinary textarea and the survey is completable by thumb. See
 * lib/dictation.ts for why that's the browser API and not an upload.
 */
import { useCallback } from "react";
import { appendSpoken, useDictation } from "../lib/dictation";

export default function VoiceField({
  value,
  onChange,
  placeholder,
  rows = 5,
  label,
  hint,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  label?: string;
  hint?: string;
}) {
  // Reads `value` through the setter rather than closing over it, so a chunk
  // that lands while the athlete is typing appends to what's on screen now
  // and not to a stale snapshot from when the mic was opened.
  const append = useCallback((chunk: string) => onChange(appendSpoken(value, chunk)), [onChange, value]);
  const dictation = useDictation(append);

  return (
    <div className="voice-field">
      {label && (
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="section-label">{label}</span>
          {dictation.supported && (
            <button
              type="button"
              className={`mic${dictation.listening ? " mic-live" : ""}`}
              onClick={dictation.toggle}
              aria-pressed={dictation.listening}
              aria-label={dictation.listening ? "Stop dictating" : "Dictate"}
            >
              <MicGlyph />
              <span>{dictation.listening ? "Listening" : "Speak"}</span>
            </button>
          )}
        </div>
      )}

      <div className={`voice-box${dictation.listening ? " voice-box-live" : ""}`}>
        <textarea
          value={value}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {dictation.interim && <div className="voice-interim">{dictation.interim}</div>}
      </div>

      {!label && dictation.supported && (
        <button type="button" className={`mic${dictation.listening ? " mic-live" : ""}`} onClick={dictation.toggle} style={{ marginTop: 8 }}>
          <MicGlyph />
          <span>{dictation.listening ? "Listening — tap to stop" : "Speak instead"}</span>
        </button>
      )}

      {dictation.error && <div className="notice notice-warn tiny" style={{ marginTop: 8 }}>{dictation.error}</div>}
      {!dictation.supported && hint && <div className="tiny muted" style={{ marginTop: 8 }}>{hint}</div>}
    </div>
  );
}

function MicGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v4" />
    </svg>
  );
}
