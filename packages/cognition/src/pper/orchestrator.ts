/**
 * pper/orchestrator — PPER cycle orchestration (spec 005, Req 11, 12, 13)
 * ────────────────────────────────────────────────────────────────────────────
 * Implements the `PPEROrchestrator` interface. `runCycle(agentId)` executes
 * the four phases in sequence: perceive → plan → execute → reflect. If any
 * phase returns `success: false`, the cycle aborts early (no subsequent phases
 * run). Each phase service already resets `isThinking` in its `finally` block,
 * so `isThinking` is guaranteed `false` after the cycle whether it succeeded
 * or failed.
 *
 * The orchestrator tracks the current phase per agent via `getPhase(agentId)`.
 * When no cycle is in progress, the phase is `'perceive'` (idle / ready).
 *
 * Error recovery (spec 008): The orchestrator tracks consecutive cycle failures
 * per agent. After `maxConsecutiveFailures`, it enters a cooldown period
 * during which `runCycle()` returns early. A successful cycle resets the
 * counter. "No active plan" and "stuck" states are not counted as failures.
 */

import type {
  PerceptionDataProvider,
  PlanDataProvider,
  ExecuteDataProvider,
  ReflectDataProvider,
  PPERPhase,
  PerceptionResult,
  PlanResult,
  ExecuteResult,
  ReflectResult,
  PPERErrorConfig,
  PPERCycleStatus,
} from '@evol-hive/shared';
import { defaultPPERErrorConfig } from '@evol-hive/shared';
import type { LLMClient, GuardrailEngine } from '../index.js';
import type { AffordanceGuard } from '@evol-hive/shared';
import type { AffordanceClassifier } from '../classifier/index.js';
import {
  PerceptionServiceImpl,
  PlanServiceImpl,
  ExecuteServiceImpl,
  ReflectServiceImpl,
  PlanBuilderImpl,
  ReflectBuilderImpl,
} from './index.js';
import type { BatchPlanService } from './batch-plan-service.js';

/** Dependencies for {@link PPEROrchestratorImpl}. */
export interface PPEROrchestratorOptions {
  perceptionProvider: PerceptionDataProvider;
  planProvider: PlanDataProvider;
  executeProvider: ExecuteDataProvider;
  reflectProvider: ReflectDataProvider;
  classifier: AffordanceClassifier;
  llmClient: LLMClient;
  /** Optional error recovery config (spec 008, Req 8.3, AC-25). When omitted, defaults are used. */
  errorConfig?: PPERErrorConfig;
  /** Optional guardrail engine for cognitive guardrails (spec 016, Req 12). */
  guardrail?: GuardrailEngine;
  /**
   * Optional affordance guard for stale-step detection (spec 031, Req 5).
   * Forwarded to the Execute phase's plan-validation context; implemented by
   * the engine (backed by `SmartObjectRegistry.getByRoom`) and wired in the
   * application assembly.
   */
  affordanceGuard?: AffordanceGuard;
  /**
   * Optional batch plan service for multi-agent Plan-phase batching (spec 022,
   * Req 9, AC-7). When absent, the orchestrator uses the existing per-agent
   * `PlanService.plan()` calls — no behavior change. When present, the
   * orchestrator may delegate same-room plan formulation to the batch service
   * to reduce LLM calls.
   */
  batchPlanService?: BatchPlanService;
  /**
   * Optional hook fired at the start of every PPER cycle (spec 030, Req 14a).
   * Used by the application wiring to reset per-cycle budgets such as the
   * `modify_scene` rate limit on the cognitive tool executor.
   */
  onCycleStart?: (agentId: string) => void;
}

/** Concrete PPEROrchestrator wiring the four phase services in sequence. */
export class PPEROrchestratorImpl {
  private readonly perceptionService: PerceptionServiceImpl;
  private readonly planService: PlanServiceImpl;
  private readonly executeService: ExecuteServiceImpl;
  private readonly reflectService: ReflectServiceImpl;
  private readonly errorConfig: PPERErrorConfig;
  /** Optional batch plan service (spec 022, Req 9). `undefined` when not wired in. */
  private readonly batchPlanService: BatchPlanService | undefined;
  /** Optional per-cycle start hook (spec 030, Req 14a). */
  private readonly onCycleStart: ((agentId: string) => void) | undefined;

