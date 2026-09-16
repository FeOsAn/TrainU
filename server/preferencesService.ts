import { eq } from "drizzle-orm";
import { db } from "./db";
import { preferences } from "@shared/schema";
import {
  type BlockChoice,
  type BlockPreferences,
  type ConnectorPreferences,
  type FeaturePreferences,
  DEFAULT_BLOCK_PREFERENCES,
  DEFAULT_CONNECTOR_PREFERENCES,
  DEFAULT_FEATURE_PREFERENCES,
} from "@shared/preferences";

const ROW_ID = "self";

export interface Preferences {
  connectors: ConnectorPreferences;
  features: FeaturePreferences;
  blocks: BlockPreferences;
}

export function getPreferences(): Preferences {
  const row = db.select().from(preferences).where(eq(preferences.id, ROW_ID)).get();
  if (!row) return { connectors: DEFAULT_CONNECTOR_PREFERENCES, features: DEFAULT_FEATURE_PREFERENCES, blocks: DEFAULT_BLOCK_PREFERENCES };
  return {
    connectors: { ...DEFAULT_CONNECTOR_PREFERENCES, ...JSON.parse(row.connectorsJson) },
    features: { ...DEFAULT_FEATURE_PREFERENCES, ...JSON.parse(row.featuresJson) },
    blocks: { ...DEFAULT_BLOCK_PREFERENCES, ...JSON.parse(row.blocksJson) },
  };
}

/**
 * Set or clear the athlete's explicit choice for a block. Passing null clears
 * it, which hands the decision back to the assembler rather than pinning it —
 * "let the app decide" has to stay reachable once you've overridden something.
 */
export function updateBlockPreferences(patch: Record<string, BlockChoice | null>): BlockPreferences {
  const current = getPreferences();
  const merged = { ...current.blocks };
  for (const [blockId, choice] of Object.entries(patch)) {
    if (choice === null) delete merged[blockId];
    else merged[blockId] = choice;
  }
  save(current.connectors, current.features, merged);
  return merged;
}

export function updateConnectorPreferences(patch: Partial<ConnectorPreferences>): ConnectorPreferences {
  const current = getPreferences();
  const merged = { ...current.connectors, ...patch };
  save(merged, current.features, current.blocks);
  return merged;
}

export function updateFeaturePreferences(patch: Partial<FeaturePreferences>): FeaturePreferences {
  const current = getPreferences();
  const merged = { ...current.features, ...patch };
  save(current.connectors, merged, current.blocks);
  return merged;
}

function save(connectors: ConnectorPreferences, features: FeaturePreferences, blocks: BlockPreferences): void {
  const now = new Date().toISOString();
  const existing = db.select().from(preferences).where(eq(preferences.id, ROW_ID)).get();
  const values = {
    connectorsJson: JSON.stringify(connectors),
    featuresJson: JSON.stringify(features),
    blocksJson: JSON.stringify(blocks),
    updatedAt: now,
  };
  if (existing) {
    db.update(preferences).set(values).where(eq(preferences.id, ROW_ID)).run();
  } else {
    db.insert(preferences).values({ id: ROW_ID, ...values }).run();
  }
}
