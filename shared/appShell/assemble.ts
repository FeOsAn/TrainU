/**
 * The assembler: goals + preferences → the app this athlete actually gets.
 *
 * Pure, synchronous, no DB, no model call. Given the same goal model it
 * always produces the same app, which is the property that makes an assembled
 * app reviewable where a generated one isn't: "why am I being shown CdA?" has
 * an answer you can read, test, and argue with.
 *
 * It returns three things:
 *   - `surfaces`  — which routes exist and which blocks sit on each, ordered;
 *   - `capabilities` — what this athlete's app can actually do;
 *   - `gaps`      — what their goals asked for that the library can't serve.
 *
 * The third is the point. A gap is not an error: it's the app being honest
 * that this athlete's goals reach past what's built, and it's the queue that
 * tells us which block to build next — written by real goals rather than
 * guessed at.
 */

import { type Goal, type GoalType, defaultDiscipline } from "../goal";
import { type BlockPreferences, type ConnectorPreferences, type FeaturePreferences, DEFAULT_BLOCK_PREFERENCES } from "../preferences";
import {
  type Block,
  type Capability,
  type SurfaceId,
  BLOCKS,
  CAPABILITY_LABELS,
  CAPABILITY_NEEDS,
  DISCIPLINE_NEEDS,
  FEATURE_NEEDS,
} from "./blocks";

export interface AssembledSurface {
  id: SurfaceId;
  title: string;
  blocks: Array<{ id: string; title: string; note?: string }>;
}

export interface CapabilityGap {
  capability: Capability;
  label: string;
  /** Goal labels that wanted it — so the athlete sees *why* it's missing, not just that it is. */
  wantedBy: string[];
  /** Set when a block for it is declared but unbuilt; absent when nothing in the catalog covers it at all. */
  plannedBlockId?: string;
  note?: string;
}

export interface AssembledApp {
  surfaces: AssembledSurface[];
  capabilities: Capability[];
  gaps: CapabilityGap[];
  /** Athlete-facing summary of what drove the assembly. */
  basis: { goalTypes: GoalType[]; disciplines: string[]; activeGoalCount: number };
}

/** Stands in for a goal label when the demand came from a preference, not a goal. */
export const STATED_PREFERENCE = "You asked for this during onboarding";

const SURFACE_TITLES: Record<SurfaceId, string> = {
  plan: "Plan",
  goals: "Goals",
  athlete: "Athlete",
  coach: "Coach",
  data: "Data",
};

/** Display order, which is also nav order. */
const ALL_SURFACES: SurfaceId[] = ["plan", "goals", "athlete", "coach", "data"];

/**
 * Surfaces that survive even when empty. Goals and Coach are how you change
 * the goal model — assembling them away would leave an athlete with no goals
 * unable to add one, and someone who switched every block off unable to
 * switch one back on. Plan is the product.
 *
 * Everything else collapses when it holds nothing, so five tabs is a default
 * rather than a fixed shape.
 */
const ESSENTIAL_SURFACES = new Set<SurfaceId>(["plan", "goals", "coach"]);

/** A goal still influencing the app: active, and not already in the past. */
export function isLiveGoal(goal: Goal, today: string): boolean {
  return goal.active && goal.targetDate >= today;
}

/**
 * Does the goal model imply this block? Separate from `blockApplies` so an
 * explicit athlete choice can override the inference without the two getting
 * tangled together.
 */
function inferredFromGoals(block: Block, goals: Goal[], connectors: ConnectorPreferences, features: FeaturePreferences): boolean {
  if (block.requiresFeature && !features[block.requiresFeature]) return false;
  if (block.requiresConnector && !connectors[block.requiresConnector]) return false;
  if (block.goalTypes === "*") return true;
  // A stated fact about the athlete's life can imply a block their goals
  // don't. "I own a bike" is not a goal and never will be, but it decides
  // whether an injury substitute is possible — and whether the FTP that
  // prices it is a number they can see and correct.
  if (block.enabledByFeature?.some((feature) => features[feature])) return true;

  const types = block.goalTypes;
  return goals.some((goal) => {
    if (!types.includes(goal.type)) return false;
    if (!block.disciplines) return true;
    return block.disciplines.includes(goal.discipline ?? defaultDiscipline(goal.type));
  });
}

function blockApplies(
  block: Block,
  goals: Goal[],
  connectors: ConnectorPreferences,
  features: FeaturePreferences,
  blockPrefs: BlockPreferences,
): boolean {
  // The athlete's explicit answer wins over anything inferred from their
  // goals, in both directions. Inference is a good default, not a verdict.
  const choice = blockPrefs[block.id];
  if (choice === "off") return false;
  if (choice === "on") return true;
  return inferredFromGoals(block, goals, connectors, features);
}

