# Vision

TheClaw is a agent runtime that inherits core principles from OpenClaw with several improvements:
1. Loose-coupled system architecture with composition of CLI commands. Which means:
  - Every system capability is a CLI command.
  - LLM is equiped only one `bash_exec` tool, with progressive discovery of system capabilities via builtin `cmds` CLI command.
2. Event-driven architecture with Thread (stream of events with artifacts) as first-class citizen. This will:
  - Basically support agent to have persistent memory and context.
  - Keep human/agent or agent/agent collaboration consistent and easily manageable.
  - Improve system observability/auditability/recoverability/etc.

# This Repo

`TheClaw` repo wraps all commands repos into one unified distributable agent platform.

NOTE: This is still in very early research and development phase, not ready yet.

# Architecture

See [SPEC.md](./SPEC.md) for complete architecture and design documentation.

**Completed Components:**
1. **pai** — LLM interaction (CLI/LIB dual interface)
   - Multiple providers/models, embedding, streaming chat with session support
2. **cmds** — Command discovery
   - Natural language search backed by tldr-pages and semantic search via xdb
3. **xdb** — Data collection and search
   - Unified interface over LanceDB (vector) and SQLite (relational/FTS)
4. **xweb** — Web interaction
   - search, fetch, explore with multiple provider support
5. **notifier** — Task scheduling daemon
   - Cron and immediate task scheduling
6. **thread** — Event stream and message bus (CLI/LIB dual interface)
   - SQLite-backed persistent event storage with subscription model
7. **xar** — Agent runtime daemon
   - In-memory event loop, streaming-capable IPC, agent run-loop
8. **xgw** — Message gateway daemon
   - Channel plugins (Telegram, Slack, TUI, etc.), IPC communication with xar


# Install

```bash
npm install -g @theclawlab/theclaw
```
