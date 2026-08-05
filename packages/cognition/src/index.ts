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

/** The full context payload sent to the LLM. */
export interface LLMContextPayload {
  systemPrompt: string;
  perceptionContext: string;
  availableAffordances: import('@evol-hive/shared').Affordance[];
  cognitiveTools: import('@evol-hive/shared').CognitiveTool[];
  responseSchema: object;
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

// System 0 Classifier (Section 5) — embedding-based affordance pruning
export * from './classifier/index.js';