export function assembleApp(
  goals: Goal[],
  connectors: ConnectorPreferences,
  features: FeaturePreferences,
  today: string,
  blockPrefs: BlockPreferences = DEFAULT_BLOCK_PREFERENCES,
): AssembledApp {
  const live = goals.filter((goal) => isLiveGoal(goal, today));

  // With no live goals there is nothing to assemble against, so every
  // universal block applies and nothing goal-specific does. That's the
  // correct empty state: a new athlete sees the shell and the coach, not a
  // page of triathlon fields they never asked for.
  const applicable = BLOCKS.filter((block) => blockApplies(block, live, connectors, features, blockPrefs));

  // A block the athlete switched off must also stop reporting its gap.
  // Continuing to tell someone that a feature they declined isn't built yet
  // is nagging dressed up as honesty.
  const declined = new Set<Capability>();
  for (const block of BLOCKS) {
    if (blockPrefs[block.id] !== "off") continue;
    for (const capability of block.provides) declined.add(capability);
  }
  const built = applicable.filter((block) => block.status === "built");
  const renderable = built.filter((block) => block.surface !== "engine");

  const surfaces: AssembledSurface[] = ALL_SURFACES.map((id) => ({
    id,
    title: SURFACE_TITLES[id],
    blocks: renderable
      .filter((block) => block.surface === id)
      .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
      .map((block) => ({ id: block.id, title: block.title, ...(block.note ? { note: block.note } : {}) })),
  })).filter((surface) => surface.blocks.length > 0 || ESSENTIAL_SURFACES.has(surface.id));

  const provided = new Set<Capability>();
  for (const block of built) for (const capability of block.provides) provided.add(capability);

  // Demand side: what each live goal needs, remembering which goal asked, so
  // a gap can name the goal rather than being an abstract missing feature.
  const wantedBy = new Map<Capability, string[]>();
  for (const goal of live) {
    const discipline = goal.discipline ?? defaultDiscipline(goal.type);
    const needs = [...(CAPABILITY_NEEDS[goal.type] ?? []), ...(DISCIPLINE_NEEDS[discipline] ?? [])];
    for (const capability of needs) {
      if (provided.has(capability) || declined.has(capability)) continue;
      const list = wantedBy.get(capability) ?? [];
      if (!list.includes(goal.label)) list.push(goal.label);
      wantedBy.set(capability, list);
    }
  }

  // A `planned` block that would have applied is the richer explanation for a
  // gap — it means we've named the thing and not built it, rather than never
  // having considered it. Prefer it when one exists.
  const plannedByCapability = new Map<Capability, Block>();
  for (const block of applicable) {
    if (block.status !== "planned") continue;
    for (const capability of block.provides) {
      if (!plannedByCapability.has(capability)) plannedByCapability.set(capability, block);
    }
  }

  // Switching an unbuilt block ON is itself a statement of need — arguably the
  // clearest one the athlete can make. Reporting the gap is the honest answer;
  // silently doing nothing with their choice is the failure mode this whole
  // catalog exists to prevent.
  for (const block of BLOCKS) {
    if (blockPrefs[block.id] !== "on" || block.status === "built") continue;
    for (const capability of block.provides) {
      if (provided.has(capability)) continue;
      const list = wantedBy.get(capability) ?? [];
      if (!list.includes(STATED_PREFERENCE)) list.push(STATED_PREFERENCE);
      wantedBy.set(capability, list);
    }
  }

  // A preference the athlete stated is demand too — see FEATURE_NEEDS.
  for (const [feature, needs] of Object.entries(FEATURE_NEEDS) as Array<[keyof FeaturePreferences, Capability[]]>) {
    if (!features[feature]) continue;
    for (const capability of needs) {
      if (provided.has(capability) || declined.has(capability)) continue;
      const list = wantedBy.get(capability) ?? [];
      if (!list.includes(STATED_PREFERENCE)) list.push(STATED_PREFERENCE);
      wantedBy.set(capability, list);
    }
  }

  const gaps: CapabilityGap[] = [...wantedBy.entries()]
    .map(([capability, labels]) => {
      const planned = plannedByCapability.get(capability);
      return {
        capability,
        label: CAPABILITY_LABELS[capability],
        // Sorted, because otherwise this list is in the order the goals
        // happened to be created in — and assembly has to depend on the goal
        // MODEL, not on the order someone typed it in. Nothing was wrong
        // until two goals wanted the same missing capability, which is
        // exactly the sort of latent order-dependence the determinism test
        // exists to catch.
        wantedBy: [...labels].sort(),
        ...(planned ? { plannedBlockId: planned.id, ...(planned.note ? { note: planned.note } : {}) } : {}),
      };
    })
    .sort((a, b) => b.wantedBy.length - a.wantedBy.length || a.capability.localeCompare(b.capability));

  return {
    surfaces,
    capabilities: [...provided].sort(),
    gaps,
    basis: {
      goalTypes: [...new Set(live.map((g) => g.type))].sort(),
      disciplines: [...new Set(live.map((g) => g.discipline ?? defaultDiscipline(g.type)))].sort(),
      activeGoalCount: live.length,
    },
  };
}
