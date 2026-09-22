/**
 * PR #243 QA coverage — `bot-approve.mjs --check` works without a PR.
 * ============================================================================
 * PR #242 introduced `scripts/bot-approve.mjs` to restore the merge gate: the
 * `evol-hive-agent` App approves PAT-authored PRs so `gh pr merge --squash`
 * satisfies branch protection without `--admin`. PR #243 is a follow-up that
 * makes `--check` usable **before a PR exists**:
 *
 *   AC-1 — `--check` with a PR still probes the pull (title/state), unchanged.
 *   AC-2 — `--check` without a PR mints the installation token, calls
 *          `GET /installation/repositories`, and states whether the configured
 *          repo is among them.
 *   AC-3 — a bare invocation (no PR, no `--check`) still fails with the usage
 *          error; config is not read and no network call is made.
 *   AC-4 — a missing/invalid config still fails with an actionable message
 *          before any network call.
 *
 * There is no spec document for this chore change; the reference behavioural
 * contract is the PR body plus docs/BOT_APPROVAL.md. The script hardcodes the
 * GitHub API origin, so the tests execute it for real in a child process with
 * a `--import` preload that replaces `globalThis.fetch` with a recording fake
 * (Node 20+). The RS256 signing path runs unmodified against a throwaway 2048
 * bit key; only the network boundary is faked. `dist/`, `session-logs` scratch
 * dirs and the developer's implementation are never touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(__dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/bot-approve.mjs');

const OWNER = 'Redna';
const REPO = 'evol-hive';
// Synthetic identifiers: the script is exercised through a mocked `fetch`, so
// the real App ID / installation ID are irrelevant here. They must NOT be the
// live values — this is a public repo, and environment identity belongs in
// ~/.config/evol-hive/app.env, never in a committed file.
const APP_ID = '123456';
const INSTALLATION_ID = '78901234';

const SANDBOX = mkdtempSync(join(tmpdir(), 'spec243-'));
const KEY_PATH = join(SANDBOX, 'app-key.pem');
const CONFIG_PATH = join(SANDBOX, 'app.env');
const PRELOAD_PATH = join(SANDBOX, 'fake-fetch.mjs');
const FETCH_LOG = join(SANDBOX, 'fetch.log');

/**
 * Preloaded before the script, so it shadows the global `fetch` the script
 * uses. It records every request and answers the three endpoints the script
 * can reach. Environment-driven so one preload serves every test case.
 */
const PRELOAD_SOURCE = String.raw`
import { appendFileSync } from 'node:fs';

const logPath = process.env['MOCK_FETCH_LOG'];
const repos = JSON.parse(process.env['MOCK_REPOS'] ?? '[]');
const pullTitle = process.env['MOCK_PULL_TITLE'] ?? 'Mock pull';
const pullState = process.env['MOCK_PULL_STATE'] ?? 'open';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const method = opts.method ?? 'GET';
  if (logPath) {
    appendFileSync(logPath, JSON.stringify({ path: u.pathname, method }) + '\n');
  }
  if (u.pathname.endsWith('/access_tokens')) {
    return json({ token: 'ghs_mock_installation_token' });
  }
  if (u.pathname === '/installation/repositories') {
    return json({ repositories: repos.map((full_name) => ({ full_name })) });
  }
  if (/\/repos\/[^/]+\/[^/]+\/pulls\/[0-9]+$/.test(u.pathname)) {
    return json({ title: pullTitle, state: pullState });
  }
  return json({ message: 'not found' }, 404);
};
`;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(KEY_PATH, privateKey);
  writeFileSync(
    CONFIG_PATH,
    [
      `APP_ID=${APP_ID}`,
      `APP_PRIVATE_KEY=${KEY_PATH}`,
      `APP_INSTALLATION_ID=${INSTALLATION_ID}`,
      `GH_OWNER=${OWNER}`,
      `GH_REPO=${REPO}`,
      '',
    ].join('\n'),
  );
  writeFileSync(PRELOAD_PATH, PRELOAD_SOURCE);
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

