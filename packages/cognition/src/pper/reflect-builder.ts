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

    const contextLines: string[] = [];

    // Persona context: long-term goals / aspirations (spec 012, Req 18).
    if (profile && profile.longTermGoals !== undefined && profile.longTermGoals.length > 0) {
      contextLines.push(`Aspirations: ${profile.longTermGoals.join('; ')}`);
    }

    // Execution result status.
    if (executeResult.success) {
      contextLines.push('Execution result: success');
    } else {
      contextLines.push('Execution result: failure');
    }

    // Error message if any.
    if (executeResult.error !== undefined) {
      contextLines.push(`Error: ${executeResult.error}`);
    }

    // Affordance result summary.
    if (executeResult.result !== undefined) {
      const ar = executeResult.result;
      if (ar.driveChanges !== undefined) {
        const changes = Object.entries(ar.driveChanges)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        contextLines.push(`Drive changes applied: ${changes}`);
      }
      if (ar.failureReason !== undefined) {
        contextLines.push(`Failure reason: ${ar.failureReason}`);
      }
    }

    // Step skipped info.
    if (executeResult.stepSkipped === true) {
      contextLines.push('Note: step was skipped (non-physical step, no affordance executed).');
    }

    // Agent's current drives.
    const driveSummary = formatDrives(agentState.drives);
    contextLines.push(`Drives: ${driveSummary}`);

    // Agent's current goal.
    contextLines.push(`Current goal: ${agentState.currentGoal}`);

    // Plan status.
    if (executeResult.planComplete) {
      contextLines.push('Plan status: complete');
    } else {
      contextLines.push('Plan status: in-progress');
    }

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
  return Object.entries(drives)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ');
}

export {};
