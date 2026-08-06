# Autonomous Agent Delivery Team

> How we bootstrapped an autonomous AI agent team for evol-hive using GitHub Actions, Ollama Cloud, Pi, pi-goal, YAAM, and a GitHub App for bot identity.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  HUMAN (Product Owner)                                           │
│  Creates issues → merges spec PRs → merges code PRs              │
│  Brainstorms with Overseer (interactive Pi session)              │
└─────┬────────────────────────────────────────────────────────────┘
      │ 1. Create Issue + label "Status: Needs Architecture"
      │ 2. Dispatch Architect (Actions tab)
      ▼
┌─────────────────────────────────────────────────────────────────┐
│  CONTROLLER (orchestration + circuit breaker)                   │
│  Triggered by: workflow_run (agent completions)                 │
│               pull_request closed (spec PR merges)               │
│  • Decides next agent to run                                     │
│  • Auto-dispatches Developer when spec PR is merged             │
│  • Auto-dispatches CI + QA when Developer creates a PR          │
│  • Retries failed agents (max 2-3 attempts)                     │
│  • Escalates to @owner when retries exhausted                   │
│  • Posts "All checks passed" when CI + QA are green             │
└──┬──────────┬──────────┬──────────┬──────────┬────────────────────┘
   │          │          │          │          │
   ▼          ▼          ▼          ▼          ▼
ARCHITECT  DEVELOPER     QA       DOCTOR    OVERSEER
   │          │          │          │          │
   └──────────┴──────────┴──────────┴──────────┘
                      │
              All agents read/write to:
                      │
                      ▼
         ┌──────────────────────────┐
         │  YAAM (memory layer)      │
         │  ├── Code graph (rebuilt  │
         │  │   from source each run)│
         │  ├── Workspaces (per      │
         │  │   feature, persistent) │
         │  ├── Scratchpad notes    │
         │  │   (decisions, failures)│
         │  └── Semantic search      │
         │                           │
         │  Stored on `memory` git   │
         │  branch (durable,        │
         │  versioned)               │
         └──────────────────────────┘
```

Two communication layers:
- **GitHub** = "what to do" (issues, labels, PRs, CI status)
- **YAAM** = "what we know" (decisions, code context, failure history, design rationale)

All agent actions (PRs, comments, commits) appear as **`evol-hive-agent[bot]** via a GitHub App — clearly distinct from the human.

## Agent Team

