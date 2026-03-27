# TheClaw: Agent Runtime Platform

## Vision

TheClaw is an agent runtime platform that inherits core principles from OpenClaw with several improvements:

1. **Loose-coupled system architecture** with composition of CLI commands:
   - Every system capability is a CLI command
   - LLM is equipped only one `bash_exec` tool, with progressive discovery of system capabilities via builtin `cmds` CLI command

2. **Event-driven architecture** with Thread (stream of events with artifacts) as first-class citizen:
   - Supports agent persistent memory and context
   - Keeps human/agent or agent/agent collaboration consistent and easily manageable
   - Improves system observability, auditability, recoverability

3. **Streaming-capable runtime** for real-time LLM interactions:
   - Replaces file-system-based message passing with in-memory/IPC event loops
   - Enables token-by-token streaming from LLM to client
   - Maintains CLI as the sole LLM tool interface

---

## Architecture Overview

### v1: CLI Orchestration Layer (薄壳层)

TheClaw v1 is a thin orchestration shell that:
- Manages system initialization and component lifecycle
- Provides unified status/logs/trace observability
- Does not implement business logic—only composes CLI commands
- Uses internal provider model for component installation

**Key Components:**
- `theclaw setup`: System initialization with profile-driven configuration
- `theclaw status`: Aggregated system status view
- `theclaw upgrade`: Component version management
- Observability scripts: `theclaw-status.sh`, `theclaw-logs.sh`, `theclaw-threads.sh`, `theclaw-trace.sh`, `theclaw-health.sh`

### v2: Streaming-Capable Runtime Architecture

TheClaw v2 upgrades the message flow from file-system-based process orchestration to in-memory/IPC service orchestration:

**v1 Message Path (Process-based):**
```
xgw → thread push(CLI) → notifier dispatch(file polling) → agent run(CLI) 
→ pai chat(CLI) → thread push(CLI) → outbound consumer → agent deliver(CLI) → xgw send(CLI)
```
Each arrow = process boundary, 6-8 process launches per message, no streaming possible.

**v2 Message Path (IPC-based):**
```
client → xgw(WebSocket) → xar daemon(IPC) → pai lib(streaming LLM) 
→ xar daemon(IPC) → xgw(WebSocket) → client
```
Streaming-capable, in-process or IPC, no batch processing boundaries.

### Component Architecture (v2)

```
┌─────────────────────────────────────────────────────────┐
│  LLM 工具层（CLI，给 LLM 的 bash_exec 调用）              │
│  cmds  xdb  xweb  pai  thread(管理CLI)  agent(管理CLI)   │
└─────────────────────────────────────────────────────────┘
         │ bash_exec
┌────────▼────────────────────────────────────────────────┐
│  Agent Runtime (xar daemon)                              │
│  ├── 事件循环（内存，替代 notifier dispatch）              │
│  ├── Thread 存储（SQLite lib，替代 thread CLI 调用）       │
│  ├── Agent Run-loop（内存调度，替代 notifier 文件轮询）    │
│  ├── LLM 调用（pai lib，替代 pai CLI 调用）               │
│  └── IPC Server（Unix socket / local HTTP+WS）           │
└────────┬────────────────────────────────────────────────┘
         │ IPC（streaming-capable）
┌────────▼────────────────────────────────────────────────┐
│  xgw daemon                                              │
│  ├── Channel plugins（telegram, slack, tui, webchat...） │
│  └── IPC Client（连接 xar）                              │
└────────┬────────────────────────────────────────────────┘
         │ WebSocket / Webhook / Polling
┌────────▼────────────────────────────────────────────────┐
│  外部渠道 & 客户端                                        │
│  xgw-tui  webchat  telegram  slack  ...                  │
└─────────────────────────────────────────────────────────┘
```

---

## Design Principles

1. **Thin orchestration layer**: TheClaw self does not implement business logic, only composes CLI commands
2. **Internal provider model**: Component versions and installation methods are built into code via `--provider` parameter
3. **Profile-driven initialization**: All setup behavior declared in profile files
4. **Observability first**: Comprehensive status/logs/trace scripts for human and maintainer agent visibility
5. **LLM tool interface is CLI**: All system capabilities exposed as CLI commands, LLM has only `bash_exec` tool
6. **Agent as directory**: Each agent's data stored in `~/.theclaw/agents/<id>/`, filesystem is ground truth
7. **Thread as first-class citizen**: Event stream, persistent memory, observability foundation
8. **Streaming-capable**: Token-by-token LLM output transmission through IPC to client

---

## Package Structure

