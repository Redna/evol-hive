/**
 * @evol-hive/cognition — LLM Cognitive Layer
 * ──────────────────────────────────────────
 * Sections 6-8, 10: PPER loop, cognitive tools, structured outputs,
 * and cognitive guardrails.
 */

// ── PPER Loop (Section 6) ─────────────────────────────────────────────────────

/** Orchestrates the Perceive → Plan → Execute → Reflect cycle for an agent. */
export interface PPEROrchestrator {
  /** Run a single PPER cycle for the given agent. */
  runCycle(agentId: string): Promise<void>;
  /** Get the current phase for an agent. */
  getPhase(agentId: string): import('@evol-hive/shared').PPERPhase;
}

// ── Perception Builder ───────────────────────────────────────────────────────

/** Builds the context window payload for the LLM (passive perception + memory). */
export interface PerceptionBuilder {
  /** Construct the LLM context payload from the bundled Perceive-phase result. */
  build(perceptionResult: import('@evol-hive/shared').PerceptionResult): LLMContextPayload;
}

// ── Plan Builder ─────────────────────────────────────────────────────────────

/** Builds the LLM context payload specifically for plan formulation (spec 002). */
export interface PlanBuilder {
  /** Construct the plan-formulation context payload from the PerceptionResult. */
  build(perceptionResult: import('@evol-hive/shared').PerceptionResult): LLMContextPayload;
}

// ── Plan Service ──────────────────────────────────────────────────────────────

/** Orchestrates the Plan phase of the PPER loop (spec 002). */
export interface PlanService {
  /** Formulate and store a plan for the agent, given the Perceive-phase result. */
  plan(
    agentId: string,
    perceptionResult: import('@evol-hive/shared').PerceptionResult,
  ): Promise<import('@evol-hive/shared').PlanResult>;
}

// ── Reflect Service ──────────────────────────────────────────────────────────

/** Orchestrates the Reflect phase of the PPER loop (spec 004). */
export interface ReflectService {
  /** Reflect on the execution result and update agent state / store memories. */
  reflect(
    agentId: string,
    executeResult: import('@evol-hive/shared').ExecuteResult,
  ): Promise<import('@evol-hive/shared').ReflectResult>;
}

// ── Reflect Builder ──────────────────────────────────────────────────────────

/** Builds the LLM context payload for the Reflect phase (spec 004). */
export interface ReflectBuilder {
  /** Construct the reflect context payload from the agent state and execution result. */
  build(
    agentId: string,
    agentState: import('@evol-hive/shared').AgentInternalState,
    executeResult: import('@evol-hive/shared').ExecuteResult,
  ): LLMContextPayload;
}

// ── Execute Service ───────────────────────────────────────────────────────────

/** Orchestrates the Execute phase of the PPER loop (spec 003). */
export interface ExecuteService {
  /** Execute the current plan step for the agent (deterministic — no LLM). */
  execute(agentId: string): Promise<import('@evol-hive/shared').ExecuteResult>;
}

/** The full context payload sent to the LLM. */
export interface LLMContextPayload {
  systemPrompt: string;
  perceptionContext: string;
  availableAffordances: import('@evol-hive/shared').Affordance[];
  cognitiveTools: import('@evol-hive/shared').CognitiveTool[];
  responseSchema: object;
  /**
   * Concrete JSON template appended to the user message (spec 010, Req 1).
   * When provided (non-empty string), `buildUserMessage()` appends it as a
   * separate paragraph so the LLM sees the exact field names it must produce.
   * Optional for backward compatibility — existing payloads omit it.
   */
  schemaHint?: string;
}

// ── LLM Client ───────────────────────────────────────────────────────────────

/** Abstraction over local LLM backends (Ollama, vLLM, llama.cpp). */
export interface LLMClient {
  /** Send a structured output request and parse the response. */
  completeStructured(
    payload: LLMContextPayload,
  ): Promise<import('@evol-hive/shared').LLMActionResponse>;

  /** Send a background reflection request (Section 11.3). */
  completeReflection(
    systemPrompt: string,
    memoryNodes: import('@evol-hive/shared').MemorySnippet[],
  ): Promise<import('@evol-hive/shared').ReflectionResult>;

  /** Send a plan-formulation request with `formulatePlanSchema` as the grammar constraint (spec 002). */
  completePlan(
    payload: LLMContextPayload,
  ): Promise<import('@evol-hive/shared').FormulatePlanResult>;

  /** Send a reflect-phase request with `reflectSchema` as the grammar constraint (spec 004). */
  completeReflect(
    payload: LLMContextPayload,
  ): Promise<import('@evol-hive/shared').ReflectLLMResponse>;
}

// ── Cognitive Tools (Section 8) ───────────────────────────────────────────────

/** Registry and execution of intrinsic cognitive tools. */
export interface CognitiveToolRegistry {
  /** Get all available cognitive tools for the LLM. */
  getTools(): import('@evol-hive/shared').CognitiveTool[];
  /** Execute a cognitive tool by name. */
  execute(
    toolName: import('@evol-hive/shared').CognitiveToolName,
    args: Record<string, unknown>,
    agentId: string,
  ): Promise<unknown>;
}

// ── Guardrails (Section 10) ───────────────────────────────────────────────────

/** Applies cognitive guardrails before sending the prompt to the LLM. */
export interface GuardrailEngine {
  config: import('@evol-hive/shared').GuardrailConfig;
  /** Apply affordance masking if plan is empty. */
  maskAffordances(
    affordances: import('@evol-hive/shared').Affordance[],
    hasPlan: boolean,
  ): import('@evol-hive/shared').Affordance[];
  /** Validate that a physical action aligns with the active plan. */
  validateAction(
    action: string,
    plan: import('@evol-hive/shared').AgentPlan | null,
  ): { valid: boolean; reason?: string };
}

// ── Re-exports ───────────────────────────────────────────────────────────────

export * from './pper/index.js';
export * from './tools/index.js';
export * from './guardrails/index.js';
export * from './schemas/index.js';
export * from './llm/index.js';

// System 0 Classifier (Section 5) — embedding-based affordance pruning
export * from './classifier/index.js';
