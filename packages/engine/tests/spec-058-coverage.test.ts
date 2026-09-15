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
 * 3. **AC test scaffolds** — `it.todo()` stubs for each of the 8 acceptance
 *    criteria. These are pending tests that will be activated (converted to
 *    real `it()` tests) when the implementation PR lands. They are a
 *    verifiable checklist ensuring no AC is forgotten.
 *
 * Layer routing when activated: AC-1/AC-2/AC-3/AC-5 are engine unit tests
 * here; AC-4 (assembled engine + cognition stack) belongs in
 * `packages/assembly/tests/`; AC-6 is a cognition diagnostic test; AC-7 is
 * live-run evidence (documented, not CI); AC-8 is the regression gate.
 *
 * Coverage summary:
 *   - AC-1 through AC-8: all scaffolded as `it.todo` (implementation pending)
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
    const acMatches = content.match(/^- \[ \] \*\*AC-\d+\*\*/gm);
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
  it('INDEX.md contains the spec 058 row with the correct title and Drafted status', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('058');
    expect(content).toContain('Eligibility-Bound Plan Affordances');
    expect(content).toContain('📝 Drafted');
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

// ─── AC Scaffolds (pending until implementation) ────────────────────────────
//
// Each `it.todo` below corresponds to one acceptance criterion from the spec.
// When the implementation PR lands, convert these to real `it()` tests with
// assertions. This ensures every AC is tracked and none are forgotten.

describe('Spec 058 — Acceptance Criteria scaffolds (pending implementation)', () => {
  it.todo(
    'AC-1 (R1): Engine unit test — with an open conversation in the agent’s room, a participant’s getVisibleAffordancesInRoom contains contribute/leave and not join; a co-located non-participant contains join/observe and not contribute/leave; when the conversation is closed, none of the four appear; with the conversation manager unwired, all four appear (byte-identical legacy path). Non-conversation affordances are present in every case.',
  );

  it.todo(
    'AC-2 (R1): Fog composition test — a go_to_<unknown-room> affordance is still removed by the door-sighting gate in the same call that applies eligibility, and a known go_to_<room> survives; both filters compose without either one short-circuiting the other.',
  );

  it.todo(
    'AC-3 (R2): Collision test — a room containing a non-conversation object that declares observe plus a closed conversation object declaring observe keeps the non-conversation observe in the result; a conversation-only id (contribute) is filtered from the conversation object and never dropped from an unrelated object.',
  );

  it.todo(
    'AC-4 (R3): Cognition/integration test over the assembled engine + cognition stack (packages/assembly/tests) — an agent with no open conversation in its room yields prunedAffordances, the formulate_plan tool targetAffordance enum, and the affordance tool list all free of join/contribute/leave, while non-conversation affordances remain; an eligible participant yields contribute/leave.',
  );

  it.todo(
    'AC-5 (R3): Matcher test — matchDrivesToAffordances and the rendered drive/chain hints never reference an ineligible conversation affordance, because they consume the same filtered set.',
  );

  it.todo(
    'AC-6 (R4): Diagnostic test — exactly one [plan-enum] line is emitted per formulation, containing the agent id, room, the enum IDs, and the chosen targetAffordance values (or chosen=[none]/enum=[] for the empty cases); a thrown diagnostic never propagates.',
  );

  it.todo(
    'AC-7 (R1–R4, live): A 40-minute live run (USE_REAL_LLM=true SCENE_DURATION_MS=2400000 npx tsx examples/dynamic-world-sim.ts, cc=3, 3 agents, the #206 scene) shows skip share skips / (execs + skips) ≤ 25% (baseline 88–94%) and no single agent accounting for more than half of all [step-skip] lines; every [plan-enum] line for an agent with no eligible conversation contains none of join/contribute/leave; [plan-repeat] stays bounded; the run is executed against a freshly built dist (pnpm build). Evidence attached to issue #206.',
  );

  it.todo(
    'AC-8 (R1–R3): Regression — pnpm -r test && pnpm typecheck && pnpm lint pass; the spec-033 eligibility tests, the spec-037 enum/skip tests, the spec-039 fog tests, and the spec-051 [talk-enum] tests pass unmodified; legacy providers without a conversation manager are byte-identical.',
  );
});
