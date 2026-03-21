#!/usr/bin/env bash
# theclaw-trace.sh - Trace a message through the platform in timeline format
# 需求：6.4 - Does NOT depend on theclaw CLI itself
# Usage: theclaw-trace.sh --message-id <uuid>
#        theclaw-trace.sh --keyword <text> [--since <time>]

set -euo pipefail

THECLAW_HOME="${THECLAW_HOME:-$HOME/.theclaw}"
MESSAGE_ID=""
KEYWORD=""
SINCE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --message-id)
      MESSAGE_ID="$2"
      shift 2
      ;;
    --keyword)
      KEYWORD="$2"
      shift 2
      ;;
    --since)
      SINCE="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 --message-id <uuid>"
      echo "       $0 --keyword <text> [--since <time>]"
      echo ""
      echo "Options:"
      echo "  --message-id <uuid>   Trace a specific message by UUID"
      echo "  --keyword <text>      Search for messages containing keyword"
      echo "  --since <time>        Limit search to entries after this time (e.g. '2024-01-01 00:00:00')"
      exit 0
      ;;
    *)
      echo "[error] Unknown argument: $1" >&2
      echo "Use --help for usage information." >&2
      exit 2
      ;;
  esac
done

if [ -z "$MESSAGE_ID" ] && [ -z "$KEYWORD" ]; then
  echo "[error] Must specify --message-id <uuid> or --keyword <text>" >&2
  echo "Use --help for usage information." >&2
  exit 2
fi

LOGS_DIR="${THECLAW_HOME}/logs"
AGENTS_DIR="${THECLAW_HOME}/agents"

echo "=== TheClaw Message Trace ==="
if [ -n "$MESSAGE_ID" ]; then
  echo "Message ID: $MESSAGE_ID"
elif [ -n "$KEYWORD" ]; then
  echo "Keyword: $KEYWORD"
  [ -n "$SINCE" ] && echo "Since: $SINCE"
fi
echo ""

# Collect matching log lines with source labels into a temp file for sorting
TMPFILE="$(mktemp)"
trap 'rm -f "$TMPFILE"' EXIT

# Helper: search a log file and append matches with label
search_log() {
  local label="$1"
  local logfile="$2"

  [ -f "$logfile" ] || return 0

  if [ -n "$MESSAGE_ID" ]; then
    grep -n "$MESSAGE_ID" "$logfile" 2>/dev/null | while IFS=: read -r lineno content; do
      echo "$content	[$label:$lineno]"
    done >> "$TMPFILE" || true
  else
    # Keyword search with optional --since filter
    if [ -n "$SINCE" ]; then
      grep -n "$KEYWORD" "$logfile" 2>/dev/null | while IFS=: read -r lineno content; do
        # Simple time filter: compare leading timestamp if present
        ts=$(echo "$content" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}' || true)
        if [ -z "$ts" ] || [[ "$ts" > "$SINCE" ]] || [[ "$ts" == "$SINCE" ]]; then
          echo "$content	[$label:$lineno]"
        fi
      done >> "$TMPFILE" || true
    else
      grep -n "$KEYWORD" "$logfile" 2>/dev/null | while IFS=: read -r lineno content; do
        echo "$content	[$label:$lineno]"
      done >> "$TMPFILE" || true
    fi
  fi
}

# Search notifier log
search_log "notifier" "${LOGS_DIR}/notifier.log"

# Search xgw log
search_log "xgw" "${LOGS_DIR}/xgw.log"

# Search all agent logs and thread message files
if [ -d "$AGENTS_DIR" ]; then
  for agent_dir in "$AGENTS_DIR"/*/; do
    [ -d "$agent_dir" ] || continue
    agent_id="$(basename "$agent_dir")"

    # Agent main log
    search_log "agent:${agent_id}" "${agent_dir}logs/agent.log"

    # Thread message files
    if [ -d "${agent_dir}threads" ]; then
      for thread_dir in "${agent_dir}threads"/*/; do
        [ -d "$thread_dir" ] || continue
        thread_id="$(basename "$thread_dir")"
        if [ -f "${thread_dir}messages.json" ]; then
          search_log "agent:${agent_id}/thread:${thread_id}" "${thread_dir}messages.json"
        fi
      done
    fi
  done
fi

# Output results sorted by timestamp (lines starting with ISO timestamp sort naturally)
if [ ! -s "$TMPFILE" ]; then
  echo "No matching entries found."
else
  echo "Timeline:"
  echo "─────────────────────────────────────────────────────"
  # Sort by the log line content (timestamp prefix sorts chronologically)
  sort "$TMPFILE" | while IFS=$'\t' read -r content source; do
    printf "  %-60s  %s\n" "$content" "$source"
  done
  echo "─────────────────────────────────────────────────────"
  total=$(wc -l < "$TMPFILE" | tr -d ' ')
  echo "Total matches: $total"
fi

echo ""
echo "=== Done ==="
