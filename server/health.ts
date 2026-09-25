/**
 * What `/api/health` checks — and therefore what Railway checks before it
 * routes traffic to a new deployment.
 *
 * A healthcheck that only proves the process is listening is the one that
 * would have passed on every bad deploy that has a chance of happening now.
 * This one fails for the misconfigurations that make a running deployment
 * useless or destructive, so that deployment is never the one serving:
 *
 *   - no APP_PASSWORD in production: the gate fails closed and every data
 *     request is refused, so the app cannot do anything;
 *   - the database is not readable;
 *   - on Railway, the database file is not on the attached volume: the app
 *     works perfectly — until the next deploy silently erases the athlete's
 *     entire history. The most expensive failure available, and the only
 *     one of these that is completely invisible while it is happening.
 *
 * The reasons are fixed sentences about configuration, never values, since
 * this endpoint answers without a cookie.
 */
import path from "node:path";
import { DB_PATH, sqlite } from "./db";

export function deploymentProblems(env: NodeJS.ProcessEnv = process.env, dbPath: string = DB_PATH): string[] {
  const problems: string[] = [];

  if (process.env.NODE_ENV === "production" && !env.APP_PASSWORD) {
    problems.push("APP_PASSWORD is not set, so this deployment refuses to serve data. Set it in the service's variables and redeploy.");
  }

  // Railway sets RAILWAY_ENVIRONMENT_NAME/RAILWAY_PROJECT_ID on every
  // deployment, and RAILWAY_VOLUME_MOUNT_PATH only when a volume is attached.
  const onRailway = Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
  if (onRailway && env.ALLOW_EPHEMERAL_DB !== "1") {
    const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
    if (!mount) {
      problems.push(
        `No volume is attached, so the database (${path.basename(dbPath)}) lives on the deployment's own disk and the next deploy erases it. ` +
          "Attach a volume mounted at /data (or set ALLOW_EPHEMERAL_DB=1 if losing the data is intended).",
      );
    } else if (!isInside(dbPath, mount)) {
      problems.push(
        `The database is not on the attached volume (${mount}), so the next deploy erases it. ` +
          `Mount the volume at /data, or set DB_PATH to a file inside ${mount}.`,
      );
    }
  }

  try {
    sqlite.prepare("SELECT 1").get();
  } catch {
    problems.push("The database is not readable.");
  }

  return problems;
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
