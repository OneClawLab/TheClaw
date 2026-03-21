#!/usr/bin/env bash
# theclaw-logs.sh - Show recent logs for platform components
# 需求：6.2 - Does NOT depend on theclaw CLI itself
# Usage: theclaw-logs.sh [--lines <n>] [--component <name>]

set -euo pipefail

THECLAW_HOME="${THECLAW_HOME:-$HOME/.theclaw}"
LINES=20
COMPONENT=""

# Parse arguments
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
      echo "                     Valid components: notifier, xgw, agents, agent:<id>"
      exit 0
      ;;
    *)
      echo "[error] Unknown argument: $1" >&2
      echo "Use --help for usage information." >&2
      exit 2
      ;;
  esac
done

# Helper: show tail of a log file
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
  local logfile="${THECLAW_HOME}/logs/notifier.log"
  show_log "Notifier (last $LINES lines)" "$logfile"
}

show_xgw_logs() {
  local logfile="${THECLAW_HOME}/logs/xgw.log"
  show_log "XGW (last $LINES lines)" "$logfile"
}

show_agent_logs() {
  local agent_id="${1:-}"
  local agents_dir="${THECLAW_HOME}/agents"

  if [ -n "$agent_id" ]; then
    local logfile="${agents_dir}/${agent_id}/logs/agent.log"
    show_log "Agent: $agent_id (last $LINES lines)" "$logfile"
  else
    if [ -d "$agents_dir" ]; then
      found=0
      for agent_dir in "$agents_dir"/*/; do
        if [ -d "$agent_dir" ]; then
          local id
          id="$(basename "$agent_dir")"
          local logfile="${agent_dir}logs/agent.log"
          show_log "Agent: $id (last $LINES lines)" "$logfile"
          found=1
        fi
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

# Route based on --component filter
case "$COMPONENT" in
  "")
    show_notifier_logs
    show_xgw_logs
    show_agent_logs
    ;;
  notifier)
    show_notifier_logs
    ;;
  xgw)
    show_xgw_logs
    ;;
  agents)
    show_agent_logs
    ;;
  agent:*)
    agent_id="${COMPONENT#agent:}"
    show_agent_logs "$agent_id"
    ;;
  *)
    echo "[error] Unknown component: $COMPONENT" >&2
    echo "Valid components: notifier, xgw, agents, agent:<id>" >&2
    exit 2
    ;;
esac

echo "=== Done ==="