| Agent | Role | Trigger | Tools | Model |
|---|---|---|---|---|
| **Architect** | Drafts specs from issues, validates against architecture | `workflow_dispatch` (issue #) | read, bash | glm-5.2, high thinking |
| **Developer** | TDD implementation from specs, opens PRs | `workflow_dispatch` (issue #) | read, write, edit, bash | glm-5.2, medium thinking |
| **QA** | Verifies test coverage, adds E2E/integration tests | `workflow_dispatch` (PR #) via Controller | read, write, edit, bash | glm-5.2, medium thinking |
| **Doctor** | Diagnoses CI failures, fixes or escalates | `check_run` failure | read, bash, edit, write | glm-5.2, high thinking |
| **Overseer** | Interactive brainstorming, roadmap, creates issues | Manual (interactive Pi) | read, bash | glm-5.2, high thinking |
| **Controller** | Orchestrates pipeline, circuit breaker, escalation | `workflow_run` + `pull_request` closed | none (API only) | — |

## Pipeline Flow

```
1. Human creates Issue + labels "Status: Needs Architecture"
2. Human dispatches Architect (Actions tab → Run workflow → issue #)
3. Architect:
   → Reads issue + architecture docs (via YAAM search)
   → Drafts spec in docs/specs/NNN-feature-name.md
   → Updates docs/specs/INDEX.md
   → Creates YAAM workspace with design decision notes
   → Creates spec/NNN branch → opens spec PR (as evol-hive-agent[bot])
   → Comments on issue with spec summary
   → NEVER uses "Closes #N" in spec PR (issue must stay open)

4. Human reviews spec PR → merges (one click)
   → Controller detects spec PR merge (pull_request closed)
   → Controller auto-dispatches Developer with the issue number
   → Controller posts "Developer dispatched automatically" on issue

5. Developer:
   → Reads spec + YAAM workspace notes from Architect
   → Creates feature/NNN branch
   → Writes tests first (TDD) — confirms they fail
   → Implements until tests pass
   → Runs typecheck, lint, build locally
   → Pushes branch → opens PR (as evol-hive-agent[bot])
   → Updates INDEX.md status

6. Controller detects Developer completed:
   → Finds the open PR from the feature branch
   → Dispatches CI and QA workflows with the PR number
   → Posts "CI and QA dispatched" comment on PR

7. CI (via workflow_dispatch):
   → Type check, lint, format check, build, test
   → If fail → Doctor triggers (check_run failure)
   → If pass → Controller checks if QA also passed

8. QA (via workflow_dispatch):
   → Reads spec acceptance criteria
   → Maps each AC to existing tests
   → Adds missing E2E/integration tests
   → Runs all tests
   → Posts QA report as PR comment

9. Controller detects both CI + QA completed:
   → Both passed → posts "✅ All checks passed, ready for review" on PR
   → CI failed → Doctor triggers automatically
   → QA failed → escalates to @owner
   → Doctor failed → escalates to @owner

10. Human reviews code PR → merges (one click)
    → Code PR uses "Closes #N" → issue auto-closes
```

## Manual Steps Per Feature (only 4)

```
1. Create Issue + label "Status: Needs Architecture"
2. Dispatch Architect (Actions tab → Run workflow → issue #)
   ─── everything below is autonomous ───
3. Merge the spec PR (one click)
   → Controller auto-dispatches Developer
   → Developer creates code PR
   → Controller dispatches CI + QA
   → Controller posts "All checks passed" when green
   ─── everything below is autonomous ───
4. Merge the code PR (one click) → issue auto-closes
```

## Infrastructure

### GitHub App (Bot Identity)

All agents operate as **`evol-hive-agent[bot]`** — a GitHub App that gives the agents a distinct identity separate from the human. PRs, commits, and comments all show as created by the bot.

**Setup:**
1. Go to https://github.com/settings/apps → "New GitHub App"
2. Name: `evol-hive-agent`
3. Webhook: disabled (not needed)
4. Repository permissions:
   - Contents: Read and write
   - Issues: Read and write
   - Pull requests: Read and write
   - Actions: Read and write
   - Checks: Read-only
5. Generate a private key (.pem file)
6. Install the app on the repository
7. Store secrets: `APP_ID` (the numeric App ID) and `APP_PRIVATE_KEY` (the .pem contents)

**Usage in workflows:**
```yaml
- name: Generate App Token
  uses: actions/create-github-app-token@v1
  id: app-token
  with:
    app-id: ${{ secrets.APP_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}

- name: Run Agent
  env:
    GH_TOKEN: ${{ steps.app-token.outputs.token }}  # gh CLI uses this
  run: ...
```

**Important limitation:** GitHub App-created PRs do NOT trigger `pull_request` workflow events (loop prevention). The Controller works around this by dispatching CI and QA via `workflow_dispatch` when the Developer completes.

### Runners

All workflows run on **GitHub-hosted runners** (`ubuntu-latest`):
- Free and unlimited for public repositories
- Ephemeral VMs — no security risk from fork PRs
- No server maintenance

### LLM Backend

**Ollama Cloud direct API** (`https://ollama.com/v1`):
- No local Ollama daemon needed in CI
- API key stored as GitHub secret `OLLAMA_API_KEY`
- Model names omit the `:cloud` suffix (the direct API serves cloud models)
- Model config in `scripts/ci-models.json`

### YAAM Memory

Three-layer caching strategy:

| Layer | What | Where | TTL |
|---|---|---|---|
| **Binary** (30MB) | Compiled Rust daemon | GitHub Actions cache (`yaam-binary-v1`) | 7 days |
| **ONNX model** (134MB) | gte-small embedding model | GitHub Actions cache (`yaam-model-v1`) | 7 days |
| **events.jsonl** | Workspaces, scratchpad notes | Git `memory` branch | Permanent |

- Code graph (Files, Functions, Sections) is **rebuilt from source** each run via `scheduleFull()` — no persistence needed
- Workspaces and scratchpad notes persist via the `memory` git branch
- `scripts/restore-memory.sh` fetches events.jsonl at the start of each run
- `scripts/save-memory.sh` commits events.jsonl to the memory branch at the end (uses `git checkout -f` to handle uncommitted files)
- First run builds the binary from source (~2 min), subsequent runs restore from cache (~30 sec)

### Controller

The Controller (`scripts/controller.sh` + `.github/workflows/controller.yml`) is the orchestration layer:

**Triggers:**
- `workflow_run` — fires when any agent workflow completes
- `pull_request` closed — fires when a PR is merged

**Circuit breaker limits:**

| Agent | Max retries | On exhaustion |
|---|---|---|
| Architect | 3 | Escalate to @owner |
| Developer | 2 | Escalate to @owner |
| Doctor | 2 | Escalate to @owner |

**Decision logic:**
- Architect succeeds → "Review and merge the spec PR"
- Architect fails → retry (max 3) → escalate
- Spec PR merged → auto-dispatch Developer
- Developer succeeds → dispatch CI + QA on the PR
- Developer fails → retry (max 2) → escalate
- CI fails → Doctor triggers automatically (check_run event)
- CI + QA both pass → "✅ All checks passed, ready for review"
- Doctor fails → escalate to @owner
- QA fails → escalate to @owner

**Retry tracking:** Controller posts `[Controller] retry:agent:N` comments on issues/PRs to count retries.

### Bootstrap

Each workflow job runs `scripts/bootstrap-agent.sh` which:
1. Installs Pi (`npm install -g @earendil-works/pi-coding-agent`)
2. Installs pi-goal (`pi install npm:@narumitw/pi-goal`)
3. Installs YAAM extension (`pi install https://github.com/Redna/yaam`)
4. Builds or restores the YAAM daemon binary (cached after first run)
5. Downloads or restores the ONNX model files (cached after first run)
6. Configures Ollama Cloud as the LLM provider
7. Installs project dependencies (`pnpm install`)
8. Configures git for agent commits (`evol-hive-agent[bot]`)

## Repository Structure

```
evol-hive/
├── .github/workflows/
│   ├── architect.yml        # Architect agent (workflow_dispatch)
│   ├── developer.yml        # Developer agent (workflow_dispatch)
│   ├── qa.yml                # QA agent (pull_request + workflow_dispatch)
│   ├── doctor.yml            # Doctor agent (check_run failure)
│   ├── controller.yml        # Controller (workflow_run + pull_request closed)
│   └── ci.yml                # CI: typecheck, lint, build, test (push + pull_request + workflow_dispatch)
├── .pi/
│   ├── agents/
│   │   ├── architect.md      # System prompt + frontmatter
│   │   ├── developer.md
│   │   ├── qa-tester.md
│   │   ├── doctor.md
│   │   └── overseer.md       # Interactive (no workflow)
│   └── tasks/
│       ├── draft-spec.md     # Goal template for Architect
│       ├── implement.md      # Goal template for Developer
│       ├── qa-verify.md      # Goal template for QA
│       └── diagnose.md       # Goal template for Doctor
├── scripts/
│   ├── bootstrap-agent.sh    # Per-job setup (Pi + YAAM + Ollama)
│   ├── controller.sh         # Controller decision logic
│   ├── ci-models.json        # Ollama Cloud model config for CI
│   ├── restore-memory.sh     # Restore events.jsonl from memory branch
│   └── save-memory.sh        # Save events.jsonl to memory branch
├── docs/
│   ├── architecture/         # §1–§11 architecture specification
│   ├── adr/                  # Architecture Decision Records
│   ├── specs/
│   │   ├── INDEX.md          # Living spec index with status tracking
│   │   ├── TEMPLATE.md       # Spec template
│   │   └── NNN-*.md          # Feature specs
│   └── AGENT_TEAM_SETUP.md   # This document
├── ROADMAP.md                # Project phases, progress, decision log
├── AGENTS.md                 # Project context for coding agents
└── events.jsonl              # YAAM memory (gitignored, on memory branch)
```

## Spec-Driven Development

Specs are plain Markdown — no BDD libraries, no Given/When/Then ceremony.

### Spec format

```markdown
# Feature: [name]

## Context
- Architecture: [links to docs/architecture/ sections]
- Related specs: [links to other specs]
- Package: [which package(s) this affects]

## Requirements
- [What the feature must do, as bullet points]

## Acceptance Criteria
- [ ] [Verifiable condition — what tests must pass]

## Constraints
- [Package boundaries, performance requirements, patterns to follow]
```

### TDD pipeline (Model A: Developer does TDD, QA verifies)

1. Developer reads spec acceptance criteria → writes tests first
2. Tests must fail for the right reason (not syntax errors)
3. Developer implements until tests pass
4. QA verifies coverage: maps each AC to tests, adds missing E2E/integration tests
5. CI runs all tests as the final gatekeeper

### Micro V-Model

| Layer | Tests | Location | Run by |
|---|---|---|---|
| Macro (E2E) | Full PPER cycle, system behavior | `tests/e2e/` | QA agent |
| Meso (Integration) | Package boundaries | `tests/integration/` | QA agent |
| Micro (Unit) | Individual functions, schemas | `packages/*/tests/` | Developer (TDD) + QA |

## GitHub Configuration

### Secrets

| Secret | Value | Purpose |
|---|---|---|
| `OLLAMA_API_KEY` | Ollama Cloud API key | LLM authentication |
| `APP_ID` | GitHub App numeric ID | Bot identity token generation |
| `APP_PRIVATE_KEY` | GitHub App .pem file contents | Bot identity token generation |

`GITHUB_TOKEN` is automatically provided by GitHub Actions (used for checkout and basic operations).

### Labels

| Label | Color | Purpose |
|---|---|---|
| `Status: Needs Architecture` | `#FBCA04` | Issue needs the Architect agent |
| `Status: Ready for Dev` | `#0E8A16` | Spec approved, ready for Developer |
| `Status: In Review/QA` | `#5319E7` | PR is under review and QA |

### Branch Protection (main)

- Require PR before merging (1 approval)
- Require CI checks: Type Check & Lint, Build, Test
- Require branches up to date
- No force pushes, no deletions

### Repository Settings

- **Actions → General → Workflow permissions**: Read and write
- **Actions → General → Allow GitHub Actions to create and approve pull requests**: Enabled

## Key Design Decisions

| Decision | Rationale |
|---|---|
| GitHub-hosted runners (not self-hosted) | Free for public repos, no fork security risk, no server maintenance |
| Ollama Cloud direct API (not local daemon) | No tunneling needed, works from any runner, no server dependency |
| GitHub App (not PAT or GITHUB_TOKEN) | Distinct bot identity (`evol-hive-agent[bot]`), no manual approval, no "assigned to myself" confusion |
| Controller dispatches CI/QA (not pull_request trigger) | GitHub App-created PRs don't trigger pull_request events (loop prevention). Controller works around this by dispatching via workflow_dispatch |
| `pi -p` print mode (not pi-goal `/goal`) | Slash commands don't work in print mode; print mode does multi-turn tool use |
| Git memory branch (not Actions cache) | Durable, versioned, no 7-day TTL, no 10GB limit, survives cache eviction |
| Spec PRs (not direct push to main) | Branch protection requires PRs; human reviews spec before development |
| Spec PRs never use "Closes #N" | Issue must stay open until the code PR is merged, not the spec PR |
| Model A TDD (Developer writes tests, QA verifies) | Most practical: no blocking step, QA is a verification layer not a gate |
| YAAM for inter-agent memory | Workspaces + scratchpad notes persist across runs via memory branch |
| Controller as circuit breaker | Prevents infinite loops, limits retries, escalates to human when needed |

## Bootstrapping Steps

To replicate this setup on a new repository:

### Phase 1: Repository Setup

1. **Create the agent definitions** in `.pi/agents/` (Markdown with YAML frontmatter)
2. **Create the task templates** in `.pi/tasks/` (interpolated with `envsubst`)
3. **Create the bootstrap script** `scripts/bootstrap-agent.sh`
4. **Create the CI model config** `scripts/ci-models.json` (point to Ollama Cloud)
5. **Create the memory scripts** `scripts/restore-memory.sh` and `scripts/save-memory.sh`
6. **Create the controller script** `scripts/controller.sh`
7. **Create the GitHub Actions workflows** in `.github/workflows/` (architect, developer, qa, doctor, controller, ci)
8. **Create the spec template** `docs/specs/TEMPLATE.md`
9. **Create the spec index** `docs/specs/INDEX.md`
10. **Create the roadmap** `ROADMAP.md`
11. **Create the AGENTS.md** with project context

### Phase 2: GitHub Configuration

12. **Create a GitHub App**: https://github.com/settings/apps → New GitHub App
    - Name: `evol-hive-agent`
    - Repository permissions: Contents (rw), Issues (rw), Pull requests (rw), Actions (rw), Checks (r)
    - Generate private key (.pem file)
    - Install app on the repository
13. **Set GitHub secrets**: `OLLAMA_API_KEY`, `APP_ID`, `APP_PRIVATE_KEY`
14. **Create GitHub labels**: `Status: Needs Architecture`, `Status: Ready for Dev`, `Status: In Review/QA`
15. **Enable repository settings**: read/write workflow permissions, allow PR creation by Actions
16. **Enable branch protection** on `main` (require PR + CI checks)

### Phase 3: Test the Pipeline

17. **Install pi-goal** in the project: `pi install npm:@narumitw/pi-goal`
18. **Test the loop**: create an issue → dispatch Architect → merge spec PR → Controller auto-dispatches Developer → merge code PR

## Known Limitations

- **GitHub App PRs don't trigger pull_request events**: App-created PRs don't fire `pull_request` workflow events (GitHub loop prevention). The Controller works around this by dispatching CI and QA via `workflow_dispatch` when the Developer completes.
- **First-run cache miss**: The first run builds the YAAM binary from source (~2 min) and downloads the ONNX model (~30 sec). Subsequent runs use cached versions.
- **Concurrent agent memory**: If two agents run simultaneously and both save memory, the last push wins. The save-memory script has a retry mechanism, but true concurrent writes are not fully handled.
- **No Reviewer agent yet**: The Code Reviewer agent (code quality, security, performance review) is designed but not yet implemented as a workflow.
- **Controller can't read workflow_run context**: The `workflow_run` event doesn't provide the original issue/PR context. The Controller infers it from the current repo state (latest issue, latest PR). This works for sequential pipelines but could be ambiguous with concurrent work.