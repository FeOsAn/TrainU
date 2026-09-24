/**
 * Voice dictation, via the browser's own speech recognition.
 *
 * Deliberately NOT an audio upload to a transcription API. Three reasons, in
 * order of how much they matter:
 *
 *  1. It costs nothing and needs no key, so dictation works on a deployed
 *     instance whether or not ANTHROPIC_API_KEY is set — the survey is the
 *     front door and the front door cannot depend on a paid service.
 *  2. The athlete's voice never touches this app's server or its database.
 *     What comes back is text they can see and edit before anything is sent.
 *  3. It is live. Interim results land in the box as they talk, which is what
 *     makes dictating a paragraph tolerable rather than a leap of faith.
 *
 * The cost is that it is not universal: WebKit and Chromium ship it, Firefox
 * does not. So it is progressive enhancement — `supported` is false there and
 * the microphone button simply isn't rendered. Every field it fills is a
 * normal text field that can be typed into. Nothing in the survey is
 * reachable only by voice.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** The two names this shipped under; Safari and older Chromium still only have the prefixed one. */
function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null;
}

/**
 * The slice of the Web Speech API this uses. Hand-declared because the DOM
 * lib types for it are not in every TypeScript version, and a `any` here
 * would hide a typo in an API that fails silently at runtime.
 */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export interface Dictation {
  supported: boolean;
  listening: boolean;
  /** What's been said since the mic was opened but isn't confirmed yet — shown greyed, never committed. */
  interim: string;
  error: string | null;
  start(): void;
  stop(): void;
  toggle(): void;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow it in your browser's site settings, or just type it.",
  "service-not-allowed": "This browser won't let the page use speech recognition. Typing works fine.",
  "audio-capture": "No microphone found.",
  network: "Speech recognition needs a connection and couldn't reach it. Type it instead.",
  aborted: "",
  "no-speech": "",
};

/**
 * @param onText called with each CONFIRMED chunk of speech. Appending is the
 *   caller's job, because appending to a textarea the athlete may have edited
 *   mid-sentence is a decision about their text, not about the microphone.
 */
export function useDictation(onText: (text: string) => void): Dictation {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const supported = useRef(recognitionCtor() !== null).current;

  // Held in a ref so restarting recognition doesn't need a fresh listener,
  // and so a re-render mid-sentence can't drop a chunk of what was said.
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
    setInterim("");
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || recognitionRef.current) return;
    setError(null);

    const recognition = new Ctor();
    recognition.lang = typeof navigator !== "undefined" ? navigator.language || "en-GB" : "en-GB";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!;
        const text = result[0].transcript;
        if (result.isFinal) onTextRef.current(text);
        else pending += text;
      }
      setInterim(pending);
    };

    recognition.onerror = (event) => {
      // "no-speech" fires on any pause long enough to look like silence, and
      // "aborted" fires when the athlete taps stop. Neither is worth a red
      // box under the field they are in the middle of dictating into.
      const message = ERRORS[event.error] ?? `Dictation stopped (${event.error}).`;
      if (message) setError(message);
      if (event.error === "not-allowed" || event.error === "service-not-allowed" || event.error === "audio-capture") stop();
    };

    // Recognition ends itself after a silence even with continuous set, and
    // on some browsers after roughly a minute regardless. Without this the
    // mic looks live while hearing nothing, which is the worst of both.
    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
        setListening(false);
        setInterim("");
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setListening(true);
    } catch {
      setError("Couldn't start the microphone.");
    }
  }, [stop]);

  // A live microphone that outlives the screen it belongs to is the kind of
  // thing that makes people distrust an app.
  useEffect(() => () => recognitionRef.current?.abort(), []);

  const toggle = useCallback(() => (recognitionRef.current ? stop() : start()), [start, stop]);

  return { supported, listening, interim, error, start, stop, toggle };
}

/** Append a confirmed chunk to existing text with sane spacing — shared so every dictated field behaves identically. */
export function appendSpoken(existing: string, chunk: string): string {
  const addition = chunk.trim();
  if (!addition) return existing;
  if (!existing.trim()) return addition.charAt(0).toUpperCase() + addition.slice(1);
  const needsSpace = !/\s$/.test(existing);
  return `${existing}${needsSpace ? " " : ""}${addition}`;
}
