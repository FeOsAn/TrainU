/** What onboarding asks about besides the goals themselves. Actual OAuth wiring is Phase 5 — this is just the athlete's stated intent. */
export interface ConnectorPreferences {
  garmin: boolean;
  whoop: boolean;
  appleHealth: boolean;
}

export interface FeaturePreferences {
  physiqueTracking: boolean;
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
export const DEFAULT_FEATURE_PREFERENCES: FeaturePreferences = { physiqueTracking: false };
