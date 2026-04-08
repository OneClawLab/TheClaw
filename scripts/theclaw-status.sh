#!/usr/bin/env bash
# theclaw-status.sh - Aggregate status from all components
# Does NOT depend on theclaw CLI itself

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

# XAR daemon status
echo "--- XAR Daemon ---"
PID_FILE="${THECLAW_HOME}/xar.pid"
if [ -f "$PID_FILE" ]; then
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    echo "  running (pid $pid)"
  else
    echo "  stopped (stale pid file: $pid)"
  fi
else
  echo "  stopped (no pid file)"
fi
echo ""

# Agents status (via xar CLI)
echo "--- Agents ---"
if command -v xar &>/dev/null; then
  xar status 2>&1 || echo "[error] xar status command failed"
else
  # Fallback: scan agents directory directly
  AGENTS_DIR="${THECLAW_HOME}/agents"
  if [ -d "$AGENTS_DIR" ]; then
    found=0
    for agent_dir in "$AGENTS_DIR"/*/; do
      [ -d "$agent_dir" ] || continue
      agent_id="$(basename "$agent_dir")"
      config_file="${agent_dir}config.json"
      if [ -f "$config_file" ]; then
        kind=$(grep -o '"kind"[[:space:]]*:[[:space:]]*"[^"]*"' "$config_file" 2>/dev/null \
          | head -1 | sed 's/.*: *"\(.*\)"/\1/' || echo "unknown")
        echo "  $agent_id ($kind)"
        found=1
      fi
    done
    [ "$found" -eq 0 ] && echo "  No agents found in $AGENTS_DIR"
  else
    echo "  [error] xar command not found and agents directory missing"
  fi
fi
echo ""

echo "=== Done ==="
