#!/usr/bin/env bash
# theclaw-logs.sh - Show recent logs for platform components
# Does NOT depend on theclaw CLI itself
# Usage: theclaw-logs.sh [--lines <n>] [--component <name>]
#
# Log file locations:
#   $THECLAW_HOME/logs/xar.log          — xar daemon
#   $THECLAW_HOME/logs/agent-<id>.log   — per-agent logs
#   $THECLAW_HOME/logs/notifier.log     — notifier daemon
#   $THECLAW_HOME/logs/xgw.log          — xgw daemon

set -euo pipefail

THECLAW_HOME="${THECLAW_HOME:-$HOME/.theclaw}"
LINES=20
COMPONENT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lines)
      LINES="$2"
      shift 2
      ;;
    --component)
      COMPONENT="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--lines <n>] [--component <name>]"
      echo ""
      echo "Options:"
      echo "  --lines <n>        Number of log lines to show (default: 20)"
      echo "  --component <name> Show logs for specific component only"
      echo "                     Valid: notifier, xgw, xar, agents, agent:<id>"
      exit 0
      ;;
    *)
      echo "[error] Unknown argument: $1" >&2
      echo "Use --help for usage information." >&2
      exit 2
      ;;
  esac
done

show_log() {
  local label="$1"
  local logfile="$2"
  echo "--- $label ---"
  if [ -f "$logfile" ]; then
    tail -n "$LINES" "$logfile"
  else
    echo "  [no log file found at $logfile]"
  fi
  echo ""
}

show_notifier_logs() {
  show_log "Notifier (last $LINES lines)" "${THECLAW_HOME}/logs/notifier.log"
}

show_xgw_logs() {
  show_log "XGW (last $LINES lines)" "${THECLAW_HOME}/logs/xgw.log"
}

show_xar_logs() {
  show_log "XAR daemon (last $LINES lines)" "${THECLAW_HOME}/logs/xar.log"
}

show_agent_logs() {
  local agent_id="${1:-}"
  local logs_dir="${THECLAW_HOME}/logs"

  if [ -n "$agent_id" ]; then
    show_log "Agent: $agent_id (last $LINES lines)" "${logs_dir}/agent-${agent_id}.log"
  else
    # Show logs for all known agents
    local agents_dir="${THECLAW_HOME}/agents"
    if [ -d "$agents_dir" ]; then
      local found=0
      for agent_dir in "$agents_dir"/*/; do
        [ -d "$agent_dir" ] || continue
        local id
        id="$(basename "$agent_dir")"
        show_log "Agent: $id (last $LINES lines)" "${logs_dir}/agent-${id}.log"
        found=1
      done
      if [ "$found" -eq 0 ]; then
        echo "--- Agents ---"
        echo "  No agents found in $agents_dir"
        echo ""
      fi
    else
      echo "--- Agents ---"
      echo "  Agents directory not found: $agents_dir"
      echo ""
    fi
  fi
}

echo "=== TheClaw Logs ==="
echo ""

case "$COMPONENT" in
  "")
    show_notifier_logs
    show_xgw_logs
    show_xar_logs
    show_agent_logs
    ;;
  notifier)
    show_notifier_logs
    ;;
  xgw)
    show_xgw_logs
    ;;
  xar)
    show_xar_logs
    ;;
  agents)
    show_agent_logs
    ;;
  agent:*)
    show_agent_logs "${COMPONENT#agent:}"
    ;;
  *)
    echo "[error] Unknown component: $COMPONENT" >&2
    echo "Valid components: notifier, xgw, xar, agents, agent:<id>" >&2
    exit 2
    ;;
esac

echo "=== Done ==="
