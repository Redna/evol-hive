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
} from '@evol-hive/shared';
import type { LLMClient } from '../index.js';
import type { AffordanceClassifier } from '../classifier/index.js';
import {
  PerceptionServiceImpl,
  PlanServiceImpl,
  ExecuteServiceImpl,
  ReflectServiceImpl,
  PlanBuilderImpl,
  ReflectBuilderImpl,
} from './index.js';

/** Dependencies for {@link PPEROrchestratorImpl}. */
export interface PPEROrchestratorOptions {
  perceptionProvider: PerceptionDataProvider;
  planProvider: PlanDataProvider;
  executeProvider: ExecuteDataProvider;
  reflectProvider: ReflectDataProvider;
  classifier: AffordanceClassifier;
  llmClient: LLMClient;
}

/** Concrete PPEROrchestrator wiring the four phase services in sequence. */
export class PPEROrchestratorImpl {
  private readonly perceptionService: PerceptionServiceImpl;
  private readonly planService: PlanServiceImpl;
  private readonly executeService: ExecuteServiceImpl;
  private readonly reflectService: ReflectServiceImpl;

  /** Current phase per agent (defaults to 'perceive' = idle). */
  private readonly phases = new Map<string, PPERPhase>();

  constructor(options: PPEROrchestratorOptions) {
    this.perceptionService = new PerceptionServiceImpl({
      provider: options.perceptionProvider,
      classifier: options.classifier,
    });
    this.planService = new PlanServiceImpl({
      planBuilder: new PlanBuilderImpl(),
      llmClient: options.llmClient,
      dataProvider: options.planProvider,
    });
    this.executeService = new ExecuteServiceImpl({
      dataProvider: options.executeProvider,
    });
    this.reflectService = new ReflectServiceImpl({
      reflectBuilder: new ReflectBuilderImpl(),
      llmClient: options.llmClient,
      dataProvider: options.reflectProvider,
    });
  }

  /** Run a single PPER cycle for the given agent. */
  async runCycle(agentId: string): Promise<void> {
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
      this.setPhase(agentId, 'perceive');
      return;
    }

    // (3) Execute — deterministic affordance execution.
    this.setPhase(agentId, 'execute');
    const execute: ExecuteResult = await this.executeService.execute(agentId);
    if (!execute.success) {
      this.setPhase(agentId, 'perceive');
      return;
    }

    // (4) Reflect — LLM reflects, updates state/memory.
    this.setPhase(agentId, 'reflect');
    const reflect: ReflectResult = await this.reflectService.reflect(agentId, execute);
    void reflect;

    // Cycle complete — back to idle.
    this.setPhase(agentId, 'perceive');
  }

  /** Get the current phase for an agent ('perceive' when idle). */
  getPhase(agentId: string): PPERPhase {
    return this.phases.get(agentId) ?? 'perceive';
  }

  private setPhase(agentId: string, phase: PPERPhase): void {
    this.phases.set(agentId, phase);
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
