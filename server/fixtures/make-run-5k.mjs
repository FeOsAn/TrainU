/**
 * Generates server/fixtures/run-5k.fit — a 5 km run in 25:00, heart rate
 * 140→160, one record every 10 s, with lap/session/activity summaries.
 *
 * Encoded by Garmin's own FIT SDK and checked with its decoder's integrity
 * check (header + CRC), so it is a genuinely valid FIT file rather than bytes
 * shaped like one. It is still SYNTHETIC: no device wrote it, so it carries
 * none of the manufacturer-specific messages a real Garmin export does. It
 * proves the parse path works end to end, including in the production
 * worker; the first real upload is still the first real test of the
 * extraction against a device file.
 *
 *   npm i --no-save @garmin/fitsdk && node server/fixtures/make-run-5k.mjs
 */
import { Encoder, Profile, Decoder, Stream } from "@garmin/fitsdk";
import { writeFileSync } from "node:fs";

const start = new Date("2026-09-20T07:00:00Z");
const durationSec = 25 * 60;
const distanceM = 5000;
const encoder = new Encoder();
encoder.onMesg(Profile.MesgNum.FILE_ID, { manufacturer: "development", product: 0, timeCreated: start, type: "activity", serialNumber: 1 });
encoder.onMesg(Profile.MesgNum.EVENT, { timestamp: start, event: "timer", eventType: "start" });
let maxHr = 0, hrSum = 0, n = 0;
for (let t = 0; t <= durationSec; t += 10) {
  const hr = Math.round(140 + 20 * (t / durationSec) + (t % 60 === 0 ? 2 : 0));
  maxHr = Math.max(maxHr, hr); hrSum += hr; n++;
  encoder.onMesg(Profile.MesgNum.RECORD, {
    timestamp: new Date(start.getTime() + t * 1000),
    distance: (distanceM * t) / durationSec,
    speed: distanceM / durationSec,
    heartRate: hr,
  });
}
const end = new Date(start.getTime() + durationSec * 1000);
const avgHr = Math.round(hrSum / n);
encoder.onMesg(Profile.MesgNum.EVENT, { timestamp: end, event: "timer", eventType: "stopAll" });
const totals = { totalElapsedTime: durationSec, totalTimerTime: durationSec, totalDistance: distanceM, avgSpeed: distanceM / durationSec, avgHeartRate: avgHr, maxHeartRate: maxHr };
encoder.onMesg(Profile.MesgNum.LAP, { timestamp: end, startTime: start, messageIndex: 0, sport: "running", ...totals });
encoder.onMesg(Profile.MesgNum.SESSION, { timestamp: end, startTime: start, messageIndex: 0, sport: "running", subSport: "road", firstLapIndex: 0, numLaps: 1, ...totals });
encoder.onMesg(Profile.MesgNum.ACTIVITY, { timestamp: end, numSessions: 1, type: "manual", event: "activity", eventType: "stop", totalTimerTime: durationSec });
const bytes = encoder.close();
const decoder = new Decoder(Stream.fromByteArray(bytes));
console.log("isFIT", decoder.isFIT(), "integrity", decoder.checkIntegrity(), "bytes", bytes.length, "avgHr", avgHr, "maxHr", maxHr);
writeFileSync(new URL("./run-5k.fit", import.meta.url), Buffer.from(bytes));