interface RunOptions {
  repos?: string[];
  pullTitle?: string;
  pullState?: string;
  env?: Record<string, string>;
}

interface RecordedRequest {
  path: string;
  method: string;
}

function runBotApprove(args: string[], opts: RunOptions = {}) {
  writeFileSync(FETCH_LOG, '');
  const result = spawnSync(process.execPath, ['--import', PRELOAD_PATH, SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      APP_ENV_FILE: CONFIG_PATH,
      MOCK_FETCH_LOG: FETCH_LOG,
      MOCK_REPOS: JSON.stringify(opts.repos ?? [`${OWNER}/${REPO}`]),
      MOCK_PULL_TITLE: opts.pullTitle ?? 'Mock pull',
      MOCK_PULL_STATE: opts.pullState ?? 'open',
      ...opts.env,
    },
  });
  const requests: RecordedRequest[] = readFileSync(FETCH_LOG, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RecordedRequest);
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    requests,
  };
}

const TOKEN_REQUEST: RecordedRequest = {
  path: `/app/installations/${INSTALLATION_ID}/access_tokens`,
  method: 'POST',
};

describe('PR #243 AC-2 — --check without a PR verifies the installation token', () => {
  it('lists installation repositories and reports the repo IS among them', () => {
    const run = runBotApprove(['--check'], {
      repos: [`${OWNER}/${REPO}`, 'Redna/other-repo'],
    });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      `OK — installation can see 2 repo(s); ${OWNER}/${REPO} is among them`,
    );
    expect(run.stdout).toContain('config is valid; re-run without --check to approve.');

    // It mints a token and probes the installation, but never touches a pull.
    expect(run.requests).toContainEqual(TOKEN_REQUEST);
    expect(run.requests).toContainEqual({ path: '/installation/repositories', method: 'GET' });
    expect(run.requests.some((r) => r.path.includes('/pulls/'))).toBe(false);
  });

  it('reports the repo is NOT among them when absent (negative branch)', () => {
    const run = runBotApprove(['--check'], { repos: ['Redna/other-repo'] });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      `OK — installation can see 1 repo(s); ${OWNER}/${REPO} is NOT among them`,
    );
    expect(run.requests).toContainEqual({ path: '/installation/repositories', method: 'GET' });
  });

  it('reports zero repositories without crashing', () => {
    const run = runBotApprove(['--check'], { repos: [] });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      `OK — installation can see 0 repo(s); ${OWNER}/${REPO} is NOT among them`,
    );
  });
});

describe('PR #243 AC-1 — --check with a PR is unchanged', () => {
  it('probes the pull and prints its title and state', () => {
    const run = runBotApprove(['243', '--check'], {
      pullTitle: 'chore(scripts): bot-approve --check works without a PR',
      pullState: 'open',
    });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      `OK — bot can see ${OWNER}/${REPO}#243 ("chore(scripts): bot-approve --check works without a PR"), state=open`,
    );
    expect(run.requests).toContainEqual({
      path: `/repos/${OWNER}/${REPO}/pulls/243`,
      method: 'GET',
    });
    // The installation-wide listing is only for the no-PR branch.
    expect(run.requests.some((r) => r.path === '/installation/repositories')).toBe(false);
  });
});

describe('PR #243 AC-3/AC-4 — argument and config guards still hold', () => {
  it('rejects a bare invocation (no PR, no --check) before any network call', () => {
    const run = runBotApprove([]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('usage: node scripts/bot-approve.mjs');
    expect(run.requests).toEqual([]);
  });

  it('fails with an actionable message when the config file is missing', () => {
    const run = runBotApprove(['--check'], {
      env: { APP_ENV_FILE: join(SANDBOX, 'does-not-exist.env') },
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('cannot read');
    expect(run.stderr).toContain('APP_ID');
    expect(run.stderr).toContain('APP_PRIVATE_KEY');
    // No token minted: the config guard fires first.
    expect(run.requests).toEqual([]);
  });

  it('does not leave a config file in the repo (setup is external)', () => {
    expect(existsSync(join(REPO_ROOT, '.config/evol-hive/app.env'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'app.env'))).toBe(false);
  });
});
