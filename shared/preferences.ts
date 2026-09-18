/** What onboarding asks about besides the goals themselves. Actual OAuth wiring is Phase 5 — this is just the athlete's stated intent. */
export interface ConnectorPreferences {
  garmin: boolean;
  whoop: boolean;
  appleHealth: boolean;
}

export interface FeaturePreferences {
  physiqueTracking: boolean;
  /**
   * Whether a bike / a pool is actually reachable.
   *
   * Not a nicety: when an injury rules out running, whether a substitute
   * exists at all decides between "Endurance ride instead of your long run"
   * and an honest rest day. Guessing wrong in either direction is bad —
   * prescribing a ride to someone with no bike is a session they cannot do,
   * and defaulting everyone to rest strips training from people who had a
   * perfectly good alternative. So it is asked, and it defaults to false:
   * we assume nothing we were not told.
   *
   * A live goal can imply these (a triathlete plainly has both) — that
   * inference lives with the conditions feature, not in the stored value, so
   * the athlete's own answer is never overwritten by a goal.
   */
  hasBike: boolean;
  hasPool: boolean;
}

/**
 * The athlete's explicit say over what their app contains.
 *
 * Inference from the goal model gets the default right most of the time, and
 * "most of the time" is not good enough to be the only mechanism. A runner
 * who also owns a bike wants their FTP tracked; someone doing a cut who finds
 * progress photos miserable wants that gone and wants to stop being told it
 * isn't built. Neither is expressible by a goal.
 *
 * So: an explicit override always beats inference, in both directions.
 *   "on"  — include this block even though my goals don't imply it
 *   "off" — leave it out even though they do
 * A block with no entry is decided by the assembler, which is the common case.
 *
 * `off` also silences that block's gap. Telling someone a feature they
 * declined isn't built yet is nagging, not honesty.
 */
export type BlockChoice = "on" | "off";
export type BlockPreferences = Record<string, BlockChoice>;

export const DEFAULT_BLOCK_PREFERENCES: BlockPreferences = {};

export const DEFAULT_CONNECTOR_PREFERENCES: ConnectorPreferences = { garmin: false, whoop: false, appleHealth: false };
export const DEFAULT_FEATURE_PREFERENCES: FeaturePreferences = { physiqueTracking: false, hasBike: false, hasPool: false };
