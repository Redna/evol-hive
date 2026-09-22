/**
 * Spec 058 coverage tests — Eligibility-Bound Plan Affordances
 * ============================================================
 * PR #208 is a **spec-only PR** that introduces the specification document
 * `docs/specs/058-eligibility-bound-plan-affordances.md` (4 requirements,
 * 8 acceptance criteria). No implementation code is included in this PR —
 * issue #206 stays open for the Developer.
 *
 * This file serves three purposes (the established spec-only-PR pattern, cf.
 * `spec-019-coverage.test.ts`):
 *
 * 1. **Spec document validation** — Active tests that verify the spec file
 *    exists, is well-formed, has the correct number of requirements and
 *    acceptance criteria, references the right architecture sections/issue/
 *    related specs, and that `docs/specs/INDEX.md` is updated.
 *
 * 2. **Spec assumption verification** — Active tests that confirm the
 *    subsystem the spec's root-cause analysis depends on already exists in
 *    the codebase (`getEligibleAffordancesInRoom`, the conversation-manager
 *    role projection, the perception-bridge wiring, the plan enum builder).
 *    This validates the spec's claim that the fix is *wiring an existing
 *    projection*, not building a new one.
 *
 * 3. **AC test coverage pins** — a routing map from each acceptance
 *    criterion to the per-layer suite that now asserts it (the implementation
 *    PR landed). AC-7 (live run) is evidence on issue #206, not a CI test.
 *
 * Layer routing: AC-1/AC-2/AC-3 are engine unit tests here; AC-4 (assembled
 * engine + cognition stack) lives in `packages/assembly/tests/`; AC-5/AC-6 are
 * cognition tests; AC-7 is live-run evidence (documented, not CI); AC-8 is the
 * regression gate.
 *
 * Coverage summary:
 *   - AC-1 through AC-8: implemented in the per-layer suites (pinned below)
 *   - Spec document structure: 8 active tests
 *   - INDEX.md update: 3 active tests
 *   - Existing-scaffolding verification: 6 active tests
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '../../..');
const SPEC_PATH = join(REPO_ROOT, 'docs/specs/058-eligibility-bound-plan-affordances.md');
const INDEX_PATH = join(REPO_ROOT, 'docs/specs/INDEX.md');

function readFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

// ─── Spec Document Validation ───────────────────────────────────────────────

describe('Spec 058 — Document structure', () => {
  it('spec file exists at docs/specs/058-eligibility-bound-plan-affordances.md', () => {
    expect(fileExists(SPEC_PATH)).toBe(true);
  });

  it('spec file has the correct title', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain(
      "# Feature: Eligibility-Bound Plan Affordances — Constrain the Plan Value Space to the Agent's Moment-Scoped Eligible Set",
    );
  });

  it('spec file contains exactly 4 requirements (R1–R4)', () => {
    const content = readFile(SPEC_PATH);
    const reqMatches = content.match(/^### R\d[^\n]*/gm);
    expect(reqMatches).not.toBeNull();
    expect(reqMatches!.length).toBe(4);
  });

  it('spec file contains exactly 8 acceptance criteria', () => {
    const content = readFile(SPEC_PATH);
    // Count AC definitions regardless of checkbox state — the boxes are ticked
    // as criteria are verified, but the spec must always define exactly eight.
    const acMatches = content.match(/^- \[[ x]\] \*\*AC-\d+\*\*/gm);
    expect(acMatches).not.toBeNull();
    expect(acMatches!.length).toBe(8);
  });

  it('spec file references the touched architecture sections (§3, §4, §6, §7, §10)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('§3');
    expect(content).toContain('§4');
    expect(content).toContain('§6');
    expect(content).toContain('§7');
    expect(content).toContain('§10');
  });

  it('spec file references issue #206', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('#206');
  });

  it('spec file references the precedent specs (033, 037, 039, 051)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('033');
    expect(content).toContain('037');
    expect(content).toContain('039');
    expect(content).toContain('051');
  });

  it('spec file scopes the change to the engine + cognition packages', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('`engine`');
    expect(content).toContain('`cognition`');
    expect(content).toContain('`shared` is unchanged');
  });
});

// ─── INDEX.md Validation ────────────────────────────────────────────────────

describe('Spec 058 — INDEX.md update', () => {
  it('INDEX.md contains the spec 058 row with the correct title and a status', () => {
    const content = readFile(INDEX_PATH);
    const row = content
      .split('\n')
      .find((line) => line.includes('[058](058-eligibility-bound-plan-affordances.md)'));
    expect(row).toBeDefined();
    expect(row).toContain('Eligibility-Bound Plan Affordances');
    // The status is a MUTABLE ledger field — it moves from `🔍 In Review` to
    // `✅ Done` when the PR merges. Pinning the exact value made this test fail
    // the moment the INDEX was reconciled against merged PRs, so assert that a
    // valid status marker is present instead of which one.
    expect(row).toMatch(
      /(📝 Drafted|🔨 In Development|🔍 In Review|✅ (Done|Implemented|Documented)|🚫 Blocked|⛔ Superseded)/,
    );
  });

  it('INDEX.md references issue #206 for spec 058', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('#206');
  });

  it('INDEX.md lists the engine and cognition packages for spec 058', () => {
    const content = readFile(INDEX_PATH);
    const row = content
      .split('\n')
      .find(
        (line) =>
          line.includes('docs/specs/058-eligibility-bound-plan-affordances.md') ||
          (line.includes('[058]') && line.includes('058-')),
      );
    expect(row).toBeDefined();
    expect(row).toContain('engine, cognition');
  });
});

