/**
 * phantom-audit.ts — the data-driven phantom-affordance audit engine
 * (spec 055, Req 3 — issue #198)
 * ────────────────────────────────────────────────────────────────────────────
 * Shared by `spec-055-phantom-affordance-audit.test.ts` (the real examples
 * audit) and its fixture tests. The audit reads the SCENE DEFINITIONS and the
 * HANDLER REGISTRY as wired in production — no hardcoded scene-specific
 * expectations beyond the documented allowlist.
 *
 * Checks (the full handler-registry × scene-affordance cross product):
 * 1. **No phantom handlers** — every registered affordance-handler id is
 *    declared by at least one scene object (across all exported scenes). The
 *    #198 phantom class: `water_plants` had a handler but no declaring object.
 * 2. **No phantom affordances** — every scene affordance's `engineEffect`
 *    resolves, in its OWN scene's production wiring, to a registered handler
 *    or a builtin `go_to_<room>` movement effect (topology-registered).
 * 3. **Stateless accounting** — every registered handler id is either
 *    allowlisted in `STATELESS_BY_DESIGN` (deliberately stateless: drive-only
 *    changes, no depletable object resource) or declared by at least one scene
 *    affordance carrying a resource gate (declarative `conditions` per spec
 *    018, or declared `preconditions`). A NEW stateless handler fails the
 *    audit until it is allowlisted with a justification.
 * 4. **Allowlist staleness** — every allowlisted id is still declared by some
 *    scene object and still resolves (the allowlist cannot rot silently).
 */

import type { SceneDefinition } from '@evol-hive/shared';

/** Builtin `go_to_<room>` movement effects are topology-registered per scene. */
export const GO_TO_PATTERN = /^go_to_.+$/;

/**
 * Deliberately stateless affordances — drive-only changes, no depletable
 * object resource (spec 055, Req 3). Each entry is a handler id with its
 * justification. Any NEW stateless handler fails the audit until it is added
 * here with a justification (the fiction justifies the absence of a resource:
 * bounding these in code without a fictional resource would relocate the
 * saturation problem without closing any loop — Architect Decision 3).
 */
