/**
 * ADR-003 guard — CI runs no memory machinery; committed notes are the handoff
 * ============================================================================
 * ADR-003 (docs/adr/0003-memory-is-local-ci-runs-none.md) retired YAAM from CI:
 * the five agent workflows no longer cache, restore or save memory, the
 * compaction workflow is deleted, and the agent prompts hand off through
 * committed notes instead of YAAM scratchpads. Local YAAM is deliberately kept
 * for human-driven legs (that is the whole point of "local-first"), so this
 * file also asserts the local scripts survive.
 *
 * This is a policy test, not a spec test — the same precedent as
 * `spec-217-docs-only-qa-gate.test.ts` and `spec-221-stale-marker-guard-e2e.test.ts`.
 *
 * Why absence *and* presence: asserting only that YAAM is gone would still pass
 * if someone deleted the replacement instruction too, leaving the handoff
 * undocumented. So each prompt must both lose the YAAM tool and name the notes
 * file it now writes.
 *
 * Scope note: only the TOP-LEVEL task templates (`.pi/tasks/*.md`) are prompts.
 * `.pi/tasks/<feature>/` and `.pi/notes/` hold historical records that mention
 * YAAM as prose — they are history, not instructions, and are not scanned.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '../../..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github/workflows');
const AGENTS_DIR = join(REPO_ROOT, '.pi/agents');
const TASKS_DIR = join(REPO_ROOT, '.pi/tasks');
const BOOTSTRAP = join(REPO_ROOT, 'scripts/bootstrap-agent.sh');

const AGENT_WORKFLOWS = ['architect', 'developer', 'doctor', 'qa', 'responder'];

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

function workflowSteps(name: string): WorkflowStep[] {
  const wf = load(readFileSync(join(WORKFLOWS_DIR, `${name}.yml`), 'utf8')) as Workflow;
  return Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

/** Tool calls that only work when a memory daemon has been restored. */
const YAAM_TOOL_PATTERN = /yaam_search|yaam_graph_explore|yaam_workspace_(initialize|append_note)/;

/** Instructions to persist knowledge into YAAM rather than a file. */
const YAAM_RECORD_PATTERN = /YAAM\s+(note|workspace|scratchpad|breadcrumb)/i;

function promptFiles(): { path: string; body: string }[] {
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

describe('ADR-003: no memory machinery in CI', () => {
  for (const name of AGENT_WORKFLOWS) {
    it(`${name}.yml neither restores nor saves memory`, () => {
      const raw = readFileSync(join(WORKFLOWS_DIR, `${name}.yml`), 'utf8');
      expect(raw).not.toMatch(/restore-memory\.sh|save-memory\.sh/);

      for (const step of workflowSteps(name)) {
        // A step named for YAAM means the machinery is back.
        expect(step.name ?? '').not.toMatch(/yaam/i);
        const blob = JSON.stringify({ run: step.run, uses: step.uses, with: step.with });
        expect(blob).not.toMatch(/yaam-cache|yaam\/models|restore-memory|save-memory/i);
      }
    });
  }

  it('the compaction workflow is gone (the memory branch is frozen)', () => {
    expect(existsSync(join(WORKFLOWS_DIR, 'compaction.yml'))).toBe(false);
  });

  it('the CI bootstrap installs no YAAM', () => {
    expect(readFileSync(BOOTSTRAP, 'utf8')).not.toMatch(/yaam/i);
  });
});

describe('ADR-003: the local path is preserved', () => {
  // The decision was "local-first", not "remove YAAM". Deleting these would be a
  // silent scope change.
  for (const script of ['restore-memory.sh', 'save-memory.sh', 'run-compaction.sh']) {
    it(`scripts/${script} still exists for local use`, () => {
      expect(existsSync(join(REPO_ROOT, 'scripts', script))).toBe(true);
    });
  }
});

describe('ADR-003: agent prompts hand off through committed notes', () => {
  it('no prompt instructs an agent to call a YAAM tool or write a YAAM note', () => {
    const offenders = promptFiles()
      .filter(({ body }) => YAAM_TOOL_PATTERN.test(body) || YAAM_RECORD_PATTERN.test(body))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it.each([
    ['.pi/agents/architect.md', 'design-notes.md'],
    ['.pi/agents/developer.md', 'implementation-notes.md'],
    ['.pi/agents/qa-tester.md', 'docs/specs/notes/'],
    ['.pi/tasks/implement.md', 'implementation-notes.md'],
    ['.pi/tasks/qa-verify.md', 'qa-notes.md'],
  ])('%s names its notes file (%s)', (path, needle) => {
    expect(readFileSync(join(REPO_ROOT, path), 'utf8')).toContain(needle);
  });
});
