/**
 * Issue #217 QA coverage — docs-only short-circuit in .github/workflows/qa.yml
 * ============================================================================
 * PR #228 (`217-skip-qa-docs-only`) gated the expensive QA steps behind a
 * "docs-only PR" detection step so a spec-only PR releases the shared
 * `agent-pipeline` slot in seconds instead of holding it ~15 minutes.
 *
 * Issue #217 carries four draft acceptance criteria and has no spec document;
 * AC-1/AC-4 are live-CI evidence and cannot run in this suite. This file locks
 * down the *structural* contract that makes AC-2 and AC-3 hold, so a future
 * edit to `qa.yml` cannot silently un-gate an expensive step or let the
 * docs-only path reach the artifact push:
 *
 *   AC-2 — any non-doc changed file must run the full verify-coverage path.
 *   AC-3 — the docs-only path must not reach the push step.
 *
 * The docs/source classifier is extracted from the workflow itself (not copied
 * into the test) so the assertions exercise the real pattern.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '../../..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/qa.yml');

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const workflowText = readFileSync(WORKFLOW_PATH, 'utf-8');
const workflow = load(workflowText) as Workflow;

function verifyCoverageSteps(): WorkflowStep[] {
  const steps = workflow.jobs?.['verify-coverage']?.steps;
  expect(steps, 'qa.yml must define jobs.verify-coverage.steps').toBeDefined();
  return steps ?? [];
}

const steps = verifyCoverageSteps();

function findStep(fragment: string): WorkflowStep {
  const step = steps.find((s) => typeof s.name === 'string' && s.name.includes(fragment));
  expect(step, `expected a qa.yml step named like "${fragment}"`).toBeDefined();
  return step as WorkflowStep;
}

/**
 * Steps that must NOT run on a docs-only PR (issue #217 "heavy steps").
 *
 * The YAAM cache/restore/save steps were removed from this list by ADR-003 —
 * CI no longer runs memory machinery at all, so there is nothing left to gate.
 */
const GATED_STEPS = [
  'Bootstrap agent environment',
  'Run QA Agent',
  'Push QA test commits',
] as const;

/**
 * Pull the exact docs-detection pattern out of the workflow's shell so the
 * classification assertions below cannot drift from the implementation.
 */
function extractedDocsPattern(): string {
  const detection = findStep('Detect a docs-only PR');
  const match = detection.run?.match(/grep -vE '([^']+)'/);
  expect(match?.[1], 'detection step must classify docs paths with `grep -vE`').toBeDefined();
  return match?.[1] ?? '';
}

/**
 * Reimplements the shell semantics exactly:
 *   NON_DOC = files that are non-empty AND do not match the docs pattern
 *   docs_only = NON_DOC is empty
 */
function classifyDocsOnly(files: string[]): boolean {
  const pattern = new RegExp(extractedDocsPattern());
  const nonDoc = files.filter((file) => file !== '' && !pattern.test(file));
  return nonDoc.length === 0;
}

describe('Issue #217 — qa.yml docs-only short-circuit', () => {
  it('is valid YAML with the verify-coverage job', () => {
    expect(workflow.jobs?.['verify-coverage']).toBeDefined();
    // detection + the six purely-gated steps must each be present
    expect(steps.length).toBeGreaterThanOrEqual(GATED_STEPS.length + 1);
  });

  it('detects docs-only before any expensive step, and is itself unconditional', () => {
    const detection = findStep('Detect a docs-only PR');
    expect(detection.id).toBe('docs');
    expect(detection.if ?? '').toBe('');

    const detectionIndex = steps.indexOf(detection);
    for (const name of GATED_STEPS) {
      expect(steps.indexOf(findStep(name))).toBeGreaterThan(detectionIndex);
    }
  });

  it('writes docs_only=true|false to $GITHUB_OUTPUT (AC-1/AC-2 branch)', () => {
    const run = findStep('Detect a docs-only PR').run ?? '';
    expect(run).toContain('docs_only=true');
    expect(run).toContain('docs_only=false');
    expect(run).toContain('$GITHUB_OUTPUT');
  });

  it('classifies the four shapes verified in the PR body (AC-2)', () => {
    const spec = 'docs/specs/060-plan-formation-shape-failure-recovery.md';
    // spec-only and spec + INDEX → docs-only → skip
    expect(classifyDocsOnly([spec])).toBe(true);
    expect(classifyDocsOnly([spec, 'docs/specs/INDEX.md'])).toBe(true);
    // spec + a source file → non-doc → full path runs
    expect(classifyDocsOnly([spec, 'packages/cognition/src/pper/plan-builder.ts'])).toBe(false);
    // spec + an image under docs/ → still docs-only (the `docs/` prefix)
    expect(classifyDocsOnly([spec, 'docs/assets/run.png'])).toBe(true);
  });

  it('treats non-doc paths outside docs/ as code (AC-2)', () => {
    expect(classifyDocsOnly(['docs/specs/x.md', 'training/artifacts/head.onnx'])).toBe(false);
    expect(classifyDocsOnly(['.github/workflows/qa.yml'])).toBe(false);
    expect(classifyDocsOnly(['scripts/bootstrap-agent.sh'])).toBe(false);
    // a root-level markdown file is documentation
    expect(classifyDocsOnly(['README.md'])).toBe(true);
  });

  it('gates every expensive step on docs_only != true (AC-2)', () => {
    for (const name of GATED_STEPS) {
      expect(findStep(name).if, `${name} must be gated`).toBe(
        "steps.docs.outputs.docs_only != 'true'",
      );
    }
  });

  it('can never reach the QA artifact push on a docs-only PR (AC-3)', () => {
    const push = findStep('Push QA test commits');
    expect(push.if).toContain("steps.docs.outputs.docs_only != 'true'");
    // Guard the artifact contract itself: the push commits only test/notes paths.
    expect(push.run).toContain('packages/*/tests');
    expect(push.run).toContain('docs/specs/notes');
  });

  it('does not use paths-ignore — the check must always be reported', () => {
    const pullRequest = workflow.on?.['pull_request'] as
      { types?: string[]; 'paths-ignore'?: unknown } | undefined;
    expect(pullRequest).toBeDefined();
    expect(pullRequest?.types).toEqual(['opened']);
    expect(pullRequest?.['paths-ignore']).toBeUndefined();
  });
});