  /** Current phase per agent (defaults to 'perceive' = idle). */
  private readonly phases = new Map<string, PPERPhase>();

  /** Consecutive failure counter per agent (spec 008, Req 2.1). */
  private readonly consecutiveFailures = new Map<string, number>();
  /** Last error message per agent. */
  private readonly lastErrors = new Map<string, string>();
  /** Timestamp when cooldown started per agent (0 = not in cooldown). */
  private readonly cooldownStartedAt = new Map<string, number>();

  constructor(options: PPEROrchestratorOptions) {
    const guardrail = options.guardrail;
    this.perceptionService = new PerceptionServiceImpl({
      provider: options.perceptionProvider,
      classifier: options.classifier,
      ...(guardrail !== undefined ? { guardrail } : {}),
    });
    this.planService = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: options.llmClient,
      dataProvider: options.planProvider,
      ...(guardrail !== undefined ? { guardrail } : {}),
    });
    this.executeService = new ExecuteServiceImpl({
      dataProvider: options.executeProvider,
      ...(guardrail !== undefined ? { guardrail } : {}),
      ...(options.affordanceGuard !== undefined
        ? { affordanceGuard: options.affordanceGuard }
        : {}),
    });
    this.reflectService = new ReflectServiceImpl({
      reflectBuilder: new ReflectBuilderImpl(),
      llmClient: options.llmClient,
      dataProvider: options.reflectProvider,
    });
    this.errorConfig = options.errorConfig ?? defaultPPERErrorConfig();
    this.batchPlanService = options.batchPlanService;
    this.onCycleStart = options.onCycleStart;
  }

  /** Run a single PPER cycle for the given agent. */
  async runCycle(agentId: string): Promise<void> {
    const failures = this.consecutiveFailures.get(agentId) ?? 0;
    const cooldownStart = this.cooldownStartedAt.get(agentId) ?? 0;

    // Per-cycle hook (spec 030, Req 14a): reset per-cycle budgets (e.g. the
    // modify_scene rate limit) before the phases run.
    this.onCycleStart?.(agentId);

    // Check cooldown (spec 008, Req 2.3).
    if (failures >= this.errorConfig.maxConsecutiveFailures) {
      const elapsed = Date.now() - cooldownStart;
      if (elapsed < this.errorConfig.failureCooldownMs) {
        // Still in cooldown — skip the cycle.
        return;
      }
      // Cooldown expired — reset and proceed (Req 2.3).
      this.consecutiveFailures.set(agentId, 0);
      this.cooldownStartedAt.delete(agentId);
      this.lastErrors.delete(agentId);
    }

    // (1) Perceive — passive (System 1), no LLM.
    this.setPhase(agentId, 'perceive');
    let perception: PerceptionResult;
    try {
      perception = await this.perceptionService.perceive(agentId);
    } finally {
      // Perceive has no success flag; clear phase to idle if we abort below.
    }

    // (2) Plan — LLM formulates a plan.
    this.setPhase(agentId, 'plan');
    const plan: PlanResult = await this.planService.plan(agentId, perception);
    if (!plan.success) {
      console.error(`[plan-failed] agent=${agentId}: ${plan.error}`);
      this.recordFailure(agentId, plan.error);
      this.setPhase(agentId, 'perceive');
      return;
    }

    // (3) Execute — deterministic affordance execution.
    this.setPhase(agentId, 'execute');
    const execute: ExecuteResult = await this.executeService.execute(agentId);
    if (!execute.success) {
      // "No active plan" is not a failure (spec 008, Req 4.1, AC-11).
      if (execute.error === 'No active plan' && execute.planComplete) {
        // Expected state — cycle completes normally.
        this.setPhase(agentId, 'perceive');
        return;
      }
      // Plan-validation deviation routes to Reflect (spec 016, Req 12, AC-22).
      if (execute.deviationRejected === true) {
        this.setPhase(agentId, 'reflect');
        const reflect: ReflectResult = await this.reflectService.reflect(agentId, execute);
        if (!reflect.success) {
          // Reflect failure on a deviation is still not counted as a cycle
          // failure — the deviation itself is a recovery path, not an error.
          this.setPhase(agentId, 'perceive');
          return;
        }
        // Successful reflect after deviation — reset failure counter.
        this.consecutiveFailures.set(agentId, 0);
        this.cooldownStartedAt.delete(agentId);
        this.lastErrors.delete(agentId);
        this.setPhase(agentId, 'perceive');
        return;
      }
      this.recordFailure(agentId, execute.error);
      this.setPhase(agentId, 'perceive');
      return;
    }

    // (4) Reflect — LLM reflects, updates state/memory.
    this.setPhase(agentId, 'reflect');
    const reflect: ReflectResult = await this.reflectService.reflect(agentId, execute);
    if (!reflect.success) {
      this.recordFailure(agentId, reflect.error);
      this.setPhase(agentId, 'perceive');
      return;
    }

    // Cycle complete — reset failure counter on success (spec 008, Req 2.1).
    this.consecutiveFailures.set(agentId, 0);
    this.cooldownStartedAt.delete(agentId);
    this.lastErrors.delete(agentId);
    this.setPhase(agentId, 'perceive');
  }

  /** Get the current phase for an agent ('perceive' when idle). */
  getPhase(agentId: string): PPERPhase {
    return this.phases.get(agentId) ?? 'perceive';
  }

  /**
   * The batch plan service wired into this orchestrator, if any (spec 022,
   * Req 9). `undefined` when batching is not enabled. Exposed so callers /
   * scheduler-level coordinators can access the batch service to drive
   * multi-agent plan batching across per-agent cycles.
   */
  getBatchPlanService(): BatchPlanService | undefined {
    return this.batchPlanService;
  }

  /** Get the cycle status for an agent (spec 008, Req 2.4, AC-8). */
  getCycleStatus(agentId: string): PPERCycleStatus {
    const failures = this.consecutiveFailures.get(agentId) ?? 0;
    const cooldownStart = this.cooldownStartedAt.get(agentId) ?? 0;
    const coolingDown =
      failures >= this.errorConfig.maxConsecutiveFailures &&
      Date.now() - cooldownStart < this.errorConfig.failureCooldownMs;
    const lastError = this.lastErrors.get(agentId);
    return {
      consecutiveFailures: failures,
      coolingDown,
      ...(lastError !== undefined ? { lastError } : {}),
    };
  }

  private setPhase(agentId: string, phase: PPERPhase): void {
    this.phases.set(agentId, phase);
  }

  /** Record a cycle failure — increment counter, store error, enter cooldown if threshold reached. */
  private recordFailure(agentId: string, error?: string): void {
    const current = this.consecutiveFailures.get(agentId) ?? 0;
    const newCount = current + 1;
    this.consecutiveFailures.set(agentId, newCount);
    if (error !== undefined) {
      this.lastErrors.set(agentId, error);
    }
    // Enter cooldown when threshold is reached (spec 008, Req 2.2).
    if (newCount >= this.errorConfig.maxConsecutiveFailures) {
      this.cooldownStartedAt.set(agentId, Date.now());
    }
  }
}

/**
 * Factory (spec 005, Req 13) that constructs a {@link PPEROrchestratorImpl}
 * from the shared data-provider bridges and an LLM client (plus the System 0
 * classifier). The resulting orchestrator can run a full PPER cycle for an
 * agent.
 */
export function createPPEROrchestrator(options: PPEROrchestratorOptions): PPEROrchestratorImpl {
  return new PPEROrchestratorImpl(options);
}

export {};
