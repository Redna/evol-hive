# Agent Team Setup

## Architecture

```
GitHub-hosted runners (ubuntu-latest, free for public repos)
  ├── Architect  — triggered by "Status: Needs Architecture" label
  ├── Developer  — triggered by "Status: Ready for Dev" label
  └── Doctor     — triggered by CI failure on PR (fork-protected)

LLM: Ollama Cloud direct API (https://ollama.com/v1)
  └── No local daemon needed — API key stored as GitHub secret
```

## One-time setup

### 1. Create Ollama API key

Go to [ollama.com/settings/keys](https://ollama.com/settings/keys) and create an API key.

### 2. Set GitHub Secrets

Go to **Redna/evol-hive → Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value | Why |
|---|---|---|
| `OLLAMA_API_KEY` | Your Ollama API key | Authenticates with Ollama Cloud |

`GITHUB_TOKEN` is automatically provided by GitHub Actions.

### 3. Create GitHub Labels

Go to **Redna/evol-hive → Issues → Labels → New label**:

| Label | Color | Purpose |
|---|---|---|
| `Status: Needs Architecture` | `#FBCA04` | Trigger Architect agent |
| `Status: Ready for Dev` | `#0E8A16` | Trigger Developer agent |
| `Status: In Review/QA` | `#5319E7` | PR is under review |

### 4. Verify CI workflow

The existing `.github/workflows/ci.yml` runs typecheck, lint, build, and tests on PRs.
The Doctor workflow triggers when CI fails on a PR from the same repo (not forks).

## How it works

```
1. Human creates Issue + labels "Status: Needs Architecture"
   → architect.yml triggers on ubuntu-latest
   → Pi installs, connects to Ollama Cloud, runs pi-goal
   → Architect drafts spec in docs/specs/, commits, comments on issue
   → Adds "Status: Ready for Dev" label

2. "Status: Ready for Dev" label triggers developer.yml
   → Developer reads spec, writes tests (TDD), implements
   → Pushes branch, opens PR

3. PR opened → ci.yml runs (typecheck, lint, test, build)
   → If CI fails → doctor.yml triggers
   → Doctor diagnoses, fixes or escalates

4. All green → human reviews → merges
```

## Security

- **No self-hosted runner** — all jobs run on ephemeral GitHub-hosted VMs
- **Fork protection** — Doctor only runs on PRs from the same repository
- **Issue labels** — only collaborators with write access can add labels (Architect/Developer triggers are safe)
- **Secrets** — OLLAMA_API_KEY is encrypted and only available to workflows, not fork PRs

## Model configuration

The `scripts/ci-models.json` file configures the Ollama provider for CI:
- Base URL: `https://ollama.com/v1` (direct cloud API)
- Model names: **no `:cloud` suffix** (the cloud endpoint already serves cloud models)
- The bootstrap script injects the API key from the `OLLAMA_API_KEY` secret

Available models on Ollama Cloud: `https://ollama.com/api/tags`

## Bootstrapping

Each workflow job runs `scripts/bootstrap-agent.sh` which:
1. Installs Pi (`npm install -g @earendil-works/pi-coding-agent`)
2. Installs pi-goal extension
3. Writes `~/.pi/agent/models.json` with Ollama Cloud config
4. Installs project deps (`pnpm install --frozen-lockfile`)
5. Configures git for agent commits

This takes ~1-2 minutes per job. GitHub Actions caching (pnpm store) speeds up dependency installation.