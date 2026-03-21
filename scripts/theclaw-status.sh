#!/usr/bin/env bash
# theclaw-status.sh - Aggregate status from all components
# 需求：6.1 - Does NOT depend on theclaw CLI itself

set -euo pipefail

THECLAW_HOME="${THECLAW_HOME:-$HOME/.theclaw}"

echo "=== TheClaw Platform Status ==="
echo ""

# Notifier status
echo "--- Notifier ---"
if command -v notifier &>/dev/null; then
  notifier status 2>&1 || echo "[error] notifier status command failed"
else
  echo "[error] notifier command not found"
fi
echo ""

# XGW status
echo "--- XGW ---"
if command -v xgw &>/dev/null; then
  xgw status 2>&1 || echo "[error] xgw status command failed"
else
  echo "[error] xgw command not found"
fi
echo ""

# Agents status
echo "--- Agents ---"
if command -v agent &>/dev/null; then
  # Try to list all known agents from THECLAW_HOME
  AGENTS_DIR="${THECLAW_HOME}/agents"
  if [ -d "$AGENTS_DIR" ]; then
    found=0
    for agent_dir in "$AGENTS_DIR"/*/; do
      if [ -d "$agent_dir" ]; then
        agent_id="$(basename "$agent_dir")"
        echo "  [agent: $agent_id]"
        agent status "$agent_id" 2>&1 || echo "  [error] agent status $agent_id failed"
        found=1
      fi
    done
    if [ "$found" -eq 0 ]; then
      echo "  No agents found in $AGENTS_DIR"
    fi
  else
    # Fall back to generic agent status
    agent status 2>&1 || echo "[error] agent status command failed"
  fi
else
  echo "[error] agent command not found"
fi
echo ""

echo "=== Done ==="
