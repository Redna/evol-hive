#!/usr/bin/env node
/**
 * scripts/bot-approve.mjs — approve a PR as the `evol-hive-agent` GitHub App.
 * ────────────────────────────────────────────────────────────────────────────
 * Why this exists: branch protection on `main` requires a PR review, but our
 * PRs are opened with the human PAT, and GitHub forbids approving your own PR.
 * The intended counterpart (documented in docs/AGENT_TEAM_SETUP.md) is the bot
 * approving PAT-authored PRs. Without the App ID that path was unavailable and
 * merges used `--admin`, which bypasses branch protection entirely — including
 * a red required check (happened once; see the spec-058 INDEX incident).
 *
 * Config lives OUTSIDE the repo (never commit it):
 *
 *   ~/.config/evol-hive/app.env
 *     APP_ID=123456                      # numeric App ID (App settings page)
 *     APP_PRIVATE_KEY=/path/to/key.pem   # downloaded from the App settings page
 *     # optional:
 *     APP_INSTALLATION_ID=12345678       # skip installation discovery
 *     GH_OWNER=Redna
 *     GH_REPO=evol-hive
 *
 * Usage:
 *   node scripts/bot-approve.mjs <pr-number> [--body "message"]
 *   node scripts/bot-approve.mjs <pr-number> --check     # config/installation only
 *
 * No dependencies: node:crypto for the RS256 JWT, global fetch for the API.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSign } from 'node:crypto';

const CONFIG_PATH = process.env['APP_ENV_FILE'] ?? join(homedir(), '.config', 'evol-hive', 'app.env');
const API = 'https://api.github.com';

function die(message) {
  console.error(`bot-approve: ${message}`);
  process.exit(1);
}

function parseEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    die(
      `cannot read ${path}\n` +
        `  Create it (never commit it) with:\n` +
        `    APP_ID=<numeric app id>\n` +
        `    APP_PRIVATE_KEY=<absolute path to the .pem>\n` +
        `  Both come from the GitHub App settings page for the bot account.`,
    );
  }
  const out = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const base64url = (input) => Buffer.from(input).toString('base64url');

/** RS256 JWT for GitHub App authentication (valid ≤ 10 minutes). */
function appJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${signature.toString('base64url')}`;
}

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    die(`${method} ${path} → ${res.status} ${res.statusText}\n  ${text.slice(0, 300)}`);
  }
  return parsed;
}

async function resolveInstallationId(jwt, cfg) {
  if (cfg['APP_INSTALLATION_ID']) {
    return { id: Number(cfg['APP_INSTALLATION_ID']), account: undefined };
  }
  const installations = await api('/app/installations', { token: jwt });
  if (!Array.isArray(installations) || installations.length === 0) {
    die('the App has no installations — install it on the repo/owner first.');
  }
  const wanted = (cfg['GH_OWNER'] ?? '').toLowerCase();
  const match =
    installations.find((i) => String(i.account?.login ?? '').toLowerCase() === wanted) ??
    installations[0];
  return { id: match.id, account: match.account?.login };
}

async function main() {
  const args = process.argv.slice(2);
  const pr = args.find((a) => /^[0-9]+$/.test(a));
  if (!pr) die('usage: node scripts/bot-approve.mjs <pr-number> [--body "..."] [--check]');
  const checkOnly = args.includes('--check');
  const bodyIdx = args.indexOf('--body');
  const body =
    bodyIdx !== -1 && args[bodyIdx + 1]
      ? args[bodyIdx + 1]
      : 'Approved by the evol-hive-agent bot (bot-approves-PAT-authored-PR rule).';

  const cfg = parseEnvFile(CONFIG_PATH);
  const appId = cfg['APP_ID'];
  const keyPath = cfg['APP_PRIVATE_KEY'];
  if (!appId || !keyPath) die(`${CONFIG_PATH} must define APP_ID and APP_PRIVATE_KEY.`);

  let pem;
  try {
    pem = readFileSync(keyPath, 'utf8');
  } catch {
    die(`cannot read APP_PRIVATE_KEY at ${keyPath}`);
  }

  const jwt = appJwt(appId, pem);
  const inst = await resolveInstallationId(jwt, cfg);
  console.log(`bot-approve: app ${appId} → installation ${inst.id}${inst.account ? ` (${inst.account})` : ''}`);

  const token = (
    await api(`/app/installations/${inst.id}/access_tokens`, { token: jwt, method: 'POST', body: {} })
  ).token;

  const owner = cfg['GH_OWNER'] ?? 'Redna';
  const repo = cfg['GH_REPO'] ?? 'evol-hive';

  if (checkOnly) {
    const pull = await api(`/repos/${owner}/${repo}/pulls/${pr}`, { token });
    console.log(`bot-approve: OK — bot can see ${owner}/${repo}#${pr} ("${pull.title}"), state=${pull.state}`);
    console.log('bot-approve: config is valid; re-run without --check to approve.');
    return;
  }

  const review = await api(`/repos/${owner}/${repo}/pulls/${pr}/reviews`, {
    token,
    method: 'POST',
    body: { event: 'APPROVE', body },
  });
  console.log(`bot-approve: approved ${owner}/${repo}#${pr} as ${review.user?.login} (review ${review.id})`);
}

main().catch((err) => die(err?.stack ?? String(err)));
