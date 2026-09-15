import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ATHLETE } from "./athlete";
import { computeTrainingLoad, estimateSessionTss, type SessionForTss } from "./trainingLoad";

function session(over: Partial<SessionForTss & { date: string }>): SessionForTss & { date: string } {
  return { sport: "run", durationMinutes: 40, date: "2026-09-01", ...over };
}

test("empty session list returns a neutral, zeroed summary", () => {
  const s = computeTrainingLoad([], DEFAULT_ATHLETE);
  assert.equal(s.currentCtl, 0);
  assert.equal(s.tsbStatus, "neutral");
  assert.deepEqual(s.history, []);
});

test("a stored TSS is trusted outright, no re-derivation", () => {
  const tss = estimateSessionTss(session({ tss: 123 }), DEFAULT_ATHLETE);
  assert.equal(tss, 123);
});

test("strength sessions are excluded from CTL/ATL but counted in weekly totals", () => {
  const today = "2026-09-10";
  const sessions = [
    session({ date: "2026-09-10", sport: "strength", durationMinutes: 60, tss: 24 }),
  ];
  const s = computeTrainingLoad(sessions, DEFAULT_ATHLETE, today);
  assert.equal(s.currentCtl, 0, "strength must not feed the aerobic (all-sport) PMC");
  assert.equal(s.sportCtl.run, 0, "no run sessions were logged");
  assert.ok(s.sportCtl.strength > 0, "strength still gets its own per-sport CTL trend, just excluded from the aerobic total");
  assert.equal(s.weeklyTss, 24, "but it does count toward total work");
});

test("CTL rises under a sustained daily load and TSB goes negative", () => {
  const today = "2026-10-15";
  const sessions: Array<SessionForTss & { date: string }> = [];
  const start = new Date("2026-09-01T00:00:00Z");
  for (let i = 0; i < 45; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    sessions.push(session({ date: d.toISOString().slice(0, 10), tss: 80 }));
  }
  const s = computeTrainingLoad(sessions, DEFAULT_ATHLETE, today);
  assert.ok(s.currentCtl > 50, `expected meaningful fitness accumulation, got ${s.currentCtl}`);
  assert.ok(s.currentTsb < 0, "45 days of daily 80 TSS should leave the athlete fatigued, not fresh");
});

test("a non-finite TSS input is dropped rather than poisoning the EWMA", () => {
  const sessions = [session({ date: "2026-09-01", avgHeartRate: NaN as unknown as number })];
  const s = computeTrainingLoad(sessions, DEFAULT_ATHLETE);
  assert.ok(Number.isFinite(s.currentCtl));
  assert.ok(Number.isFinite(s.currentTsb));
});