```
TheClaw/
├── profiles/
│   ├── minimal.yaml          # 最简配置 profile
│   └── standard.yaml         # 标准配置 profile
├── scripts/
│   ├── theclaw-status.sh     # 聚合各组件状态
│   ├── theclaw-logs.sh       # 聚合各组件日志
│   ├── theclaw-threads.sh    # 列出所有 thread 及摘要
│   ├── theclaw-trace.sh      # 追踪一条消息的完整路径
│   └── theclaw-health.sh     # 健康检查（供 maintainer agent 调用）
├── src/
│   ├── index.ts              # Entry point, CLI parsing & dispatch
│   ├── commands/
│   │   ├── setup.ts          # theclaw setup
│   │   ├── status.ts         # theclaw status
│   │   └── upgrade.ts        # theclaw upgrade
│   ├── profile-loader.ts     # Profile YAML 解析、占位符填充
│   ├── component-manager.ts  # 组件检测与安装（provider 内置在代码中）
│   └── types.ts              # 共享类型定义
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── SPEC.md
```

---

## CLI Commands

### `theclaw setup`

System initialization. Detailed flow in BootstrapDesign.md.

```bash
theclaw setup [--profile <name|path>] [--reset]
```

| Parameter | Description |
|-----------|-------------|
| `--profile` | Profile name (search in `profiles/`) or file path. Default: `standard` |
| `--reset` | Clear existing config and reinitialize |

**Execution Summary:**

1. Read component list from built-in provider, detect and install missing components
2. Load profile, interactively fill `${VAR}` placeholders
3. Configure pai providers
4. Initialize agents (admin → warden → maintainer → evolver)
5. Start notifier daemon
6. Configure and start xgw
7. Start agents (register inbox subscriptions)
8. Smoke test

**Idempotency**: Repeated execution skips completed steps (unless `--reset`).

**Exit codes**: `0` success, `1` component install/config error, `2` argument error.

### `theclaw status`

Aggregate component status, provide system global view.

```bash
theclaw status [--json] [--deep]
```

| Parameter | Description |
|-----------|-------------|
| `--json` | Structured JSON output |
| `--deep` | Deep check (probe component connectivity, not just read status files) |

**Default Output (human-readable):**

```
TheClaw Status
──────────────────────────────────
notifier    running   pid=12345
xgw         running   pid=12346   channels: telegram-main ✓
agents:
  admin       active    inbox: 0 pending
  warden      active    inbox: 0 pending
  maintainer  active    inbox: 0 pending
  evolver     active    inbox: 0 pending
──────────────────────────────────
```

### `theclaw upgrade`

Upgrade system components.

```bash
theclaw upgrade [--component <name>] [--dry-run]
```

| Parameter | Description |
|-----------|-------------|
| `--component` | Upgrade only specified component. Omit to upgrade all |
| `--dry-run` | Show operations without executing |

---

## Components Provider

Installation method determined by provider, built into theclaw code. Select via `--provider` parameter, default is `registry`.

```bash
theclaw setup --provider registry   # default
theclaw setup --provider local
theclaw upgrade --provider local
```

### Built-in Providers

**`registry`** (default)

Install from npm registry:
```
npm install -g @theclaw/<name>@<version>
```

**`local`**

Build and link from local source, depends on `THECLAW_SOURCE_ROOT` environment variable:
```
cd ${THECLAW_SOURCE_ROOT}/<name> && npm run build && npm link
```

---

## Component Transformation Roadmap (v2)

### pai — CLI/LIB Dual Interface Module

**Status**: ✅ Complete

**Transformation:**
- Core logic extracted to `src/lib/`
- `src/index.ts` as ESM lib entry, exports all public interfaces
- `src/cli.ts` as CLI entry, maintains existing `pai chat` / `pai model` commands
- Streaming interface returns `AsyncIterable<string>`, not direct stdout write

**xar Usage**: Import pai lib, call directly, stream tokens forwarded to xgw via IPC.

**LLM Value**: `pai chat` CLI unchanged, LLM can continue independent LLM calls.

### thread — CLI/LIB Dual Interface Module

**Status**: ✅ Complete

**Transformation:**
- Core storage logic extracted to `src/lib/`, CLI as thin wrapper
- lib interface driven by xar's actual needs, not mechanical CLI lib-ification
- CLI positioned as management and diagnostic tool, not promoted as primary LLM tool

**xar Usage**: Import thread lib, operate SQLite directly, not via CLI.

**LLM Value**: thread CLI preserved for advanced users and debugging.

### xar — Agent Runtime Daemon (全新实现)

**Status**: ✅ Complete

