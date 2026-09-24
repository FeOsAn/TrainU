/**
 * FIT file → TrainingSession draft. Ported from sub5-dashboard's
 * fitUpload.ts, trimmed to the fields the training-load engine and
 * predictors actually consume (lap-level dynamics like ground contact time
 * aren't read anywhere yet — add them back if a predictor needs them,
 * rather than carrying unused fields).
 */
import { execFile, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import FitParser from "fit-file-parser";
import type { Sport, TrainingSession } from "../shared/session";

const FIT_SPORT_MAP: Record<string, Sport> = {
  swimming: "swim",
  running: "run",
  cycling: "bike",
  open_water: "swim",
  lap_swimming: "swim",
  training: "strength",
  generic: "other",
  walking: "other",
  hiking: "other",
  transition: "other",
  multisport: "other",
};

function mapFitSport(sport?: string, subSport?: string): Sport {
  if (!sport) return "other";
  const subKey = (subSport || "").toLowerCase();
  if (subKey === "lap_swimming" || subKey === "open_water") return "swim";
  if (subKey === "road_cycling" || subKey === "indoor_cycling") return "bike";
  if (subKey === "road_running" || subKey === "trail_running") return "run";
  return FIT_SPORT_MAP[sport.toLowerCase()] || "other";
}

function msToSecPerKm(ms: number): number | undefined {
  return ms > 0 ? Math.round(1000 / ms) : undefined;
}

export interface FitParseResult {
  date: string;
  sport: Sport;
  title: string;
  durationMinutes: number;
  distanceKm?: number;
  avgPowerWatts?: number;
  normalizedPower?: number;
  avgPaceSecPerKm?: number;
  avgPaceSecPer100m?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  startTime: string;
}

export function parseFitBuffer(buffer: Buffer): Promise<FitParseResult> {
  return new Promise((resolve, reject) => {
    const parser = new (FitParser as any)({
      force: true,
      speedUnit: "m/s",
      lengthUnit: "m",
      temperatureUnit: "celsius",
      mode: "list",
    });

    parser.parse(buffer, (err: string | null, data: any) => {
      if (err) return reject(new Error(err));
      if (!data) return reject(new Error("No data returned from FIT parser"));
      try {
        resolve(extractFromFitData(data));
      } catch (e: any) {
        reject(new Error(`FIT extraction failed: ${e?.message}`));
      }
    });
  });
}

/** Cheap FIT-header sniff (Garmin FIT SDK format) — rejects the common "wrong file" case with zero cost, before ever touching the parser. */
export function looksLikeFitFile(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  const headerSize = buffer.readUInt8(0);
  if (headerSize !== 12 && headerSize !== 14) return false;
  if (buffer.length < headerSize) return false;
  return buffer.toString("ascii", 8, 12) === ".FIT";
}

/*
 * `import.meta.dirname` is Node >= 20.11. This app deployed onto Node 18,
 * where it is `undefined` — and because the old code resolved the worker path
 * at MODULE SCOPE, `path.resolve(undefined, …)` threw during import and killed
 * the whole server before it could listen. Nothing to do with FIT files; the
 * app simply would not boot. `fileURLToPath(import.meta.url)` is the portable
 * spelling and works on every version.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the parse actually runs, resolved LAZILY — a path problem must fail
 * the one upload that needs it, never the process.
 *
 * The old version hardcoded `tsx` from `node_modules/.bin` and pointed at the
 * TypeScript SOURCE. Neither survives a production install: `--omit=dev`
 * strips tsx, and `dist/` contains no `.ts`. So this path had never once
 * worked outside dev — the boot crash was hiding a broken feature, not
 * causing one.
 *
 * Built form first (the worker is its own esbuild entry point, so
 * `dist/fitParseWorker.js` sits beside `dist/index.js` and runs on plain
 * `node`), falling back to the source under tsx when running from `server/`.
 */
export function resolveFitWorker(dir: string = HERE): { bin: string; args: string[] } {
  const bundled = path.resolve(dir, "fitParseWorker.js");
  if (existsSync(bundled)) return { bin: process.execPath, args: [bundled] };

  const source = path.resolve(dir, "fitParseWorker.ts");
  const tsx = path.resolve(process.cwd(), "node_modules/.bin/tsx");
  if (existsSync(source) && existsSync(tsx)) return { bin: tsx, args: [source] };

  throw new Error(
    `No FIT parse worker next to ${dir}. Expected fitParseWorker.js (built) or fitParseWorker.ts plus tsx (dev). ` +
      `If this is a deployed build, the worker is missing from dist — check the esbuild entry points in package.json.`,
  );
}

/**
 * Parse a FIT file with the actual (untrusted, third-party) parsing
 * isolated in its own OS process, hard-killed after `timeoutMs`.
 *
 * Not a defensive nicety — confirmed empirically that a single malformed
 * (but header-valid) FIT upload can make fit-file-parser take 10+ seconds
 * AND block the entire Node event loop: a concurrent request got no
 * response at all for 8+ seconds while one bad upload was "parsing". A
 * user's bad file must never be able to freeze the app for every other
 * user, so the parse runs where killing it can't take the server with it.
 */
export async function parseFitBufferSafely(buffer: Buffer, timeoutMs = 10_000): Promise<FitParseResult> {
  if (!looksLikeFitFile(buffer)) {
    throw new Error("Not a FIT file (missing .FIT header signature)");
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "trainu-fit-"));
  const filePath = path.join(dir, `${randomUUID()}.fit`);
  try {
    await writeFile(filePath, buffer);
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      const worker = resolveFitWorker();
      execFile(worker.bin, [...worker.args, filePath], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          if ((err as ExecFileException).killed || (err as ExecFileException).signal) {
            return reject(new Error(`FIT parse timed out after ${timeoutMs}ms and was killed — the file is likely corrupt`));
          }
          try {
            const parsed = JSON.parse(stderr);
            return reject(new Error(parsed.error ?? stderr));
          } catch {
            return reject(new Error(stderr || err.message));
          }
        }
        resolve({ stdout });
      });
    });
    return JSON.parse(stdout) as FitParseResult;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function extractFromFitData(data: any): FitParseResult {
  const sessions: any[] = data.sessions || data.activity?.sessions || [];
  const records: any[] = data.records || data.activity?.records || [];
  const sess = sessions[0] || {};

  const sport = mapFitSport(sess.sport, sess.sub_sport);
  const isSwim = sport === "swim";
  const isRun = sport === "run";

  const startTime: Date = sess.start_time
    ? new Date(sess.start_time)
    : records[0]?.timestamp
      ? new Date(records[0].timestamp)
      : new Date();
  const date = startTime.toISOString().slice(0, 10);

  const durationSec = Number(sess.total_elapsed_time || sess.total_timer_time || 0);
  const distM = Number(sess.total_distance || 0);
  const avgHR = sess.avg_heart_rate ? Math.round(Number(sess.avg_heart_rate)) : undefined;
  const maxHR = sess.max_heart_rate ? Math.round(Number(sess.max_heart_rate)) : undefined;
  const avgPower = sess.avg_power ? Math.round(Number(sess.avg_power)) : undefined;
  const normPower = sess.normalized_power ? Math.round(Number(sess.normalized_power)) : undefined;
  const avgSpeed = Number(sess.avg_speed || 0);

  let avgPaceSecPerKm: number | undefined;
  let avgPaceSecPer100m: number | undefined;
  if (isSwim && distM > 10 && durationSec > 0) {
    avgPaceSecPer100m = Math.round((durationSec / distM) * 100);
  } else if (isRun && avgSpeed > 0) {
    avgPaceSecPerKm = msToSecPerKm(avgSpeed);
  }

  const sportLabel = sport.charAt(0).toUpperCase() + sport.slice(1);
  const distLabel = distM > 0 ? (isSwim ? `${Math.round(distM)}m` : `${(distM / 1000).toFixed(1)}km`) : "";
  const title = `${sportLabel}${distLabel ? " — " + distLabel : ""}`;

  return {
    date,
    sport,
    title,
    startTime: startTime.toISOString(),
    durationMinutes: Math.max(1, Math.round(durationSec / 60)),
    distanceKm: distM > 0 ? parseFloat((distM / 1000).toFixed(2)) : undefined,
    avgPowerWatts: avgPower,
    normalizedPower: normPower,
    avgPaceSecPerKm,
    avgPaceSecPer100m,
    avgHeartRate: avgHR,
    maxHeartRate: maxHR,
  };
}

export function fitResultToSession(parsed: FitParseResult, id: string): TrainingSession {
  return {
    id,
    date: parsed.date,
    sport: parsed.sport,
    source: "fit_upload",
    startTime: parsed.startTime,
    durationMinutes: parsed.durationMinutes,
    distanceKm: parsed.distanceKm ?? null,
    avgHeartRate: parsed.avgHeartRate ?? null,
    maxHeartRate: parsed.maxHeartRate ?? null,
    avgPaceSecPerKm: parsed.avgPaceSecPerKm ?? null,
    avgPaceSecPer100m: parsed.avgPaceSecPer100m ?? null,
    avgPowerWatts: parsed.avgPowerWatts ?? null,
    normalizedPower: parsed.normalizedPower ?? null,
    tss: null,
    hrZonesJson: null,
    rpe: null,
    externalId: null,
  };
}
