# Self-Hosted Runner Setup

## One-time registration

```bash
# Get a registration token from GitHub:
#   Redna/evol-hive → Settings → Actions → Runners → New self-hosted runner
#   Copy the token from step 3 ("Configure")

# Run the registration script:
./scripts/register-runner.sh <REGISTRATION_TOKEN>
```

## Runner details

| Property | Value |
|---|---|
| Name | `evol-hive-llm` |
| Labels | `self-hosted`, `llm` |
| Work directory | `~/actions-runner/_work` |
| Service | systemd (auto-starts on boot, restarts on crash) |

## GitHub Secrets to set

Set these in Redna/evol-hive → Settings → Secrets and variables → Actions:

| Secret | Value | Why |
|---|---|---|
| `OLLAMA_API_KEY` | `ollama` | Ollama API key (local instance) |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434/v1` | Ollama endpoint (localhost on self-hosted runner) |

`GITHUB_TOKEN` is automatically provided by GitHub Actions — no need to set it manually.

## GitHub Labels to create

Create these labels in Redna/evol-hive → Issues → Labels:

| Label | Color | Purpose |
|---|---|---|
| `Status: Needs Architecture` | `#FBCA04` | Issue needs the Architect agent |
| `Status: Ready for Dev` | `#0E8A16` | Spec approved, ready for Developer |
| `Status: In Review/QA` | `#5319E7` | PR opened, Reviewer + QA active |

## Managing the runner

```bash
# Check status
sudo ~/actions-runner/svc.sh status

# Stop
sudo ~/actions-runner/svc.sh stop

# Start
sudo ~/actions-runner/svc.sh start

# Uninstall (removes service)
sudo ~/actions-runner/svc.sh uninstall
```