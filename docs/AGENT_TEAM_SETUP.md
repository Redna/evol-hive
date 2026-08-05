# Autonomous Agent Delivery Team

> How we bootstrapped an autonomous AI agent team for evol-hive using GitHub Actions, Ollama Cloud, Pi, pi-goal, and YAAM.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  HUMAN (Product Owner)                                           │
│  Creates issues → reviews PRs → merges                           │
│  Brainstorms with Overseer (interactive Pi session)              │
└─────┬────────────────────────────────────────────────────────────┘
      │ creates Issue + dispatches Architect
      ▼
┌─────────────────────────────────────────────────────────────────┐
│  GITHUB (state machine + communication layer)                    │
│  Issues • Labels • PRs • Check Runs • Comments                   │
└──┬──────────┬──────────┬──────────┬──────────┬────────────────────┘
   │          │          │          │          │
   ▼          ▼          ▼          ▼          ▼
ARCHITECT  DEVELOPER     QA       REVIEWER   DOCTOR
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

## Agent Team

| Agent | Role | Trigger | Tools | Model |
|---|---|---|---|---|
| **Architect** | Drafts specs from issues, validates against architecture | `workflow_dispatch` (issue #) | read, bash | glm-5.2, high thinking |
| **Developer** | TDD implementation from specs, opens PRs | `workflow_dispatch` (issue #) | read, write, edit, bash | glm-5.2, medium thinking |
| **QA** | Verifies test coverage, adds E2E/integration tests | `pull_request` opened | read, write, edit, bash | glm-5.2, medium thinking |
| **Doctor** | Diagnoses CI failures, fixes or escalates | `check_run` failure | read, bash, edit, write | glm-5.2, high thinking |
| **Overseer** | Interactive brainstorming, roadmap, creates issues | Manual (interactive Pi) | read, bash | glm-5.2, high thinking |

## Pipeline Flow

```
1. Human creates Issue → dispatches Architect workflow
2. Architect:
   → Reads issue + architecture docs (via YAAM search)
   → Drafts spec in docs/specs/NNN-feature-name.md
   → Updates docs/specs/INDEX.md
   → Creates YAAM workspace with design decision notes
   → Creates spec/NNN branch → opens spec PR
   → Comments on issue with spec summary

3. Human reviews spec PR → merges

4. Human dispatches Developer workflow (issue #)
5. Developer:
   → Reads spec + YAAM workspace notes from Architect
   → Creates feature/NNN branch
   → Writes tests first (TDD) — confirms they fail
   → Implements until tests pass
   → Runs typecheck, lint, build locally
   → Pushes branch → opens PR
   → Updates INDEX.md status

6. PR opened → triggers in parallel:
   ├── CI (typecheck, lint, build, test)
   └── QA (coverage verification)

7. CI:
   → If pass → PR is ready for merge
   → If fail → Doctor triggers:
     → Reads CI failure output
     → Diagnoses root cause
     → Fixes if isolated (≤3 files) or escalates
     → Pushes fix to PR branch → CI re-runs

8. QA:
   → Reads spec acceptance criteria
   → Maps each AC to existing tests
   → Adds missing E2E/integration tests
   → Runs all tests
   → Posts QA report as PR comment

9. Human reviews PR → merges
```

## Infrastructure

### Runners

All agent workflows run on **GitHub-hosted runners** (`ubuntu-latest`):
- Free and unlimited for public repositories
- Ephemeral VMs — no security risk from fork PRs
- No server maintenance

CI also runs on GitHub-hosted runners (existing `ci.yml`).

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
- `scripts/save-memory.sh` commits events.jsonl to the memory branch at the end
- First run builds the binary from source (~2 min), subsequent runs restore from cache (~30 sec)

### Bootstrap

Each workflow job runs `scripts/bootstrap-agent.sh` which:
1. Installs Pi (`npm install -g @earendil-works/pi-coding-agent`)
2. Installs pi-goal (`pi install npm:@narumitw/pi-goal`)
3. Installs YAAM extension (`pi install https://github.com/Redna/yaam`)
4. Builds or restores the YAAM daemon binary
5. Downloads or restores the ONNX model files
6. Configures Ollama Cloud as the LLM provider
7. Installs project dependencies (`pnpm install`)
8. Configures git for agent commits

## Repository Structure

```
evol-hive/
├── .github/workflows/
│   ├── architect.yml        # Architect agent (workflow_dispatch)
│   ├── developer.yml        # Developer agent (workflow_dispatch)
│   ├── qa.yml                # QA agent (pull_request opened)
│   ├── doctor.yml            # Doctor agent (check_run failure)
│   └── ci.yml                # CI: typecheck, lint, build, test
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
│   ├── ci-models.json        # Ollama Cloud model config for CI
│   ├── restore-memory.sh     # Restore events.jsonl from memory branch
│   └── save-memory.sh        # Save events.jsonl to memory branch
├── docs/
│   ├── architecture/         # §1–§11 architecture specification
│   ├── adr/                  # Architecture Decision Records
│   └── specs/
│       ├── INDEX.md          # Living spec index with status tracking
│       ├── TEMPLATE.md       # Spec template
│       └── NNN-*.md          # Feature specs
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

`GITHUB_TOKEN` is automatically provided by GitHub Actions.

### Labels

| Label | Color | Triggers |
|---|---|---|
| `Status: Needs Architecture` | `#FBCA04` | Architect workflow |
| `Status: Ready for Dev` | `#0E8A16` | Developer workflow (manual dispatch) |
| `Status: In Review/QA` | `#5319E7` | PR is under review |

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
| `pi -p` print mode (not pi-goal `/goal`) | Slash commands don't work in print mode; print mode does multi-turn tool use |
| Git memory branch (not Actions cache) | Durable, versioned, no 7-day TTL, no 10GB limit, survives cache eviction |
| Spec PRs (not direct push to main) | Branch protection requires PRs; human reviews spec before development |
| Model A TDD (Developer writes tests, QA verifies) | Most practical: no blocking step, QA is a verification layer not a gate |
| YAAM for inter-agent memory | Workspaces + scratchpad notes persist across runs via memory branch |

## Bootstrapping Steps

To replicate this setup on a new repository:

1. **Create the agent definitions** in `.pi/agents/` (Markdown with YAML frontmatter)
2. **Create the task templates** in `.pi/tasks/` (interpolated with `envsubst`)
3. **Create the bootstrap script** `scripts/bootstrap-agent.sh`
4. **Create the CI model config** `scripts/ci-models.json` (point to Ollama Cloud)
5. **Create the memory scripts** `scripts/restore-memory.sh` and `scripts/save-memory.sh`
6. **Create the GitHub Actions workflows** in `.github/workflows/`
7. **Set the GitHub secret** `OLLAMA_API_KEY`
8. **Create the GitHub labels** (Status: Needs Architecture, Ready for Dev, In Review/QA)
9. **Enable repository settings**: read/write permissions, allow PR creation
10. **Enable branch protection** on `main` (require PR + CI)
11. **Install pi-goal** in the project: `pi install npm:@narumitw/pi-goal`
12. **Create the spec template** `docs/specs/TEMPLATE.md`
13. **Create the spec index** `docs/specs/INDEX.md`
14. **Create the roadmap** `ROADMAP.md`
15. **Create the AGENTS.md** with project context
16. **Test the loop**: create an issue → dispatch Architect → review spec PR → dispatch Developer → merge code PR

## Known Limitations

- **GITHUB_TOKEN PRs require approval**: Workflows triggered by `GITHUB_TOKEN`-created PRs show `action_required` and need manual approval in the Actions tab. Workaround: use a PAT for PR creation, or approve manually.
- **First-run cache miss**: The first run builds the YAAM binary from source (~2 min) and downloads the ONNX model (~30 sec). Subsequent runs use cached versions.
- **QA checkout**: The QA workflow needs to explicitly checkout the PR's head branch (not the default merge commit) so test files are pushed to the correct branch.
- **No Reviewer agent yet**: The Reviewer agent (code quality, security) is designed but not yet implemented as a workflow.
- **Concurrent agent memory**: If two agents run simultaneously and both save memory, the last push wins. The save-memory script has a retry mechanism, but true concurrent writes are not fully handled.