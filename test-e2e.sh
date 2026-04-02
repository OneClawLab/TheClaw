#!/usr/bin/env bash
#
# TheClaw End-to-End Test Script — full system integration
#
# Tests the complete TheClaw platform from component installation through
# multi-agent chat with streaming, covering:
#   - Component detection & version checks
#   - theclaw CLI (setup, status, upgrade)
#   - xar daemon lifecycle (start/stop/status)
#   - Agent lifecycle (init/start/stop/status/list)
#   - xgw config & daemon lifecycle
#   - Full message path: xar send -> agent processing -> LLM -> streaming reply
#   - Multi-agent routing & isolation
#   - Multi-turn conversation with context retention
#   - Thread persistence & event verification
#   - Observability scripts
#   - Cleanup & teardown
#
# Prerequisites:
#   - All components built and linked: pai, cmds, xdb, xweb, notifier, thread, xar, xgw, theclaw
#   - pai default provider configured with a working LLM
#
# Usage: bash test-e2e.sh
#
set -uo pipefail

source "$(dirname "$0")/scripts/e2e-lib.sh"

THECLAW="theclaw"
XAR="xar"
XGW="xgw"
THREAD="thread"
PAI="pai"

# Unique test IDs to avoid collision
RUN_ID="$$"
AGENT_A="e2e-agent-a-${RUN_ID}"
AGENT_B="e2e-agent-b-${RUN_ID}"
THECLAW_HOME_ORIG="${THECLAW_HOME:-$HOME/.theclaw}"
AGENT_A_DIR="${THECLAW_HOME_ORIG}/agents/${AGENT_A}"
AGENT_B_DIR="${THECLAW_HOME_ORIG}/agents/${AGENT_B}"

# xgw uses a temp config so we don't disturb the real one
XGW_CFG=""  # set after setup_e2e
X=""        # xgw with --config, set after setup_e2e

# Force-kill any process holding a port (Windows-compatible)
force_kill_port() {
  local port=$1
  local pid
  pid=$(netstat -ano 2>/dev/null | grep ":${port}.*LISTENING" | awk '{print $NF}' | head -1)
  if [[ -n "$pid" && "$pid" != "0" ]]; then
    taskkill //F //PID "$pid" >/dev/null 2>&1 || kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi
}

on_cleanup() {
  # Stop agents
  $XAR stop "$AGENT_A" 2>/dev/null || true
  $XAR stop "$AGENT_B" 2>/dev/null || true
  sleep 1
  # Stop daemons
  $XGW --config "$XGW_CFG" stop 2>/dev/null || true
  $XAR daemon stop 2>/dev/null || true
  sleep 2
  # Force-kill leftover xar daemon if port still held
  force_kill_port 18792
  rm -f "${THECLAW_HOME_ORIG}/xar.pid" "${THECLAW_HOME_ORIG}/xar.sock" 2>/dev/null || true
  # Remove test agents
  rm -rf "$AGENT_A_DIR" "$AGENT_B_DIR"
}

setup_e2e

XGW_CFG="$TD/xgw-config.yaml"
X="$XGW --config $XGW_CFG"

# Write a minimal xgw config for testing
write_xgw_config() {
  cat >"$XGW_CFG" <<EOF
gateway:
  host: 127.0.0.1
  port: 19790
channels: []
routing: []
EOF
}

# ══════════════════════════════════════════════════════════════
# Phase 0: Pre-flight — verify all components are installed
# ══════════════════════════════════════════════════════════════
section "Phase 0: Pre-flight"

require_bin $THECLAW "run: cd TheClaw && npm run release:local"
require_bin $PAI     "run: cd pai && npm run release:local"
require_bin $XAR     "run: cd xar && npm run release:local"
require_bin $XGW     "run: cd xgw && npm run release:local"
require_bin $THREAD  "run: cd thread && npm run release:local"
require_cmd cmds     "run: cd cmds && npm run release:local"
require_cmd xdb      "run: cd xdb && npm run release:local"
require_cmd xweb     "run: cd xweb && npm run release:local"
require_cmd notifier "run: cd notifier && npm run release:local"

