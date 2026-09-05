/**
 * systems/system1-outcome-recorder — Self-supervised outcome labeling
 * (spec 035, Req 9 / AC-4)
 * ────────────────────────────────────────────────────────────────────────────
 * When a cycle completes, the runtime labels the sample by outcome:
 *   plan changed | drive deltas applied | memory written | conversation
 *   continued → REACT (y=1); nothing changed → IGNORE (y=0). Hard-trigger
 *   samples are ALWAYS labeled REACT (the head must never learn to ignore
 *   alarms).
 *
 * Lifecycle (driven by the scheduler):
 *   - `onCycleStart` — captures the before-state (plan, drives, memory count,
 *     conversation turns) and the gate decision (p, head version, triggers).
 *   - `onTick` — advances the ticks-since-last-cycle bookkeeping (idled ticks
 *     count too).
 *   - `onCycleSettled` — captures the after-state, computes the label, and
 *     appends the full sample (feature vector + label + schema + head
 *     versions) to the JSONL session sink; updates the agent tracker.
 *
 * All state access goes through the injected `System1OutcomeProbePort` — the
 * recorder itself is pure bookkeeping (deterministic given the probe).
 */

import type {
  AgentDrives,
  CycleOutcomeSample,
  CycleStartContext,
  OutcomeSnapshot,
  System1FeatureSourcePort,
  System1OutcomeProbePort,
  System1OutcomeRecorderPort,
  System1SampleSinkPort,
} from '@evol-hive/shared';
import { FEATURE_SCHEMA_VERSION, hasHardTrigger } from '@evol-hive/shared';
import type { System1AgentTracker } from './system1-agent-tracker.js';

/** Constructor options for {@link System1OutcomeRecorderImpl}. */
export interface System1OutcomeRecorderOptions {
  probe: System1OutcomeProbePort;
  sink: System1SampleSinkPort;
  tracker: System1AgentTracker;
  /** Optional cached-feature source (embeds the feature vector in samples). */
  featureSource?: System1FeatureSourcePort | undefined;
}

interface PendingCycle {
  before: OutcomeSnapshot;
  ctx: CycleStartContext;
}

export class System1OutcomeRecorderImpl implements System1OutcomeRecorderPort {
  private readonly probe: System1OutcomeProbePort;
  private readonly sink: System1SampleSinkPort;
  private readonly tracker: System1AgentTracker;
  private readonly featureSource: System1FeatureSourcePort | undefined;
  private readonly pending = new Map<string, PendingCycle>();

  constructor(options: System1OutcomeRecorderOptions) {
    this.probe = options.probe;
    this.sink = options.sink;
    this.tracker = options.tracker;
    this.featureSource = options.featureSource;
  }

  /** Per-tick bookkeeping: advance the ticks-since-last-cycle counter. */
  onTick(agentId: string, tickNumber: number): void {
    this.tracker.noteTick(agentId, tickNumber);
  }

  /** Capture the before-state + decision at cycle start (Req 7/9). */
  onCycleStart(agentId: string, ctx: CycleStartContext): void {
    this.tracker.noteTick(agentId, ctx.tickNumber);
    void this.probe
      .snapshot(agentId)
      .then((before) => {
        this.pending.set(agentId, { before, ctx });
      })
      .catch(() => {
        // A probe failure means no sample for this cycle — never break the loop.
      });
  }

  /** Compute the label from the outcome and append the sample (Req 9). */
  onCycleSettled(agentId: string, error?: string): void {
    const pendingCycle = this.pending.get(agentId);
    this.pending.delete(agentId);
    if (!pendingCycle) return; // probe never landed — skip this sample
    void this.probe
      .snapshot(agentId)
      .then((after) => {
        const { before, ctx } = pendingCycle;

        const planChanged =
          before.planId !== after.planId || before.planStepIndex !== after.planStepIndex;
        const drivesChanged = drivesDiffer(before.drives, after.drives);
        const memoryWritten = after.memoryCount > before.memoryCount;
        const conversationContinued = after.conversationTurns > before.conversationTurns;
        const anythingChanged =
          planChanged || drivesChanged || memoryWritten || conversationContinued;

        // Req 9: hard-trigger samples are ALWAYS labeled REACT.
        const hardTrigger = hasHardTrigger(ctx.hardTriggers) || ctx.decision.hardTrigger;
        const label: 'react' | 'ignore' = anythingChanged || hardTrigger ? 'react' : 'ignore';

        const features = this.featureSource?.getFeatures(agentId) ?? null;
        const sample: CycleOutcomeSample = {
          schemaVersion: FEATURE_SCHEMA_VERSION,
          headVersion: ctx.decision.headVersion,
          agentId,
          tickNumber: ctx.tickNumber,
          simTime: ctx.simTime,
          label,
          hardTrigger,
          pReact: ctx.decision.pReact,
          outcome: {
            planChanged,
            drivesChanged,
            memoryWritten,
            conversationContinued,
          },
          scalar: features?.scalar ?? null,
          embedding: features?.embedding ?? null,
        };
        this.sink.append(sample);

        // The cycle completed — pin the drive snapshot + mutation window for
        // the trigger source (ticks-since, threshold crossings).
        this.tracker.recordCycleCompleted(
          agentId,
          toAgentDrives(after.drives),
          ctx.tickNumber,
          after.mutationSeq ?? this.tracker.getLastMutationSeq(agentId),
        );
        void error;
      })
      .catch(() => {
        // Probe failure after the cycle — skip the sample, never throw.
      });
  }
}

/** Coerces a snapshot drive map into the five canonical drives. */
function toAgentDrives(drives: Record<string, number>): AgentDrives {
  return {
    energy: drives['energy'] ?? 0,
    hunger: drives['hunger'] ?? 0,
    social: drives['social'] ?? 0,
    comfort: drives['comfort'] ?? 0,
    curiosity: drives['curiosity'] ?? 0,
  };
}

/** Compares drive maps for any change (deterministic). */
function drivesDiffer(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? 0) !== (b[key] ?? 0)) return true;
  }
  return false;
}