# Vision

TheClaw is a agent runtime that inherits core principles from OpenClaw with several improvements:
1. Loose-coupled system architecture with composition of CLI commands. Which means:
  - Every system capability is a CLI command.
  - LLM is equiped only one `bash_exec` tool, with progressive discovery of system capabilities via builtin `cmds` CLI command.
2. Event-driven architecture with Thread (stream of events with artifacts) as first-class citizen. This will:
  - Basically support agent to have persistent memory and context.
  - Keep human/agent or agent/agent collaboration consistent and easily manageable.
  - Improve system observability/auditability/recoverability/etc.

See DESIGN.md (just brain dump) for more details.

# This Repo

TheClaw wraps all commands repos into one unified distributable agent platform.

NOTE: This is still in very early research and development phase, not ready yet.

# Current Progress: Architecting

**Completed:**
1. pai: LLM interaction command
- Support many providers/models, embedding, chat with basic session support and stream mode. 
- It's a thin wrapper of @mariozechner/pi-ai.
2. cmds: command discover command
- Natural language search and smart routing to executable commands, backed by tldr-pages data and semantic search via xdb.
3. xdb: data collection command.
- Intent-driven data hub CLI. 
- Unified interface over LanceDB (vector) and SQLite (relational/FTS), with automatic embedding (internal or via pai).
4. xweb: web interaction command.
- search, fetch, etc. For both humans and LLM agents.
- support brave/tavily/serper provider, fallback to simple fetch based search with Bing or Google.

**Planned:**
1. thread: thread management command.
2. agent: agent management and interaction command.
3. xgw: gateway command.
- Possiblly a thin wrapper of the gateway part of OpenClaw.

