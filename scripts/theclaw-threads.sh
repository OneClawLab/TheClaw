#!/usr/bin/env bash
# theclaw-threads.sh - List and summarize thread directories for all agents
# 需求：6.3 - Does NOT depend on theclaw CLI itself
# Usage: theclaw-threads.sh [--agent <id>]

set -euo pipefail

THECLAW_HOME="${THECLAW_HOME:-$HOME/.theclaw}"
AGENT_FILTER=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      AGENT_FILTER="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--agent <id>]"
      echo ""
      echo "Options:"
      echo "  --agent <id>   Show threads for a specific agent only"
      exit 0
      ;;
    *)
      echo "[error] Unknown argument: $1" >&2
      echo "Use --help for usage information." >&2
      exit 2
      ;;
  esac
done

AGENTS_DIR="${THECLAW_HOME}/agents"

echo "=== TheClaw Thread Summary ==="
echo "THECLAW_HOME: $THECLAW_HOME"
echo ""

if [ ! -d "$AGENTS_DIR" ]; then
  echo "[error] Agents directory not found: $AGENTS_DIR"
  exit 1
fi

found_agents=0

for agent_dir in "$AGENTS_DIR"/*/; do
  [ -d "$agent_dir" ] || continue

  agent_id="$(basename "$agent_dir")"

  # Apply --agent filter if specified
  if [ -n "$AGENT_FILTER" ] && [ "$agent_id" != "$AGENT_FILTER" ]; then
    continue
  fi

  found_agents=1
  echo "--- Agent: $agent_id ---"

  threads_dir="${agent_dir}threads"
  if [ ! -d "$threads_dir" ]; then
    echo "  No threads directory found"
    echo ""
    continue
  fi

  thread_count=0
  for thread_dir in "$threads_dir"/*/; do
    [ -d "$thread_dir" ] || continue
    thread_id="$(basename "$thread_dir")"
    thread_count=$((thread_count + 1))

    # Gather summary info
    msg_count=0
    last_modified=""
    status_info=""

    # Count messages if messages file/dir exists
    if [ -f "${thread_dir}messages.json" ]; then
      # Count lines as rough proxy, or use jq if available
      if command -v jq &>/dev/null; then
        msg_count=$(jq 'length' "${thread_dir}messages.json" 2>/dev/null || echo "?")
      else
        msg_count="(jq not available)"
      fi
    elif [ -d "${thread_dir}messages" ]; then
      msg_count=$(find "${thread_dir}messages" -type f | wc -l | tr -d ' ')
    fi

    # Get last modified time of thread directory
    if command -v stat &>/dev/null; then
      last_modified=$(stat -c '%y' "$thread_dir" 2>/dev/null \
        || stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$thread_dir" 2>/dev/null \
        || echo "unknown")
    fi

    # Check for status file
    if [ -f "${thread_dir}status" ]; then
      status_info=$(cat "${thread_dir}status" 2>/dev/null || echo "")
    elif [ -f "${thread_dir}status.json" ]; then
      if command -v jq &>/dev/null; then
        status_info=$(jq -r '.status // empty' "${thread_dir}status.json" 2>/dev/null || echo "")
      fi
    fi

    echo "  Thread: $thread_id"
    [ -n "$last_modified" ] && echo "    Last modified: $last_modified"
    [ "$msg_count" != "0" ] && echo "    Messages: $msg_count"
    [ -n "$status_info" ] && echo "    Status: $status_info"
  done

  if [ "$thread_count" -eq 0 ]; then
    echo "  No threads found"
  else
    echo "  Total threads: $thread_count"
  fi
  echo ""
done

if [ "$found_agents" -eq 0 ]; then
  if [ -n "$AGENT_FILTER" ]; then
    echo "[error] Agent not found: $AGENT_FILTER"
    exit 1
  else
    echo "No agents found in $AGENTS_DIR"
  fi
fi

echo "=== Done ==="
