#!/bin/bash
set -euo pipefail

# sandbox.sh - Run commands on a remote crabbox VM with worktree isolation
# Usage: ./scripts/sandbox.sh [command...]
# Default: run this repo's test suite
#
# Each invocation gets its own git worktree for parallel isolation.
# Set TASK_ID to reuse a specific worktree across calls.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_NAME="$(basename "$REPO_ROOT")"
TASK_ID="${TASK_ID:-$(date +%s)-$$}"

# Crabbox config
BOX_CLASS="${CRABBOX_CLASS:-cpx62}"

# GitHub .agents repo for syncing skills/commands
AGENTS_REPO="${AGENTS_REPO:-git@github.com:phnx-labs/.agents.git}"

die() { echo "error: $*" >&2; exit 1; }

# Ensure deps
command -v agents >/dev/null || die "agents-cli not installed"
command -v crabbox >/dev/null || die "crabbox not installed"

# Load Hetzner token
eval "$(agents secrets export hetzner.com 2>/dev/null)" || die "Failed to load hetzner.com secrets"
export HCLOUD_TOKEN

# Find or create a crabbox
get_or_create_box() {
  local box_id
  box_id=$(crabbox list 2>/dev/null | grep -oE 'slug=[^ ]+' | head -1 | cut -d= -f2 || true)

  if [[ -z "$box_id" ]]; then
    echo "No running box found, warming up (~60s)..."
    crabbox warmup --class "$BOX_CLASS" >/dev/null
    sleep 5
    box_id=$(crabbox list | grep -oE 'slug=[^ ]+' | head -1 | cut -d= -f2)
  fi

  echo "$box_id"
}

# Bootstrap script for remote (repo-specific: agents-cli = TypeScript)
bootstrap_remote() {
  cat <<'BOOTSTRAP'
set -euo pipefail

# Bun (for TypeScript projects)
if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"

# Build tools for native modules (node-pty, etc.)
if ! command -v make &>/dev/null; then
  echo "Installing build-essential..."
  sudo apt-get update -qq && sudo apt-get install -y -qq build-essential unzip
fi

# Git identity for tests
git config --global user.email 2>/dev/null || git config --global user.email "ci@crabbox.local"
git config --global user.name 2>/dev/null || git config --global user.name "Crabbox CI"

# agents-cli (optional, for running agents in sandbox)
if ! command -v agents &>/dev/null; then
  echo "Installing agents-cli..."
  npm install -g @phnx-labs/agents-cli 2>/dev/null || true
fi

echo "Bootstrap complete."
BOOTSTRAP
}

main() {
  local box_id cmd worktree_dir

  box_id=$(get_or_create_box)
  [[ -n "$box_id" ]] || die "Failed to get crabbox"

  echo "Using crabbox: $box_id (task: $TASK_ID)"

  # Default command: run tests
  if [[ $# -eq 0 ]]; then
    cmd="bun install && bun test"
  else
    cmd="$*"
  fi

  # Isolated workspace path on remote
  workspace_dir="workspaces/${REPO_NAME}-${TASK_ID}"

  # Sync local repo to remote, then copy to isolated workspace
  crabbox run --id "$box_id" -- bash -c "
$(bootstrap_remote)

REPO_DIR=\"\$(pwd)\"
WORKSPACE_DIR=\"\$REPO_DIR/../$workspace_dir\"

# Create isolated workspace
if [[ ! -d \"\$WORKSPACE_DIR\" ]]; then
  echo \"Creating workspace: $workspace_dir\"
  mkdir -p \"\$WORKSPACE_DIR\"
fi

# Sync from crabbox's rsync target to isolated workspace
rsync -a --delete --exclude='node_modules' --exclude='.bun' \
  \"\$REPO_DIR/\" \"\$WORKSPACE_DIR/\"

cd \"\$WORKSPACE_DIR\"

# Initialize git for tests that need it
if [[ ! -d .git ]]; then
  git init -q
  git add -A
  git commit -q -m 'initial' 2>/dev/null || true
fi

echo \"Working in: \$(pwd)\"
echo \"--- Running: $cmd ---\"
$cmd
"
}

main "$@"
