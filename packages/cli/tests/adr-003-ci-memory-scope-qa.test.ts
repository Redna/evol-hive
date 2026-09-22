/**
 * ADR-003 QA coverage — the gaps the developer's guard does not close
 * ============================================================================
 * The developer's `adr-003-ci-memory-scope.test.ts` covers the core of
 * ADR-003 (`docs/adr/0003-memory-is-local-ci-runs-none.md`). QA found three
 * decisions only partially guarded and adds the missing assertions here:
 *
 *   1. The ADR explicitly rewrote the **inline prompt in `responder.yml`**
 *      away from `yaam_search`/`yaam_graph_explore`. The developer's workflow
 *      scan looks for `yaam-cache|yaam/models|restore-memory|save-memory`, and
 *      its step-name check looks for `/yaam/i`, but a re-added prose line such
 *      as "Use YAAM search and graph explore" would slip through both. The
 *      strongest guard is: the five agent workflow files contain no `yaam`
 *      anywhere.
 *   2. The developer's presence check names only 5 of the 11 top-level prompts.
 *      ADR-003 decision 3 applies to *all* of `.pi/agents/*.md` and
 *      `.pi/tasks/*.md`; every one must point at the committed-notes channel.
 *   3. ADR-003 decision 5 freezes `origin/memory` ("not deleted — history must
 *      not be rewritten"). Nothing asserted that automation cannot delete or
 *      force-push the branch.
 *
 * Same policy-test precedent as `spec-221-stale-marker-guard-e2e.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github/workflows');
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');
const AGENTS_DIR = join(REPO_ROOT, '.pi/agents');
const TASKS_DIR = join(REPO_ROOT, '.pi/tasks');
const ADR = join(REPO_ROOT, 'docs/adr/0003-memory-is-local-ci-runs-none.md');

const AGENT_WORKFLOWS = ['architect', 'developer', 'doctor', 'qa', 'responder'];

/**
 * Top-level agent + task prompts. Feature task directories (`.pi/tasks/<n>-*`)
 * and `.pi/notes/` are historical records, not instructions — they are out of
 * scope, matching the developer's guard.
 */
function topLevelPrompts(): { path: string; body: string }[] {
  const agents = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ path: `.pi/agents/${f}`, body: readFileSync(join(AGENTS_DIR, f), 'utf8') }));
  const tasks = readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => ({
      path: `.pi/tasks/${e.name}`,
      body: readFileSync(join(TASKS_DIR, e.name), 'utf8'),
    }));
  return [...agents, ...tasks];
}

/** CI workflows plus local scripts — everything that can touch a git remote. */
function automationFiles(): { path: string; body: string }[] {
  const workflows = readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({
      path: `.github/workflows/${f}`,
      body: readFileSync(join(WORKFLOWS_DIR, f), 'utf8'),
    }));
  const scripts = readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.sh'))
    .map((f) => ({ path: `scripts/${f}`, body: readFileSync(join(SCRIPTS_DIR, f), 'utf8') }));
  return [...workflows, ...scripts];
}

/**
 * Operations that would delete or rewrite the frozen `origin/memory` branch.
 * `git worktree remove --force` is intentionally not matched — it does not
 * touch the remote branch and is used by the retained local scripts.
 */
const MEMORY_REWRITE_PATTERNS: RegExp[] = [
  /git\s+push\b[^\n]*--delete[^\n]*memory/i,
  /git\s+push\b[^\n]*--force[^\n]*memory/i,
  /git\s+push\b[^\n]*memory[^\n]*--force/i,
  /git\s+push\b[^\n]*:\s*(?:refs\/heads\/)?memory\b/i,
  /git\s+branch\s+-D\b[^\n]*memory/i,
  /git\s+update-ref\s+-d\b[^\n]*memory/i,
];

describe('ADR-003 (QA): workflow bodies carry no YAAM at all', () => {
  for (const name of AGENT_WORKFLOWS) {
    it(`${name}.yml has no yaam reference, inline prompts included`, () => {
      const raw = readFileSync(join(WORKFLOWS_DIR, `${name}.yml`), 'utf8');
      // The developer's guard scans step names and a narrow blob; this scans
      // the whole file, so prose in an inline `run:` prompt cannot reintroduce
      // a YAAM tool call.
      expect(raw).not.toMatch(/yaam/i);
    });
  }
});

describe('ADR-003 (QA): every prompt names the committed-notes channel', () => {
  const prompts = topLevelPrompts();

  it('enumerates the full set of top-level prompts (6 agents + 5 tasks)', () => {
    expect(prompts.map((p) => p.path).sort()).toEqual([
      '.pi/agents/architect.md',
      '.pi/agents/developer.md',
      '.pi/agents/doctor.md',
      '.pi/agents/overseer.md',
      '.pi/agents/qa-tester.md',
      '.pi/agents/responder.md',
      '.pi/tasks/continue.md',
      '.pi/tasks/diagnose.md',
      '.pi/tasks/draft-spec.md',
      '.pi/tasks/implement.md',
      '.pi/tasks/qa-verify.md',
    ]);
  });

  for (const { path, body } of prompts) {
    it(`${path} points at docs/specs/notes`, () => {
      expect(body).toContain('docs/specs/notes');
    });
  }
});

describe('ADR-003 (QA): origin/memory stays frozen, not deleted', () => {
  it('the ADR states the decision and its scope', () => {
    expect(existsSync(ADR)).toBe(true);
    const adr = readFileSync(ADR, 'utf8');
    expect(adr).toContain('CI runs no memory machinery');
    expect(adr).toContain('frozen, not deleted');
  });

  it('no workflow or script deletes or force-pushes the memory branch', () => {
    const offenders: string[] = [];
    for (const { path, body } of automationFiles()) {
      for (const pattern of MEMORY_REWRITE_PATTERNS) {
        if (pattern.test(body)) offenders.push(`${path} matches ${String(pattern)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