**Positioning**: New implementation from scratch, not refactored from old `agent` repo. Old `agent` repo kept as reference documentation, archived after xar stabilizes.

**Responsibilities:**
- In-memory event loop (replaces notifier file-polling-driven scheduling)
- Thread event storage (via `thread` lib direct SQLite operation, not CLI)
- Agent run-loop (async concurrent across agents, serial within agent)
- LLM calls (via `pai` lib, not CLI)
- Cron scheduling (built-in, only for agent internal tasks like memory compression, periodic introspection)
- IPC Server (for xgw and management CLI connection)

**External Interfaces:**
- IPC Server (xgw communicates via this interface)
- Management CLI (`agent` command for init/start/stop/status/list, for humans and LLM)

**Streaming Support:**
- xar holds LLM streaming write handle
- Pushes tokens in real-time to xgw via IPC
- xgw forwards via WebSocket to client

**Naming:**
- Development: repo named `xar` (x + agent runtime)
- Stable: CLI command renamed to `agent`, old `agent` repo deprecated

**Internal Architecture:**

```
xar/
├── src/
│   ├── index.ts              # CLI 入口（commander，命令名 xar）
│   ├── config.ts             # 环境变量与路径配置
│   ├── logging.ts            # Daemon/agent 日志工具
│   ├── types.ts              # 共享类型定义
│   ├── commands/             # CLI 子命令
│   │   ├── daemon.ts         # xar daemon start/stop/status
│   │   ├── init.ts           # xar init <id>
│   │   ├── start.ts          # xar start <id>
│   │   ├── stop.ts           # xar stop <id>
│   │   ├── status.ts         # xar status [<id>]
│   │   ├── list.ts           # xar list
│   │   ├── chat.ts           # xar chat（调试用）
│   │   └── send.ts           # xar send（调试用）
│   ├── daemon/
│   │   ├── index.ts          # Daemon 主入口（生命周期、agent 管理、IPC 消息处理）
│   │   ├── ipc-chunk-writer.ts # Writable 实现，将 LLM token 写入 IPC stream
│   │   ├── pid.ts            # PID 文件管理
│   │   └── types.ts
│   ├── agent/
│   │   ├── config.ts         # Agent 配置加载与校验
│   │   ├── run-loop.ts       # 消息处理循环（per-agent async，不同 agent 并发）
│   │   ├── router.ts         # inbox 消息 → 目标 thread 路由
│   │   ├── context.ts        # LLM context 构建（system prompt 组装）
│   │   ├── memory.ts         # Session compact（对齐 agent repo compactor 逻辑）
│   │   ├── session.ts        # Session JSONL 读写、token 估算
│   │   ├── queue.ts          # AsyncQueue<Message>（per-agent 内存消息队列）
│   │   ├── thread-lib.ts     # thread lib 封装（open/init/exists）
│   │   ├── deliver.ts        # 出站投递（通过 IPC → xgw）
│   │   └── types.ts
│   ├── ipc/
│   │   ├── server.ts         # createIpcServer()（WebSocket over Unix socket + TCP fallback）
│   │   ├── client.ts         # IpcClient（CLI 命令用）
│   │   └── types.ts
│   └── repo-utils/           # 跨 repo 共通工具（从 pai 同步）
├── package.json              # dependencies: thread, pai（均为 CLI/LIB 双接口模块）
├── tsconfig.json
├── tsup.config.ts            # 单 entry: src/index.ts，带 shebang
└── vitest.config.ts
```

**CLI Command Structure:**

```
xar daemon start              # 启动 xar daemon（后台）
xar daemon stop               # 停止 xar daemon
xar daemon status             # 查看 daemon 运行状态

xar init <id> [--kind system|user]   # 初始化 agent
xar start <id>                       # 启动 agent（注册到 daemon）
xar stop <id>                        # 停止 agent（从 daemon 注销）
xar status [<id>]                    # 查看 agent 状态
xar list                             # 列出所有 agent
```

**Core Runtime Mechanism:**

1. **Message Queue Model**: Each agent owns independent in-memory message queue (`AsyncQueue<Message>`). IPC server distributes inbound messages by `agent_id` to corresponding queue, run-loop continuously consumes via `for await`. Naturally implements "concurrent across agents, serial within agent".

2. **run-loop Lifecycle**: run-loop runs continuously after daemon startup, awaits new messages on empty queue, never exits. Necessary for streaming—LLM call needs persistent IPC connection to push tokens.

3. **Tool Call Execution**: tool call (`bash_exec`) handled internally by pai lib, xar doesn't intercept. xar only passes allowed tool config when calling pai lib.