export const STATELESS_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  // Coffee-shop / greenhouse "the shelf is full of herbs" — bounded by fiction
  // (spec 052 validated the greenhouse restoration path over these).
  [
    'pick_herbs',
    'the seed shelf is described as full of herbs — picking consumes no modeled resource',
  ],
  ['eat_herbs', 'herbs are unmodeled fiction (the shelf never empties) — drive-only hunger +20'],
  [
    'rest_among_seedlings',
    'resting among the potting-table seedlings consumes nothing — energy/comfort only',
  ],
  ['repot_seedlings', 'potting supplies are unmodeled — drive-only curiosity/comfort'],
  // Observation / rest / movement — no resource anywhere.
  ['observe', 'pure perception — no state, no drives'],
  ['observe_flowers', 'the flower bed is described as blooming — curiosity/comfort only'],
  ['relax', 'sitting on a bench/stool/sofa consumes nothing — comfort/energy only'],
  ['sit_outside', 'sitting outside consumes nothing — comfort/curiosity/energy only'],
  ['sleep', 'the bed is not a depletable resource — energy/comfort only'],
  ['use_bathroom', 'plumbing is unmodeled — comfort only'],
  ['wash_hands', 'plumbing is unmodeled — comfort only'],
  ['go_outside', 'leaving the lot consumes nothing (scene transition not yet modeled)'],
  // Movement — topology-registered builtin effects.
  ['go_to_*', 'room-to-room movement via the builtin doorway handler — no resource'],
  // Deliberate no-ops / counters: state keys exist but nothing depletable.
  ['take_tool', 'records tool attribution (taken_by) — the toolbox never empties'],
  ['work', 'increments a tasks_completed counter — energy-negative, consumes nothing'],
  ['build_planter', 'increments a planters_built counter — consumes no modeled material'],
  [
    'plant_seeds',
    'increments the seeds_planted growth counter (gates harvest) — plants no depletable resource',
  ],
  ['brainstorm', 'increments an ideas_generated counter — drive-only'],
  ['small_talk', 'drive-only social/energy — consumes nothing'],
  ['hold_meeting', 'increments a meetings_held counter — drive-only'],
  ['add_water', 'compound-action confirmation step — no state change needed (spec 019 Req 16)'],
  // Mutation-service effects: state lives in the scene topology, not a resource.
  ['open_gate', 'opens the garden↔workshop connection via the mutation service — no resource'],
  ['close_gate', 'closes the garden↔workshop connection via the mutation service — no resource'],
  ['carry', 'moves a portable object between rooms via the mutation service — no resource'],
  // Spec 055: the rain barrel is an UNBOUNDED SOURCE by design (Architect
  // Decision 2) — saturation lives at the planter; the source depletes nothing.
  [
    'fill_watering_can',
    'refills the planter reservoir via crossObjectStateChanges — the barrel is an unbounded source (not a sink)',
  ],
  // Spec 033 conversation affordances: the ASSEMBLER registers these handlers
  // (engine/assembly.ts) and the declaring objects are DYNAMICALLY SPAWNED
  // ConversationObjects at runtime — static scenes never declare them, and
  // they consume no resource (the conversation lifecycle is not an economy).
  [
    'conversation_join',
    'declared by dynamically-spawned ConversationObjects (spec 033, R3) — social +5 only, no resource',
  ],
  [
    'conversation_leave',
    'declared by dynamically-spawned ConversationObjects (spec 033, R3) — no drive changes, no resource',
  ],
  [
    'conversation_observe',
    'declared by dynamically-spawned ConversationObjects (spec 033, R3) — read-only observation, no resource',
  ],
  [
    'conversation_contribute',
    'declared by dynamically-spawned ConversationObjects (spec 033, R3) — args-free guidance stub, no resource',
  ],
]);

/**
 * Affordances the ENGINE declares at runtime — the spec-033 conversation
 * family: the assembler registers the handlers and dynamically-spawned
 * `ConversationObject`s declare the affordances, so no STATIC scene lists
 * them. The audit counts these as declared (checks 1 and 4) while the
 * stateless accounting (check 3) still requires their allowlist entry. Any
 * NEW runtime-declared handler must be added here with a justification —
 * an unlisted id fails the audit exactly like a static phantom.
 */
export const DYNAMICALLY_DECLARED: ReadonlyMap<string, string> = new Map([
  ['conversation_join', 'ConversationObject affordance (spec 033, R3) — spawned at runtime'],
  ['conversation_leave', 'ConversationObject affordance (spec 033, R3) — spawned at runtime'],
  ['conversation_observe', 'ConversationObject affordance (spec 033, R3) — spawned at runtime'],
  ['conversation_contribute', 'ConversationObject affordance (spec 033, R3) — spawned at runtime'],
]);

/** A violation reported by the audit. */
export interface AuditViolation {
  kind: 'phantom-handler' | 'phantom-affordance' | 'stateless-unaccounted' | 'stale-allowlist';
  /** Human-readable detail naming the offending id(s). */
  detail: string;
}

/** Whether the affordance declaration carries a resource gate (check 3). */
function hasResourceGate(affordance: {
  conditions?: unknown[];
  preconditions?: string[];
}): boolean {
  return (
    (affordance.conditions !== undefined && affordance.conditions.length > 0) ||
    (affordance.preconditions !== undefined && affordance.preconditions.length > 0)
  );
}

/** Whether a handler id is allowlisted as deliberately stateless. */
export function isStatelessByDesign(handlerId: string): boolean {
  if (STATELESS_BY_DESIGN.has(handlerId)) return true;
  return GO_TO_PATTERN.test(handlerId); // the go_to_* pattern entry
}