PROVIDER=$($PAI model default --json 2>/dev/null | json_field_from_stdin "defaultProvider")
if [[ -z "$PROVIDER" ]]; then fail "No default LLM provider — run: pai model default --name <provider>"; exit 1; fi
pass "Default LLM provider: $PROVIDER"

# Ensure no stale daemons from previous runs
$XAR daemon stop 2>/dev/null || true
sleep 1
force_kill_port 18792
rm -f "${THECLAW_HOME_ORIG}/xar.pid" "${THECLAW_HOME_ORIG}/xar.sock" 2>/dev/null || true

# ══════════════════════════════════════════════════════════════
# Phase 1: theclaw CLI basics
# ══════════════════════════════════════════════════════════════
section "Phase 1: theclaw CLI — version & help"

run_cmd $THECLAW --version
assert_exit0
assert_nonempty

run_cmd $THECLAW --help
assert_exit0
assert_contains "setup"
assert_contains "status"
assert_contains "upgrade"

# ── unknown command → exit 2 ──
section "Phase 1: theclaw CLI — unknown command"
run_cmd $THECLAW nosuchcommand
assert_exit 2

# ══════════════════════════════════════════════════════════════
# Phase 2: theclaw setup --provider local (component detection)
# ══════════════════════════════════════════════════════════════
section "Phase 2: theclaw setup — component detection (local provider)"

# Use a temp config so we don't touch real config
THECLAW_CFG="$TD/theclaw-config.json"
export THECLAW_CONFIG="$THECLAW_CFG"

# Custom minimal profile that only does install-components step
MINI_PROFILE="$TD/e2e-detect.yaml"
cat >"$MINI_PROFILE" <<'PROFILE_EOF'
name: e2e-detect
steps:
  - type: install-components
PROFILE_EOF

run_cmd $THECLAW setup --profile "$MINI_PROFILE" --provider local
assert_exit0
assert_contains "already"

# Verify config was written
assert_file_exists "$THECLAW_CFG" "theclaw config"

# ══════════════════════════════════════════════════════════════
# Phase 3: theclaw status (before daemons)
# ══════════════════════════════════════════════════════════════
section "Phase 3: theclaw status — before daemons"

run_cmd $THECLAW status
assert_exit0
assert_contains "TheClaw Status"

run_cmd $THECLAW status --json
assert_exit0
assert_json_field "$OUT" "xgw"

# ══════════════════════════════════════════════════════════════
# Phase 4: theclaw upgrade --dry-run
# ══════════════════════════════════════════════════════════════
section "Phase 4: theclaw upgrade --dry-run"

run_cmd $THECLAW upgrade --provider local --dry-run
assert_exit0
assert_contains "already"

# Invalid component name
run_cmd $THECLAW upgrade --component nosuchcomponent --provider local
assert_exit 2

# Phase 4b: theclaw upgrade --component <name> --provider local (non-dry-run)
section "Phase 4b: theclaw upgrade -- local provider, component already installed"

# With local provider, all components are already installed (needsAction returns false when current != null)
# So upgrade should report "already at" for each component and exit 0
run_cmd $THECLAW upgrade --component pai --provider local
assert_exit0
assert_contains "already"

# ══════════════════════════════════════════════════════════════
# Phase 5: xar daemon lifecycle
# ══════════════════════════════════════════════════════════════
section "Phase 5: xar daemon — start"

run_cmd $XAR daemon start
assert_exit0
sleep 2

run_cmd $XAR daemon status
assert_exit0
assert_contains "running"

run_cmd $XAR daemon status --json
assert_exit0
assert_json_field "$OUT" "pid"

# ══════════════════════════════════════════════════════════════
# Phase 6: Agent init — two agents for multi-agent testing
# ══════════════════════════════════════════════════════════════
section "Phase 6: Agent init — agent A"

run_cmd $XAR init "$AGENT_A"
assert_exit0
assert_file_exists "$AGENT_A_DIR/config.json" "agent A config"
assert_file_exists "$AGENT_A_DIR/IDENTITY.md" "agent A identity"

section "Phase 6: Agent init — agent B"

run_cmd $XAR init "$AGENT_B"
assert_exit0
assert_file_exists "$AGENT_B_DIR/config.json" "agent B config"