// ─── Existing Scaffolding Verification ──────────────────────────────────────
//
// The spec's root cause is that `getEligibleAffordancesInRoom` already exists
// and is already wired into the perception bridge, but the plan path never
// calls it. These tests verify that claim against the current codebase — the
// fix is *composition*, not new machinery.

describe('Spec 058 — Existing scaffolding: engine eligibility projection', () => {
  const perceptionPath = join(REPO_ROOT, 'packages/engine/src/agents/perception/index.ts');

  it('the perception provider defines getEligibleAffordancesInRoom (spec 033)', () => {
    const content = readFile(perceptionPath);
    expect(content).toContain('getEligibleAffordancesInRoom');
  });

  it('the perception provider defines getVisibleAffordancesInRoom (spec 039 fog filter)', () => {
    const content = readFile(perceptionPath);
    expect(content).toContain('getVisibleAffordancesInRoom');
    expect(content).toContain("startsWith('go_to_')");
  });

  it('the perception provider exposes setConversationManager for the spec-033 bridge', () => {
    const content = readFile(perceptionPath);
    expect(content).toContain('setConversationManager');
  });

  it('the conversation manager declares the four conversation affordances and the role projection', () => {
    const cmPath = join(REPO_ROOT, 'packages/engine/src/social/conversation-manager.ts');
    const content = readFile(cmPath);
    expect(content).toContain("['join', 'contribute', 'leave', 'observe']");
    expect(content).toContain('getEligibleAffordances');
    expect(content).toContain("['contribute', 'leave']");
    expect(content).toContain("['join', 'observe']");
  });

  it('assembly wires the conversation manager into the perception bridge', () => {
    const assemblyPath = join(REPO_ROOT, 'packages/engine/src/assembly.ts');
    const content = readFile(assemblyPath);
    expect(content).toContain('bridges.perception.setConversationManager(conversationManager)');
  });
});

describe('Spec 058 — Existing scaffolding: cognition plan enum + diagnostic home', () => {
  it('the shared plan tool builder enum-binds available affordance ids', () => {
    const schemasPath = join(REPO_ROOT, 'packages/shared/src/schemas/llm-schemas.ts');
    const content = readFile(schemasPath);
    expect(content).toContain('export function formulatePlanToolFor');
  });

  it('the plan builder feeds prunedAffordances into formulatePlanToolFor', () => {
    const planBuilderPath = join(REPO_ROOT, 'packages/cognition/src/pper/plan-builder.ts');
    const content = readFile(planBuilderPath);
    expect(content).toContain('formulatePlanToolFor');
    expect(content).toContain('prunedAffordances');
  });

  it('the drive→affordance matcher exists and consumes the affordance set', () => {
    const matcherPath = join(REPO_ROOT, 'packages/cognition/src/pper/drive-affordance-matcher.ts');
    const content = readFile(matcherPath);
    expect(content).toContain('export function matchDrivesToAffordances');
  });
});

// ─── AC Coverage Pins (implementation landed) ───────────────────────────────
//
// The AC scaffolds were activated when the implementation PR landed: the real
// assertions live in the per-layer suites below. These pins keep the routing
// auditable from the spec-coverage suite itself (AC-7 is live-run evidence,
// documented on issue #206 — not a CI test).

describe('Spec 058 — Acceptance Criteria coverage (implementation landed)', () => {
  const engineSuite = join(
    REPO_ROOT,
    'packages/engine/tests/spec-058-eligibility-bound-plan-affordances.test.ts',
  );
  const cognitionSuite = join(
    REPO_ROOT,
    'packages/cognition/tests/spec-058-plan-enum-diagnostic.test.ts',
  );
  const assemblySuite = join(REPO_ROOT, 'packages/assembly/tests/spec-058-plan-enum-e2e.test.ts');

  it('AC-1 / AC-2 / AC-3 are covered by the engine eligibility suite', () => {
    expect(fileExists(engineSuite)).toBe(true);
    const content = readFile(engineSuite);
    expect(content).toContain('AC-1');
    expect(content).toContain('AC-2');
    expect(content).toContain('AC-3');
  });

  it('AC-4 is covered by the assembled engine + cognition E2E suite', () => {
    expect(fileExists(assemblySuite)).toBe(true);
    expect(readFile(assemblySuite)).toContain('AC-4');
  });

  it('AC-5 / AC-6 are covered by the cognition diagnostic suite', () => {
    expect(fileExists(cognitionSuite)).toBe(true);
    const content = readFile(cognitionSuite);
    expect(content).toContain('AC-5');
    expect(content).toContain('AC-6');
  });

  it('AC-8 is the regression gate (pnpm -r test / typecheck / lint)', () => {
    expect(readFile(SPEC_PATH)).toContain('AC-8');
  });
});
