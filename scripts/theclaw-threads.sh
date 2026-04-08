#!/usr/bin/env bash
# theclaw-threads.sh - List and summarize thread directories for all agents
# Does NOT depend on theclaw CLI itself
# Usage: theclaw-threads.sh [--agent <id>]
#
# Thread layout per agent:
#   $THECLAW_HOME/agents/<id>/threads/<thread-id>/events.db     — SQLite DB
#   $THECLAW_HOME/agents/<id>/threads/<thread-id>/events.jsonl  — append-only event log
#   $THECLAW_HOME/agents/<id>/sessions/<thread-id>.jsonl        — LLM session (compacted)

set -euo pipefail

THECLAW_HOME="${THECLAW_HOME:-$HOME/.theclaw}"
AGENT_FILTER=""

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

  if [ -n "$AGENT_FILTER" ] && [ "$agent_id" != "$AGENT_FILTER" ]; then
    continue
  fi

  found_agents=1
  echo "--- Agent: $agent_id ---"

  threads_dir="${agent_dir}threads"
  sessions_dir="${agent_dir}sessions"

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

    # Count events from events.jsonl (one JSON object per line)
    event_count=0
    events_jsonl="${thread_dir}events.jsonl"
    if [ -f "$events_jsonl" ]; then
      event_count=$(grep -c . "$events_jsonl" 2>/dev/null || echo 0)
    fi

    # Check if a compacted session file exists
    session_file="${sessions_dir}/${thread_id}.jsonl"
    has_session=""
    if [ -f "$session_file" ]; then
      session_lines=$(grep -c . "$session_file" 2>/dev/null || echo 0)
      has_session=" (session: ${session_lines} msgs)"
    fi

    # Last modified time of the thread directory
    last_modified=""
    if command -v stat &>/dev/null; then
      last_modified=$(stat -c '%y' "$thread_dir" 2>/dev/null \
        || stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$thread_dir" 2>/dev/null \
        || echo "")
      # Trim sub-second precision
      last_modified="${last_modified%%.*}"
    fi

    echo "  Thread: $thread_id"
    [ -n "$last_modified" ] && echo "    Modified: $last_modified"
    echo "    Events:  ${event_count}${has_session}"
  done

  if [ "$thread_count" -eq 0 ]; then
    echo "  No threads found"
  else
    echo "  Total: $thread_count thread(s)"
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