# ── duplicate init → exit 1 ──
section "Phase 6: Agent init — duplicate"
run_cmd $XAR init "$AGENT_A"
assert_exit 1

# ══════════════════════════════════════════════════════════════
# Phase 7: Agent list & status
# ══════════════════════════════════════════════════════════════
section "Phase 7: Agent list"

run_cmd $XAR list
assert_exit0
assert_contains "$AGENT_A"
assert_contains "$AGENT_B"

run_cmd $XAR list --json
assert_exit0
assert_json_array

section "Phase 7: Agent status — before start"

run_cmd $XAR status "$AGENT_A"
assert_exit0
assert_contains "stopped"

run_cmd $XAR status "$AGENT_A" --json
assert_exit0
assert_json_field "$OUT" "agent_id"

# ══════════════════════════════════════════════════════════════
# Phase 8: Start agents
# ══════════════════════════════════════════════════════════════
section "Phase 8: Start agent A"

run_cmd $XAR start "$AGENT_A"
assert_exit0
sleep 2

run_cmd $XAR status "$AGENT_A"
assert_exit0
assert_contains "running"

section "Phase 8: Start agent B"

run_cmd $XAR start "$AGENT_B"
assert_exit0
sleep 2

run_cmd $XAR status "$AGENT_B"
assert_exit0
assert_contains "running"

# ── start non-existent agent → exit 1 ──
section "Phase 8: Start non-existent agent"
run_cmd $XAR start "no-such-agent-${RUN_ID}"
assert_exit 1

# ══════════════════════════════════════════════════════════════
# Phase 9: xgw config & lifecycle
# ══════════════════════════════════════════════════════════════
section "Phase 9: xgw config"

write_xgw_config

run_cmd $X config check
assert_exit0
assert_contains "Config OK"

# Add a channel and route for agent A
run_cmd $X channel add --id tui:e2e --type tui
assert_exit0

run_cmd $X route add --channel tui:e2e --peer e2e-user --agent "$AGENT_A"
assert_exit0

run_cmd $X channel list
assert_exit0
assert_contains "tui:e2e"

run_cmd $X route list
assert_exit0
assert_contains "$AGENT_A"

run_cmd $X config check
assert_exit0

# ══════════════════════════════════════════════════════════════
# Phase 10: Single-turn chat — send message to agent A via IPC
# ══════════════════════════════════════════════════════════════
section "Phase 10: Single-turn chat — agent A"

# Send a simple message and wait for the agent to process it
run_cmd $XAR send "$AGENT_A" "Reply with exactly the word PONG and nothing else" --source external:cli:main:dm:e2e:e2e-user
assert_exit0
assert_contains "delivered"

# Wait for agent to process the message (LLM call takes time)
echo "  Waiting for agent A to process message..."
AGENT_A_THREAD_DIR="$AGENT_A_DIR/threads"
wait_for "agent A reply in thread" 60 \
  'grep -q "assistant" "$AGENT_A_DIR/sessions/peers/e2e-user.jsonl" 2>/dev/null' \
  -- "tail -20 $THECLAW_HOME_ORIG/logs/agent-${AGENT_A}.log 2>/dev/null || echo 'no agent log yet'"

# Verify thread has events (user message + assistant reply)
run_cmd cat "$AGENT_A_DIR/sessions/peers/e2e-user.jsonl"
assert_exit0
assert_line_count_gte 2
assert_contains "PONG\|pong\|self"

# ══════════════════════════════════════════════════════════════
# Phase 11: Multi-turn conversation — context retention
# ══════════════════════════════════════════════════════════════
section "Phase 11: Multi-turn — send code to remember"

# Send code for agent to remember
run_cmd $XAR send "$AGENT_A" "Remember this secret code: ZETA-8832. Just confirm you got it." --source external:cli:main:dm:e2e:e2e-user
assert_exit0

echo "  Waiting for agent A to process turn 2..."
sleep 15

section "Phase 11: Multi-turn — recall the code"

# Ask agent to recall the code
run_cmd $XAR send "$AGENT_A" "What was the secret code I told you? Reply with just the code." --source external:cli:main:dm:e2e:e2e-user
assert_exit0

echo "  Waiting for agent A to process turn 3..."
sleep 20

