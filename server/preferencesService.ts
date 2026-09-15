import { eq } from "drizzle-orm";
import { db } from "./db";
import { preferences } from "@shared/schema";
import { type ConnectorPreferences, type FeaturePreferences, DEFAULT_CONNECTOR_PREFERENCES, DEFAULT_FEATURE_PREFERENCES } from "@shared/preferences";

const ROW_ID = "self";

export function getPreferences(): { connectors: ConnectorPreferences; features: FeaturePreferences } {
  const row = db.select().from(preferences).where(eq(preferences.id, ROW_ID)).get();
  if (!row) return { connectors: DEFAULT_CONNECTOR_PREFERENCES, features: DEFAULT_FEATURE_PREFERENCES };
  return {
    connectors: { ...DEFAULT_CONNECTOR_PREFERENCES, ...JSON.parse(row.connectorsJson) },
    features: { ...DEFAULT_FEATURE_PREFERENCES, ...JSON.parse(row.featuresJson) },
  };
}

export function updateConnectorPreferences(patch: Partial<ConnectorPreferences>): ConnectorPreferences {
  const current = getPreferences();
  const merged = { ...current.connectors, ...patch };
  save(merged, current.features);
  return merged;
}

export function updateFeaturePreferences(patch: Partial<FeaturePreferences>): FeaturePreferences {
  const current = getPreferences();
  const merged = { ...current.features, ...patch };
  save(current.connectors, merged);
  return merged;
}

function save(connectors: ConnectorPreferences, features: FeaturePreferences): void {
  const now = new Date().toISOString();
  const existing = db.select().from(preferences).where(eq(preferences.id, ROW_ID)).get();
  const values = { connectorsJson: JSON.stringify(connectors), featuresJson: JSON.stringify(features), updatedAt: now };
  if (existing) {
    db.update(preferences).set(values).where(eq(preferences.id, ROW_ID)).run();
  } else {
    db.insert(preferences).values({ id: ROW_ID, ...values }).run();
  }
}
