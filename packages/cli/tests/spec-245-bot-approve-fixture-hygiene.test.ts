/**
 * PR #245 QA coverage — no environment identity in committed test fixtures.
 * ============================================================================
 * There is no spec for this change; the reference contract is the PR body plus
 * `docs/BOT_APPROVAL.md`, whose rule is:
 *
 *   "Never commit `app.env`, the `.pem`, or the App ID. The App ID is not a
 *    secret in the credential sense, but it is environment identity and belongs
 *    with the key, out of the public repo."
 *
 * PR #245 corrects `spec-243-bot-approve-check-mode.test.ts`, whose fixtures had
 * pinned the *live* App ID / installation ID even though the script is driven
 * through a mocked `fetch` and never needed them. The behavioural contract of
 * #243 (the 7 tests in that file) is unchanged; what was missing is a guard that
 * stops the next fixture from re-introducing environment identity.
 *
 * This is a static audit in the same spirit as `packages/assembly/tests/
 * wiring-audit.test.ts`: it scans every committed source/test/doc/script file
 * for a numeric `APP_ID` / `INSTALLATION_ID` assignment and requires the value
 * to be an explicitly synthetic placeholder.
 *
 * Crucially, the audit does NOT embed the live identifiers — doing so would
 * recreate the very leak it exists to prevent. Instead it keeps an allowlist of
 * the placeholder constants the repo is allowed to publish. A future fixture
 * with a new synthetic value must be added here deliberately; pasting a real
 * value cannot pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = resolve(__dirname, '../../..');
const BOT_APPROVE_TEST = resolve(
  REPO_ROOT,
  'packages/cli/tests/spec-243-bot-approve-check-mode.test.ts',
);

/** Text-ish files worth scanning; lockfiles/binaries are handled below. */
const SCANNABLE_EXT = /\.(?:ts|tsx|mjs|cjs|js|json|ya?ml|md|sh)$/;
const MAX_SCAN_BYTES = 1024 * 1024;

/**
 * Deliberately synthetic placeholders already published in the repo. Add a new
 * entry only when a fixture genuinely needs a new obvious placeholder.
 */
const SYNTHETIC_APP_IDS = new Set(['123456']);
const SYNTHETIC_INSTALLATION_IDS = new Set(['12345678', '78901234']);

// `APP_ID=` / `APP_ID:` / `const APP_ID = '...'`, tolerating the boundary char.
const APP_ID_ASSIGNMENT = /(?:^|[^A-Za-z0-9])APP_ID[ \t]*[=:][ \t]*['"`]?(\d+)/g;
// Matches both `APP_INSTALLATION_ID=...` and a bare `INSTALLATION_ID = '...'`.
const INSTALLATION_ID_ASSIGNMENT =
  /(?:^|[^A-Za-z0-9])(?:APP_)?INSTALLATION_ID[ \t]*[=:][ \t]*['"`]?(\d+)/g;

type IdentityKey = 'APP_ID' | 'INSTALLATION_ID';

interface IdentityLiteral {
  file: string;
  line: number;
  key: IdentityKey;
  value: string;
}

const ASSIGNMENTS: ReadonlyArray<readonly [IdentityKey, RegExp]> = [
  ['APP_ID', APP_ID_ASSIGNMENT],
  ['INSTALLATION_ID', INSTALLATION_ID_ASSIGNMENT],
];

function isSynthetic(literal: IdentityLiteral): boolean {
  return literal.key === 'APP_ID'
    ? SYNTHETIC_APP_IDS.has(literal.value)
    : SYNTHETIC_INSTALLATION_IDS.has(literal.value);
}

/** Committed files only — this is about what the public repo contains. */
function committedScannableFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file !== '' && SCANNABLE_EXT.test(file));
}

function literalsIn(file: string, text: string): IdentityLiteral[] {
  const found: IdentityLiteral[] = [];
  for (const [key, pattern] of ASSIGNMENTS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (value === undefined) continue;
      const line = text.slice(0, match.index ?? 0).split('\n').length;
      found.push({ file, line, key, value });
    }
  }
  return found;
}

function scanCommittedFiles(): IdentityLiteral[] {
  return committedScannableFiles().flatMap((file) => {
    try {
      const abs = resolve(REPO_ROOT, file);
      if (statSync(abs).size > MAX_SCAN_BYTES) return [];
      return literalsIn(file, readFileSync(abs, 'utf8'));
    } catch {
      return [];
    }
  });
}

const COMMITTED_LITERALS = scanCommittedFiles();

describe('PR #245 — committed fixtures must not carry environment identity', () => {
  it('finds the known synthetic fixtures (the scanner is actually matching)', () => {
    // Sanity: if this drops to zero the guard is silently passing, not proving.
    expect(COMMITTED_LITERALS.length).toBeGreaterThanOrEqual(2);
    expect(COMMITTED_LITERALS.some((l) => l.file.endsWith('bot-approve.mjs'))).toBe(true);
    expect(
      COMMITTED_LITERALS.some((l) => l.file.endsWith('spec-243-bot-approve-check-mode.test.ts')),
    ).toBe(true);
  });

  it('every committed APP_ID / INSTALLATION_ID literal is a synthetic placeholder', () => {
    const violations = COMMITTED_LITERALS.filter((literal) => !isSynthetic(literal));
    expect(
      violations.map((v) => `${v.file}:${v.line} ${v.key}=<real-looking>`),
      'environment identity must live in ~/.config/evol-hive/app.env, never in the repo',
    ).toEqual([]);
  });
});

describe('PR #245 — the bot-approve test is sandboxed and self-contained', () => {
  const source = readFileSync(BOT_APPROVE_TEST, 'utf8');

  it('declares exactly one synthetic APP_ID and one synthetic installation ID', () => {
    const fixtures = COMMITTED_LITERALS.filter((l) =>
      l.file.endsWith('spec-243-bot-approve-check-mode.test.ts'),
    );
    expect(fixtures.map((f) => f.key).sort()).toEqual(['APP_ID', 'INSTALLATION_ID']);
    for (const fixture of fixtures) {
      expect(isSynthetic(fixture), `${fixture.key} must be synthetic`).toBe(true);
    }
  });

  it('points APP_ENV_FILE at the mkdtemp sandbox, never the live config', () => {
    // The mocked fetch means the identifiers are pure fixtures; the script is
    // only ever handed a throwaway config inside the per-run temp directory.
    // (The file may *mention* the live path in a comment — the point is that it
    // never resolves or reads it.)
    expect(source).toContain('APP_ENV_FILE: CONFIG_PATH');
    expect(source).not.toContain('homedir()');
  });
});
