#!/usr/bin/env bash
# theclaw-trace.sh - Trace a message through the platform in timeline format
# Does NOT depend on theclaw CLI itself
# Usage: theclaw-trace.sh --keyword <text> [--since <time>]
#        theclaw-trace.sh --message-id <uuid>
#
# Log file locations searched:
#   $THECLAW_HOME/logs/notifier.log
#   $THECLAW_HOME/logs/xgw.log
#   $THECLAW_HOME/logs/xar.log
#   $THECLAW_HOME/logs/agent-<id>.log
#   $THECLAW_HOME/agents/<id>/threads/<thread-id>/events.jsonl

set -euo pipefail

THECLAW_HOME="${THECLAW_HOME:-$HOME/.theclaw}"
MESSAGE_ID=""
KEYWORD=""
SINCE=""

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
      echo "Usage: $0 --keyword <text> [--since <time>]"
      echo "       $0 --message-id <uuid>"
      echo ""
      echo "Options:"
      echo "  --keyword <text>      Search for messages containing keyword"
      echo "  --message-id <uuid>   Search for a specific message UUID"
      echo "  --since <time>        Limit to entries after this time (e.g. '2024-01-01 00:00:00')"
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
  echo "[error] Must specify --keyword <text> or --message-id <uuid>" >&2
  echo "Use --help for usage information." >&2
  exit 2
fi

PATTERN="${MESSAGE_ID:-$KEYWORD}"

LOGS_DIR="${THECLAW_HOME}/logs"
AGENTS_DIR="${THECLAW_HOME}/agents"

echo "=== TheClaw Message Trace ==="
if [ -n "$MESSAGE_ID" ]; then
  echo "Message ID: $MESSAGE_ID"
else
  echo "Keyword: $KEYWORD"
  [ -n "$SINCE" ] && echo "Since: $SINCE"
fi
echo ""

TMPFILE="$(mktemp)"
trap 'rm -f "$TMPFILE"' EXIT

# Search a log file; append matching lines as "<content>\t[label:lineno]"
search_log() {
  local label="$1"
  local logfile="$2"
  [ -f "$logfile" ] || return 0

  grep -n "$PATTERN" "$logfile" 2>/dev/null | while IFS=: read -r lineno content; do
    # Apply --since filter on ISO timestamp prefix if present
    if [ -n "$SINCE" ]; then
      ts=$(echo "$content" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}' || true)
      if [ -n "$ts" ] && [[ "$ts" < "$SINCE" ]]; then
        continue
      fi
    fi
    printf '%s\t[%s:%s]\n' "$content" "$label" "$lineno"
  done >> "$TMPFILE" || true
}

# Platform logs
search_log "notifier"   "${LOGS_DIR}/notifier.log"
search_log "xgw"        "${LOGS_DIR}/xgw.log"
search_log "xar"        "${LOGS_DIR}/xar.log"

# Per-agent logs and thread event logs
if [ -d "$AGENTS_DIR" ]; then
  for agent_dir in "$AGENTS_DIR"/*/; do
    [ -d "$agent_dir" ] || continue
    agent_id="$(basename "$agent_dir")"

    search_log "agent:${agent_id}" "${LOGS_DIR}/agent-${agent_id}.log"

    # Thread events.jsonl files (one JSON object per line)
    if [ -d "${agent_dir}threads" ]; then
      for thread_dir in "${agent_dir}threads"/*/; do
        [ -d "$thread_dir" ] || continue
        thread_id="$(basename "$thread_dir")"
        search_log "agent:${agent_id}/thread:${thread_id}" "${thread_dir}events.jsonl"
      done
    fi
  done
fi

# Output sorted by timestamp prefix (ISO timestamps sort lexicographically)
if [ ! -s "$TMPFILE" ]; then
  echo "No matching entries found."
else
  echo "Timeline:"
  echo "─────────────────────────────────────────────────────"
  sort "$TMPFILE" | while IFS=$'\t' read -r content source; do
    printf "  %-60s  %s\n" "$content" "$source"
  done
  echo "─────────────────────────────────────────────────────"
  total=$(wc -l < "$TMPFILE" | tr -d ' ')
  echo "Total matches: $total"
fi

echo ""
echo "=== Done ==="