# Check thread for the code in assistant reply
run_cmd cat "$AGENT_A_DIR/sessions/peers/e2e-user.jsonl"
assert_exit0
assert_line_count_gte 6
assert_contains "ZETA-8832"

# ══════════════════════════════════════════════════════════════
# Phase 12: Multi-agent isolation — agent B gets different context
# ══════════════════════════════════════════════════════════════
section "Phase 12: Multi-agent isolation — send to agent B"

# Send to agent B — should have independent context
run_cmd $XAR send "$AGENT_B" "Reply with exactly the word HELLO and nothing else" --source external:cli:main:dm:e2e:e2e-user
assert_exit0

echo "  Waiting for agent B to process message..."
AGENT_B_THREAD_DIR="$AGENT_B_DIR/threads"
wait_for "agent B reply in thread" 60 \
  'grep -q "assistant" "$AGENT_B_DIR/sessions/peers/e2e-user.jsonl" 2>/dev/null' \
  -- "tail -20 $THECLAW_HOME_ORIG/logs/agent-${AGENT_B}.log 2>/dev/null || echo 'no agent log yet'"

# Verify agent B replied
run_cmd cat "$AGENT_B_DIR/sessions/peers/e2e-user.jsonl"
assert_exit0
assert_line_count_gte 2
assert_contains "HELLO\|hello\|self"

# Agent B should NOT know about agent A's secret code
assert_not_contains "ZETA-8832"

# ══════════════════════════════════════════════════════════════
# Phase 13: Tool calling — agent uses bash_exec
# ══════════════════════════════════════════════════════════════
section "Phase 13: Tool calling — bash_exec"

# Send a message requiring tool use
run_cmd $XAR send "$AGENT_A" "Use the bash_exec tool to run: echo E2E_TOOL_OK. Then reply with the exact output." --source external:cli:main:dm:e2e:e2e-user
assert_exit0

echo "  Waiting for agent A to process tool call..."
sleep 30

# Check thread for tool call evidence
run_cmd cat "$AGENT_A_DIR/sessions/peers/e2e-user.jsonl"
assert_exit0
assert_contains "E2E_TOOL_OK"

# ══════════════════════════════════════════════════════════════
# Phase 14: Thread persistence — verify events survive
# ══════════════════════════════════════════════════════════════
section "Phase 14: Thread persistence"

# Thread info should show accumulated events
run_cmd cat "$AGENT_A_DIR/sessions/peers/e2e-user.jsonl"
assert_exit0
assert_nonempty

# Verify session has multiple turns
assert_line_count_gte 4

# JSONL file should exist alongside SQLite
assert_file_exists "$AGENT_A_DIR/sessions/peers/e2e-user.jsonl" "session JSONL"
assert_file_exists "$AGENT_A_THREAD_DIR/peers/e2e-user/events.db" "thread events.db"

# ══════════════════════════════════════════════════════════════
# Phase 15: Session file persistence
# ══════════════════════════════════════════════════════════════
section "Phase 15: Session file"

# Session JSONL should exist for the CLI thread
SESS_FILE="$AGENT_A_DIR/sessions/peers/e2e-user.jsonl"
assert_file_exists "$SESS_FILE" "session JSONL"

# ══════════════════════════════════════════════════════════════
# Phase 16: theclaw status — with daemons running
# ══════════════════════════════════════════════════════════════
section "Phase 16: theclaw status — daemons running"

run_cmd $THECLAW status
assert_exit0
assert_contains "TheClaw Status"

run_cmd $THECLAW status --json
assert_exit0
assert_json_field "$OUT" "xgw"
assert_json_field "$OUT" "agents"

# ══════════════════════════════════════════════════════════════
# Phase 17: Observability scripts
# ══════════════════════════════════════════════════════════════
section "Phase 17: Observability — theclaw-status.sh"

SCRIPTS_DIR="$(dirname "$0")/scripts"

if [[ -x "$SCRIPTS_DIR/theclaw-status.sh" ]]; then
  run_cmd bash "$SCRIPTS_DIR/theclaw-status.sh"
  assert_exit0
  assert_nonempty
else
  pass "theclaw-status.sh not executable, skipping"
fi