4. **Memory Management** (two-level):
   - **Session-level compact (sync path)**: Before each LLM call, context.ts checks current session token estimate, compacts if over threshold, writes to `sessions/<thread_id>.jsonl`
   - **Cross-session Memory (async path)**: After processing each message, run-loop emits session lifecycle events, background memory processor consumes asynchronously, updates per-peer or per-agent memory

5. **Session Files & Lightweight Sub-agents**: `pai chat --session <file>` session file mechanism fully preserved. Enables `pai chat` itself as stateful multi-turn tool, suitable for temporary sub-agents, human-LLM interaction, agent-internal one-off subtasks.

### xgw — Upgrade to IPC Communication

**Status**: ✅ Complete

**Transformation:**
- Inbound: channel plugin receives message, sends via IPC to xar (not `thread push` CLI)
- Outbound: xar actively pushes reply to xgw via IPC, xgw forwards to channel (not wait for `agent deliver` CLI)
- IPC protocol supports streaming (xar → xgw token stream)

**Message Path:**
```
Inbound:  client → xgw(ws/webhook) → xar(IPC)
Outbound: xar(IPC) → xgw(ws/webhook) → client
```

**Unchanged:**
- Channel plugin model (telegram, slack, tui, webchat, etc.)
- All management CLI (`xgw status/reload/route/channel/agent`)
- `xgw send` CLI downgraded to diagnostic/test tool, no longer agent outbound path

### notifier — Keep Current, Independent Evolution

**Status**: ✅ No transformation

**Positioning**: Independent general-purpose task scheduling tool, xar doesn't depend on it. xar implements own scheduling logic. notifier evolves independently.

**LLM Value**: `notifier task add` / `notifier timer add` are valid LLM tools for arbitrary shell command scheduling.

### cmds — Keep Current, Independent Evolution

**Status**: ✅ No transformation

**Positioning**: LLM capability discovery entry point, stability paramount.

### xdb — Keep Current, Optional Future Transformation

**Status**: ✅ No transformation

**Current**: Pure CLI, unchanged.

**Optional Future**: Transform to CLI/LIB dual interface, cmds could optionally depend on its lib interface (but incremental value limited, not priority).

### xweb — Keep Current, Independent Evolution

**Status**: ✅ No transformation

**Positioning**: Foundation for LLM internet access, stable encapsulation unit, independent iteration.

### agent (old repo) — Functionality Absorbed by xar, Archived

**Status**: ✅ Deprecated, archived

**No Refactoring**: Old `agent` repo design assumptions (notifier-driven, file-lock serial) differ too much from xar, refactoring more painful than rewrite.

**Handling**: Archived deprecated (README marked DEPRECATED), kept as design reference. Old `agent` CLI commands (init/start/stop/status/list/chat/send) completely replaced by xar management CLI. `agent run` and `agent deliver` internalized into xar daemon run-loop and IPC delivery.

---

## Streaming Complete Path (v2)

```
User input
  → xgw-tui (WebSocket)
  → xgw TUI plugin
  → xgw IPC → xar (in-memory queue)
  → agent run-loop
  → pai lib (streaming LLM call)
  → streaming tokens → xar IPC → xgw
  → xgw TUI plugin (WebSocket push)
  → xgw-tui terminal real-time display
```

Each hop in-process or streaming-capable IPC, no batch processing boundaries.

---

## xar IPC Protocol (Draft)

xar exposes IPC Server supporting following operations:

### Connection Method

Prefer Unix socket (`~/.theclaw/xar.sock`), fallback to local HTTP+WebSocket (`127.0.0.1:18792`).

### Message Types

**Inbound (xgw → xar):**
```json
{ "type": "inbound_message", "agent_id": "admin", "message": { ...Message } }
```

**Outbound streaming (xar → xgw):**
```json
{ "type": "stream_start", "reply_context": { "channel_id": "...", "peer_id": "...", "session_id": "..." } }
{ "type": "stream_token", "token": "Hello" }
{ "type": "stream_token", "token": " world" }
{ "type": "stream_end" }
```

**Management operations (CLI → xar):**
```json
{ "type": "agent_init", "agent_id": "admin", "kind": "system" }
{ "type": "agent_start", "agent_id": "admin" }
{ "type": "agent_stop", "agent_id": "admin" }
{ "type": "agent_status", "agent_id": "admin" }
{ "type": "task_add", "author": "...", "task_id": "...", "command": "..." }
{ "type": "timer_add", "author": "...", "task_id": "...", "timer": "0 2 * * *", "command": "..." }
```

---

## Configuration Data Boundaries

