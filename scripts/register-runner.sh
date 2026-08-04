#!/bin/bash
# Register and start the self-hosted GitHub Actions runner
# Usage: ./register-runner.sh <REGISTRATION_TOKEN>

REG_TOKEN="$1"
RUNNER_DIR="$HOME/actions-runner"

if [ -z "$REG_TOKEN" ]; then
  echo "Usage: $0 <REGISTRATION_TOKEN>"
  echo ""
  echo "Get the token from:"
  echo "  GitHub → Redna/evol-hive → Settings → Actions → Runners → New self-hosted runner"
  echo "  Or via API (needs a token with repo scope):"
  echo "  curl -X POST -H 'Authorization: token <PAT>' https://api.github.com/repos/Redna/evol-hive/actions/runners/registration-token"
  exit 1
fi

cd "$RUNNER_DIR"

# Configure the runner
./config.sh --url https://github.com/Redna/evol-hive \
  --token "$REG_TOKEN" \
  --name "evol-hive-llm" \
  --labels "llm,self-hosted" \
  --work _work \
  --unattended

# Install as a systemd service for persistence
sudo ./svc.sh install $USER

# Start the service
sudo ./svc.sh start

echo "Runner registered and started as systemd service."
echo "Check status: sudo ./svc.sh status"