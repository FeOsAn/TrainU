/**
 * What the app was built from, for the screens that show it back.
 *
 * Two of the survey's answers are not writes into the goal model — they are
 * the athlete's own words about themselves — and they have to be READ
 * somewhere or they are the Phase 8 `physiqueTracking` mistake repeated:
 * asked for during onboarding, stored, and rendered by nothing.
 *
 *   `name`      — the Plan header greets them with it.
 *   `narrative` — "Your app" shows it back as what this was assembled from,
 *                 which is also how an athlete notices it has gone stale.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export function useBuildState() {
  return useQuery({ queryKey: ["build-state"], queryFn: api.buildState, retry: false, staleTime: 60_000 });
}

/** First name only, trimmed — "Morning, Alexander Featherstonehaugh" is not a greeting. */
export function useAthleteName(): string | null {
  const { data } = useBuildState();
  const name = data?.answers?.name?.trim();
  if (!name) return null;
  return name.split(/\s+/)[0]!.slice(0, 20);
}

/**
 * "Morning" / "Afternoon" / "Evening" off the device's own clock — the same
 * local-time rule `todayStr()` follows, for the same reason: a greeting
 * computed in UTC says "Evening" to someone eating breakfast in Sydney.
 */
export function greeting(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return "Morning";
  if (hour < 18) return "Afternoon";
  return "Evening";
}
