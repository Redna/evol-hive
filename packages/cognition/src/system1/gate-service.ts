/**
 * system1/gate-service — System1GatePort implementation (spec 035, Req 7)
 * ────────────────────────────────────────────────────────────────────────
 * The concrete `System1GatePort` handed to the engine's `PPERScheduler` via
 * assembly (engine ↔ cognition never import each other — ADR-0001).
 *
 * `decide()` is synchronous and reads ONLY the per-agent cached feature
 * vector (no await in the scheduler hot path) and adds zero LLM calls
 * (Req 7, Req 8): the p(react) evaluation is a dot-product + sigmoid over
 * cached numbers, and hard triggers are passed in from engine state.
 *
 * Fail-open (Req 6): when no cached features exist yet (e.g. before the first
 * async embedding refresh lands), the gate passes the candidate — a missing
 * cache degrades to today's every-tick behavior, never to a bricked agent.
 */

import type {
  HardTriggerFlags,
  ReactGateDecision,
  System1FeatureSourcePort,
  System1GatePort,
} from '@evol-hive/shared';
import { hasHardTrigger } from '@evol-hive/shared';
import type { ReactGateHead } from './react-gate.js';

/** Options for {@link System1GateServiceImpl}. */
export interface System1GateServiceOptions {
  /** The shared React/Ignore head (lazy-loadable, fail-open, hot-swappable). */
  head: ReactGateHead;
  /** Synchronous cached-feature source (implemented by the feature service). */
  featureSource: System1FeatureSourcePort;
}

export class System1GateServiceImpl implements System1GatePort {
  private readonly head: ReactGateHead;
  private readonly featureSource: System1FeatureSourcePort;

  constructor(options: System1GateServiceOptions) {
    this.head = options.head;
    this.featureSource = options.featureSource;
  }

  /** Synchronous gate decision from cached features (Req 7 + exploration). */
  decide(agentId: string, tickNumber: number, hardTriggers: HardTriggerFlags): ReactGateDecision {
    const features = this.featureSource.getFeatures(agentId);
    if (features === null) {
      // No cached features yet → fail-open (pass the candidate this tick).
      return {
        pReact: 1,
        react: true,
        hardTrigger: hasHardTrigger(hardTriggers),
        headVersion: this.head.getArtifact()?.headVersion ?? 0,
        failOpen: true,
      };
    }
    return this.head.decide(agentId, tickNumber, features, hardTriggers);
  }
}
