/**
 * pper/reflect-builder — LLM context payload construction for the Reflect phase
 * ─────────────────────────────────────────────────────────────────────────────
 * Section 6 / §7 / §8 / spec 004: Transforms the agent's current state and the
 * Execute-phase result into the `LLMContextPayload` sent to the heavy LLM during
 * reflection. Uses tool calling (spec 011) — sends `reflectTool`.
 *
 * Persona injection (spec 012, Req 9): When `profile` is present and non-null,
 * the system prompt starts with the persona text and includes a persona-weighted
 * memory importance instruction. The context includes the agent's long-term
 * goals (aspirations) when present.
 */

import type { AgentInternalState, AgentProfile, ExecuteResult } from '@evol-hive/shared';
import {
  reflectTool,
  queryMemoryTool,
  updateInternalStateTool,
  formatPersona,
} from '@evol-hive/shared';
import type { LLMContextPayload, ReflectBuilder } from '../index.js';
import { defaultCognitiveTools } from '../tools/index.js';

/** Concrete ReflectBuilder producing the LLM context payload for reflection. */
export class ReflectBuilderImpl implements ReflectBuilder {
  build(
    _agentId: string,
    agentState: AgentInternalState,
    executeResult: ExecuteResult,
    profile?: AgentProfile | null,
  ): LLMContextPayload {
    const systemPrompt = buildSystemPrompt(profile);

    // Spec 021, Req 2: Stable content first (deterministic for a given
    // execution result), dynamic content last (separated by `---`).
    const stableLines: string[] = [];

    // Persona context: long-term goals / aspirations (spec 012, Req 18).
    if (profile && profile.longTermGoals !== undefined && profile.longTermGoals.length > 0) {
      stableLines.push(`Aspirations: ${profile.longTermGoals.join('; ')}`);
    }

    // Execution result status.
    if (executeResult.success) {
      stableLines.push('Execution result: success');
    } else {
      stableLines.push('Execution result: failure');
    }

    // Error message if any.
    if (executeResult.error !== undefined) {
      stableLines.push(`Error: ${executeResult.error}`);
    }

    // Affordance result summary.
    if (executeResult.result !== undefined) {
      const ar = executeResult.result;
      if (ar.driveChanges !== undefined) {
        const changes = Object.entries(ar.driveChanges)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        stableLines.push(`Drive changes applied: ${changes}`);
      }
      if (ar.failureReason !== undefined) {
        stableLines.push(`Failure reason: ${ar.failureReason}`);
      }
    }

    // Step skipped info.
    if (executeResult.stepSkipped === true) {
      stableLines.push('Note: step was skipped (non-physical step, no affordance executed).');
    }

    // Agent's current goal.
    stableLines.push(`Current goal: ${agentState.currentGoal}`);

    // Plan status.
    if (executeResult.planComplete) {
      stableLines.push('Plan status: complete');
    } else {
      stableLines.push('Plan status: in-progress');
    }

    // ── Dynamic content (current drive values change per tick) ───────────────
    const driveSummary = formatDrives(agentState.drives);
    const dynamicLines: string[] = [`Drives: ${driveSummary}`];

    const contextLines = [...stableLines, '---', ...dynamicLines];

    // Select only the update_internal_state tool (for prompt text).
    const updateStateToolList = defaultCognitiveTools.filter(
      (tool) => tool.name === 'update_internal_state',
    );

    return {
      systemPrompt,
      perceptionContext: contextLines.join('\n'),
      availableAffordances: [],
      cognitiveTools: updateStateToolList,
      tools: [reflectTool, queryMemoryTool, updateInternalStateTool],
    };
  }
}

function buildSystemPrompt(profile: AgentProfile | null | undefined): string {
  if (profile) {
    const personaText = formatPersona(profile);
    return [
      `You are ${profile.name}, ${personaText}.`,
      'You must reflect on the outcome of your last action.',
      'Evaluate whether your goal or drives need adjustment based on what happened.',
      'Decide if a memory entry should be stored for future reference.',
      'Consider your personality when deciding what is worth remembering.',
      'Use the update_internal_state cognitive tool to adjust your goal, drives, or store a memory.',
    ].join(' ');
  }
  return [
    'You are an autonomous NPC in a deterministic simulation.',
    'You must reflect on the outcome of your last action.',
    'Evaluate whether your goal or drives need adjustment based on what happened.',
    'Decide if a memory entry should be stored for future reference.',
    'Use the update_internal_state cognitive tool to adjust your goal, drives, or store a memory.',
  ].join(' ');
}

function formatDrives(drives: object): string {
  // Spec 021, Req 3: Round drive values to the nearest integer in the user
  // message so the KV cache prefix is stable across ticks.
  return Object.entries(drives)
    .map(([name, value]) => `${name}=${Math.round(value as number)}`)
    .join(', ');
}

export {};
