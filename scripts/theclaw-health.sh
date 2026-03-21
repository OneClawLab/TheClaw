#!/usr/bin/env bash
# theclaw-health.sh - Health check for all platform components
# 需求：6.5、6.6、6.7 - Does NOT depend on theclaw CLI itself
# Usage: theclaw-health.sh [--json]

set -euo pipefail

THECLAW_HOME="${THECLAW_HOME:-$HOME/.theclaw}"
JSON_OUTPUT=0

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      JSON_OUTPUT=1
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--json]"
      echo ""
      echo "Options:"
      echo "  --json   Output structured JSON (HealthCheckResult format)"
      exit 0
      ;;
    *)
      echo "[error] Unknown argument: $1" >&2
      echo "Use --help for usage information." >&2
      exit 2
      ;;
  esac
done

# ── Check functions ──────────────────────────────────────────────────────────

# Returns: sets CHECK_STATUS (ok|warning|error) and CHECK_DETAIL
check_notifier() {
  if ! command -v notifier &>/dev/null; then
    CHECK_STATUS="error"
    CHECK_DETAIL="notifier command not found"
    return
  fi
  local out
  if out=$(notifier status 2>&1); then
    CHECK_STATUS="ok"
    CHECK_DETAIL="running"
  else
    CHECK_STATUS="error"
    CHECK_DETAIL="notifier status failed: $(echo "$out" | head -1)"
  fi
}

check_xgw() {
  if ! command -v xgw &>/dev/null; then
    CHECK_STATUS="error"
    CHECK_DETAIL="xgw command not found"
    return
  fi
  local out
  if out=$(xgw status 2>&1); then
    CHECK_STATUS="ok"
    CHECK_DETAIL="running"
  else
    CHECK_STATUS="error"
    CHECK_DETAIL="xgw status failed: $(echo "$out" | head -1)"
  fi
}

# Check a single agent; sets CHECK_STATUS and CHECK_DETAIL
check_agent() {
  local agent_id="$1"
  if ! command -v agent &>/dev/null; then
    CHECK_STATUS="error"
    CHECK_DETAIL="agent command not found"
    return
  fi
  local out
  if out=$(agent status "$agent_id" 2>&1); then
    CHECK_STATUS="ok"
    CHECK_DETAIL="running"
  else
    CHECK_STATUS="error"
    CHECK_DETAIL="agent status $agent_id failed: $(echo "$out" | head -1)"
  fi
}

# Check inbox backlog for an agent; sets CHECK_STATUS and CHECK_DETAIL
check_agent_inbox() {
  local agent_id="$1"
  local inbox_dir="${THECLAW_HOME}/agents/${agent_id}/inbox"
  if [ ! -d "$inbox_dir" ]; then
    CHECK_STATUS="ok"
    CHECK_DETAIL="inbox dir not found (assuming empty)"
    return
  fi
  local count
  count=$(find "$inbox_dir" -maxdepth 1 -type f | wc -l | tr -d ' ')
  if [ "$count" -eq 0 ]; then
    CHECK_STATUS="ok"
    CHECK_DETAIL="inbox empty"
  elif [ "$count" -lt 10 ]; then
    CHECK_STATUS="ok"
    CHECK_DETAIL="inbox backlog: $count"
  elif [ "$count" -lt 50 ]; then
    CHECK_STATUS="warning"
    CHECK_DETAIL="inbox backlog: $count (elevated)"
  else
    CHECK_STATUS="error"
    CHECK_DETAIL="inbox backlog: $count (critical)"
  fi
}

# ── Collect results ──────────────────────────────────────────────────────────

# Arrays to accumulate check results
declare -a CHECK_NAMES=()
declare -a CHECK_STATUSES=()
declare -a CHECK_DETAILS=()

add_check() {
  CHECK_NAMES+=("$1")
  CHECK_STATUSES+=("$2")
  CHECK_DETAILS+=("$3")
}

CHECK_STATUS=""; CHECK_DETAIL=""

check_notifier
add_check "notifier" "$CHECK_STATUS" "$CHECK_DETAIL"

check_xgw
add_check "xgw" "$CHECK_STATUS" "$CHECK_DETAIL"

AGENTS_DIR="${THECLAW_HOME}/agents"
if [ -d "$AGENTS_DIR" ]; then
  for agent_dir in "$AGENTS_DIR"/*/; do
    [ -d "$agent_dir" ] || continue
    agent_id="$(basename "$agent_dir")"

    check_agent "$agent_id"
    add_check "agent:${agent_id}" "$CHECK_STATUS" "$CHECK_DETAIL"

    check_agent_inbox "$agent_id"
    add_check "agent:${agent_id}:inbox" "$CHECK_STATUS" "$CHECK_DETAIL"
  done
fi

# Determine overall health
overall_healthy=true
for s in "${CHECK_STATUSES[@]}"; do
  if [ "$s" = "error" ]; then
    overall_healthy=false
    break
  fi
done

# ── Output ───────────────────────────────────────────────────────────────────

if [ "$JSON_OUTPUT" -eq 1 ]; then
  # Build HealthCheckResult JSON
  healthy_val="true"
  $overall_healthy || healthy_val="false"

  printf '{\n'
  printf '  "healthy": %s,\n' "$healthy_val"
  printf '  "checks": [\n'

  total=${#CHECK_NAMES[@]}
  for i in "${!CHECK_NAMES[@]}"; do
    name="${CHECK_NAMES[$i]}"
    status="${CHECK_STATUSES[$i]}"
    detail="${CHECK_DETAILS[$i]}"
    # Escape detail for JSON
    detail_escaped="${detail//\\/\\\\}"
    detail_escaped="${detail_escaped//\"/\\\"}"
    comma=""
    [ $((i + 1)) -lt "$total" ] && comma=","
    printf '    {"name": "%s", "status": "%s", "detail": "%s"}%s\n' \
      "$name" "$status" "$detail_escaped" "$comma"
  done

  printf '  ]\n'
  printf '}\n'
else
  echo "=== TheClaw Health Check ==="
  echo ""

  for i in "${!CHECK_NAMES[@]}"; do
    name="${CHECK_NAMES[$i]}"
    status="${CHECK_STATUSES[$i]}"
    detail="${CHECK_DETAILS[$i]}"

    case "$status" in
      ok)      icon="✓" ;;
      warning) icon="⚠" ;;
      error)   icon="✗" ;;
      *)       icon="?" ;;
    esac

    printf "  %s  %-40s  %s\n" "$icon" "$name" "$detail"
  done

  echo ""
  if $overall_healthy; then
    echo "Overall: HEALTHY"
  else
    echo "Overall: UNHEALTHY"
  fi
  echo ""
  echo "=== Done ==="
fi
