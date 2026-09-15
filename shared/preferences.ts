/** What onboarding asks about besides the goals themselves. Actual OAuth wiring is Phase 5 — this is just the athlete's stated intent. */
export interface ConnectorPreferences {
  garmin: boolean;
  whoop: boolean;
  appleHealth: boolean;
}

export interface FeaturePreferences {
  physiqueTracking: boolean;
}

export const DEFAULT_CONNECTOR_PREFERENCES: ConnectorPreferences = { garmin: false, whoop: false, appleHealth: false };
export const DEFAULT_FEATURE_PREFERENCES: FeaturePreferences = { physiqueTracking: false };