export interface AuditInput {
  /**
   * Registered handler ids per scene wiring — the PRODUCTION registration for
   * that scene (plugins + scene handler factories + inline registrations),
   * read from the real `AffordanceRegistryImpl.getRegisteredHandlerIds()`.
   */
  handlerIdsByScene: Map<string, string[]>;
  /** Every exported example scene definition. */
  scenes: SceneDefinition[];
}

/**
 * Run the four audit checks over the given scenes × wirings. Pure — takes the
 * data as input so fixture tests can inject synthetic scenes/wirings.
 */
export function auditScenes(input: AuditInput): AuditViolation[] {
  const violations: AuditViolation[] = [];

  // Declared-affordance ledger (cross-scene): affordance id → declaring
  // affordances (an id may be declared by several scenes — e.g. observe).
  const declared = new Map<string, { sceneId: string; gated: boolean }[]>();
  for (const scene of input.scenes) {
    for (const object of scene.objects) {
      for (const affordance of object.affordances) {
        const entries = declared.get(affordance.id) ?? [];
        entries.push({ sceneId: scene.id, gated: hasResourceGate(affordance) });
        declared.set(affordance.id, entries);
      }
    }
  }

  // (1) No phantom handlers: every registered handler id is declared by at
  // least one scene object.
  const allHandlerIds = new Set<string>();
  for (const ids of input.handlerIdsByScene.values()) {
    for (const id of ids) allHandlerIds.add(id);
  }
  for (const handlerId of [...allHandlerIds].sort()) {
    if (!declared.has(handlerId) && !DYNAMICALLY_DECLARED.has(handlerId)) {
      violations.push({
        kind: 'phantom-handler',
        detail: `handler '${handlerId}' is registered but declared by no scene object`,
      });
    }
  }

  // (2) No phantom affordances: every scene affordance's engineEffect resolves
  // in its OWN scene's wiring (registered handler or go_to_<room in scene>).
  for (const scene of input.scenes) {
    const wired = new Set(input.handlerIdsByScene.get(scene.id) ?? []);
    const roomIds = new Set(scene.rooms.map((r) => r.id));
    for (const object of scene.objects) {
      for (const affordance of object.affordances) {
        const effect = affordance.engineEffect;
        const isMovement = GO_TO_PATTERN.test(effect) && roomIds.has(effect.slice('go_to_'.length));
        if (!wired.has(effect) && !isMovement) {
          violations.push({
            kind: 'phantom-affordance',
            detail: `affordance '${affordance.id}' on '${object.id}' (scene '${scene.id}') has unresolvable engineEffect '${effect}'`,
          });
        }
      }
    }
  }

  // (3) Stateless accounting: a registered handler that is NOT allowlisted
  // must be declared by at least one scene affordance with a resource gate —
  // otherwise it is a NEW stateless handler that must join the allowlist.
  for (const handlerId of [...allHandlerIds].sort()) {
    if (isStatelessByDesign(handlerId)) continue;
    const declarations = declared.get(handlerId) ?? [];
    if (!declarations.some((d) => d.gated)) {
      violations.push({
        kind: 'stateless-unaccounted',
        detail: `handler '${handlerId}' has no resource-gated declaration and is not in STATELESS_BY_DESIGN — justify it in the allowlist or gate its resource`,
      });
    }
  }

  // (4) Allowlist staleness: every allowlisted id is still declared somewhere.
  // The `go_to_*` pattern entry documents the movement family — not a literal id.
  for (const handlerId of STATELESS_BY_DESIGN.keys()) {
    if (GO_TO_PATTERN.test(handlerId)) continue;
    if (!declared.has(handlerId) && !DYNAMICALLY_DECLARED.has(handlerId)) {
      violations.push({
        kind: 'stale-allowlist',
        detail: `STATELESS_BY_DESIGN entry '${handlerId}' is declared by no scene object — remove the stale entry`,
      });
    }
  }

  return violations;
}

export {};