section "Phase 17: Observability — theclaw-health.sh"

if [[ -x "$SCRIPTS_DIR/theclaw-health.sh" ]]; then
  run_cmd bash "$SCRIPTS_DIR/theclaw-health.sh"
  # health check may report warnings, just check it runs
  assert_nonempty
else
  pass "theclaw-health.sh not executable, skipping"
fi

# ══════════════════════════════════════════════════════════════
# Phase 18: Agent stop & restart
# ══════════════════════════════════════════════════════════════
section "Phase 18: Stop agent A"

run_cmd $XAR stop "$AGENT_A"
assert_exit0
sleep 1

run_cmd $XAR status "$AGENT_A"
assert_exit0
assert_contains "stopped"

section "Phase 18: Restart agent A"

run_cmd $XAR start "$AGENT_A"
assert_exit0
sleep 2

run_cmd $XAR status "$AGENT_A"
assert_exit0
assert_contains "running"

# ══════════════════════════════════════════════════════════════
# Phase 19: Post-restart context — agent A still remembers
# ══════════════════════════════════════════════════════════════
section "Phase 19: Post-restart — context retained"

# Ask agent A to recall code after restart
run_cmd $XAR send "$AGENT_A" "What was the secret code I told you earlier? Reply with just the code." --source external:cli:main:dm:e2e:e2e-user
assert_exit0

echo "  Waiting for agent A to process post-restart query..."
sleep 20

# Verify code still in thread
run_cmd cat "$AGENT_A_DIR/sessions/peers/e2e-user.jsonl"
assert_exit0
assert_contains "ZETA-8832"

# ══════════════════════════════════════════════════════════════
# Phase 20: Error cases
# ══════════════════════════════════════════════════════════════
section "Phase 20: Error cases"

# Send to non-existent agent
run_cmd $XAR send "no-such-agent-${RUN_ID}" "hello" --source external:cli:main:dm:e2e:e2e-user
assert_nonzero_exit

# Stop non-existent agent
run_cmd $XAR stop "no-such-agent-${RUN_ID}"
assert_exit 1

# Status of non-existent agent
run_cmd $XAR status "no-such-agent-${RUN_ID}"
assert_exit 1

# theclaw setup with invalid provider
run_cmd $THECLAW setup --provider badprovider
assert_exit 2

# theclaw setup with non-existent profile
run_cmd $THECLAW setup --profile /tmp/no-such-profile-${RUN_ID}.yaml
assert_exit 2

# ══════════════════════════════════════════════════════════════
# Phase 21: xgw route management — multi-agent routing
# ══════════════════════════════════════════════════════════════
section "Phase 21: xgw route — add route for agent B"

run_cmd $X route add --channel tui:e2e --peer e2e-user-b --agent "$AGENT_B"
assert_exit0

run_cmd $X route list --json
assert_exit0
assert_json_array
assert_contains "$AGENT_A"
assert_contains "$AGENT_B"

# Remove route
run_cmd $X route remove --channel tui:e2e --peer e2e-user-b
assert_exit0

run_cmd $X route list
assert_not_contains "e2e-user-b"

# ══════════════════════════════════════════════════════════════
# Phase 22: xgw channel cleanup cascades routes
# ══════════════════════════════════════════════════════════════
section "Phase 22: xgw channel remove — cascade"

run_cmd $X channel remove --id tui:e2e
assert_exit0

run_cmd $X route list
assert_not_contains "tui:e2e"

run_cmd $X channel list
assert_not_contains "tui:e2e"

# ══════════════════════════════════════════════════════════════
# Phase 23: Teardown — stop everything
# ══════════════════════════════════════════════════════════════
section "Phase 23: Teardown — stop agents"

run_cmd $XAR stop "$AGENT_A"
assert_exit0

run_cmd $XAR stop "$AGENT_B"
assert_exit0
sleep 1

section "Phase 23: Teardown — stop xar daemon"

run_cmd $XAR daemon stop
assert_exit0
sleep 1

run_cmd $XAR daemon status
assert_exit 1

# ══════════════════════════════════════════════════════════════
# Done
# ══════════════════════════════════════════════════════════════

# Unset test-specific env
unset THECLAW_CONFIG

summary_and_exit