TheClaw manages only its own config, doesn't intrude into component config spaces:

| Data | Location | Manager |
|------|----------|---------|
| theclaw config | `~/.config/theclaw/config.json` | theclaw |
| profile record | `~/.config/theclaw/config.json` | theclaw |
| pai config | `~/.config/pai/default.json` | pai (theclaw writes via `pai model config` during setup) |
| xgw config | `~/.config/xgw/config.yaml` | xgw (theclaw writes directly during setup) |
| agent config | `~/.theclaw/agents/<id>/config.yaml` | agent (theclaw writes via `agent init` during setup) |
| notifier data | `~/.local/share/notifier/` | notifier |

`~/.config/theclaw/config.json` content:

```json
{
  "schema_version": "1",
  "profile": "standard",
  "setup_completed_at": "2026-03-20T10:00:00Z",
  "components_yaml_path": "/usr/lib/node_modules/theclaw/components.yaml"
}
```

---

## Observability Scripts

Located in `scripts/` directory, distributed with theclaw package. Pure bash scripts, don't depend on theclaw runtime, humans and maintainer agent can call directly.

### `theclaw-status.sh`

Shortcut script aggregating component status. Equivalent to `theclaw status` but doesn't depend on theclaw command itself.

### `theclaw-logs.sh`

Aggregate view of recent component logs.

```bash
theclaw-logs.sh [--lines <n>] [--component <name>]
```

Default shows last 20 lines per component.

### `theclaw-threads.sh`

List all threads in system with summary info.

```bash
theclaw-threads.sh [--agent <id>]
```

### `theclaw-trace.sh`

Trace complete path of message from inbound to outbound. Given event id or message keyword, search related records in component logs and thread events.

```bash
theclaw-trace.sh --message-id <uuid>
theclaw-trace.sh --keyword <text> [--since <time>]
```

### `theclaw-health.sh`

Health check script for maintainer agent periodic calls.

```bash
theclaw-health.sh [--json]
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `THECLAW_HOME` | Data root directory | `~/.theclaw` |
| `THECLAW_CONFIG` | theclaw config file path | `~/.config/theclaw/config.json` |

TheClaw doesn't introduce new global environment variables for other components—each component's env vars defined in their own SPEC.

---

## Technology Stack

Consistent with other components:

- TypeScript + ESM (Node 22+)
- Build: tsup
- CLI parsing: commander
- YAML parsing: js-yaml (profile and components.yaml)
- Testing: vitest (only for profile-loader, component-manager own logic)

TheClaw doesn't need SQLite, better-sqlite3 or heavy dependencies. It's a lightweight orchestration layer.

---

## Immutable Principles

Following principles maintained in v2:

1. **LLM tool interface all CLI**: `cmds`, `xdb`, `xweb`, `pai`, `thread` (management), `agent` (management), `notifier` (scheduling) all remain CLI form, LLM calls via single `bash_exec` tool
2. **Agent as directory**: Each agent's data in `~/.theclaw/agents/<id>/`, filesystem is ground truth
3. **Thread first-class citizen**: Event stream, persistent memory, observability foundation unchanged
4. **Observability first**: All thread data human-readable (SQLite + JSONL), not black box despite runtime consolidation

---

## Implementation Status (2026-03-26 Verified)

| Component | Planned | Status | Code | Tests | Docs |
|-----------|---------|--------|------|-------|------|
| pai | CLI/LIB dual | ✅ Complete | ✅ | ✅ 32 files passed | ✅ |
| thread | CLI/LIB dual | ✅ Complete | ✅ | ✅ 20 files, 211 tests | ✅ |
| xar | New daemon | ✅ Complete | ✅ | ✅ 26 files, 115 tests | ✅ |
| xgw | IPC upgrade | ✅ Complete | ✅ | ✅ 22 files, 209 tests | ✅ |
| notifier | Keep current | ✅ Unchanged | — | — | ✅ |
| cmds | Keep current | ✅ Unchanged | — | — | ✅ |
| xdb | Keep current | ✅ Unchanged | — | — | ✅ |
| xweb | Keep current | ✅ Unchanged | — | — | ✅ |
| agent (old) | Archive | ✅ Deprecated | — | — | ✅ |

---

## See Also

- [CLI-LIB-Module-Spec.md](./CLI-LIB-Module-Spec.md) — Dual interface module specification (cross-repo design pattern)
- [BootstrapDesign.md](./arch/BootstrapDesign.md) — Detailed setup flow and idempotency rules
- [TheClawArchitecture.md](./arch/TheClawArchitecture.md) — Historical architecture reference
