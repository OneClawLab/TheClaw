# TheClaw Architecture v2

## 背景与动机

当前架构（v1）的核心问题是：**消息流转路径太长，且每一跳都是进程边界**。

```
xgw → thread push(CLI) → notifier dispatch(文件轮询) → agent run(CLI) → pai chat(CLI) → thread push(CLI) → outbound consumer → agent deliver(CLI) → xgw send(CLI)
```

每个箭头都是一次 CLI 进程调用，带来以下问题：

1. **Streaming 不可能**：即使 `pai chat --stream` 能流式输出，这个流也只能在 `agent run` 进程内部消费，无法透传到 TUI client。消息投递是异步批处理的，不是实时的。
2. **进程开销累积**：一条消息的完整处理链路涉及 6-8 次进程启动。
3. **调度延迟**：notifier 基于文件系统轮询，天然有延迟，不适合实时交互场景。
4. **错误传播困难**：跨进程的错误处理依赖退出码和文件，难以做细粒度的重试和恢复。

---

## v2 架构概览

### 核心思路

将"通过文件系统解耦的进程编排"升级为"通过内存/IPC 解耦的服务编排"，同时**保持 CLI 作为 LLM 工具接口的原则不变**。

### 组件分层

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

## 各组件改造方向

### xar — 全新实现（agent runtime daemon）

**定位**：从头实现的 agent runtime daemon，不从旧 `agent` repo 重构。旧 `agent` repo 作为参考文档保留，待 xar 稳定后归档废弃。

**职责**：
- 内存事件循环（替代 notifier 文件轮询驱动的调度）
- Thread 事件存储（通过 `thread` lib 直接操作 SQLite，不通过 CLI）
- Agent run-loop（异步并发，不同 agent 并发，同一 agent 串行）
- LLM 调用（通过 `pai` lib，不通过 CLI）
- Cron 调度（内置，仅用于 agent 内部定时任务，如 memory 压缩、定期自省）
- IPC Server（供 xgw 和管理 CLI 连接）

**对外接口**：
- IPC Server（xgw 通过此接口收发消息）
- 管理 CLI（`agent` 命令，用于 init/start/stop/status/list，供人类和 LLM 调用）

**Streaming 支持**：
- xar 持有 LLM streaming 的 write handle
- 通过 IPC 将 token 实时 push 到 xgw
- xgw 再通过 WebSocket 推送到 client

**命名说明**：
- 开发期间 repo 命名为 `xar`（x + agent runtime）
- 稳定后对外 CLI 命令重命名为 `agent`，废弃旧的 `agent` repo

---

### xgw — 保持独立 daemon，升级为 IPC 通信

**改造内容**：
- 入站：channel plugin 收到消息后，通过 IPC 发给 xar（不再调用 `thread push` CLI）
- 出站：xar 通过 IPC 主动 push 回复给 xgw，xgw 转发给 channel（不再等待 `agent deliver` CLI 调用）
- IPC 协议需要支持 streaming（xar → xgw 的 token 流）

**消息路径**：
```
入站: client → xgw(ws/webhook) → xar(IPC)
出站: xar(IPC) → xgw(ws/webhook) → client
```

**保持不变**：
- Channel plugin 模型（telegram, slack, tui, webchat 等）
- 所有管理 CLI（`xgw status/reload/route/channel/agent`）
- `xgw send` CLI 降级为诊断/测试工具，不再是 agent 出站的必经路径

---

### pai — 改造为 CLI/LIB 双接口模块

见 [CLI-LIB-Module-Spec.md](./CLI-LIB-Module-Spec.md)。

**改造内容**：
- 核心逻辑（provider 抽象、session 管理、streaming）提取到 `src/lib/`
- `src/index.ts` 作为 ESM lib 入口，export 所有公开接口
- `src/cli.ts` 作为 CLI 入口，保持现有 `pai chat` / `pai model` 命令不变
- streaming 接口改为返回 `AsyncIterable<string>`，不直接写 stdout

**xar 使用方式**：import pai lib，直接调用，streaming token 通过 IPC 转发给 xgw。

**给 LLM 的价值**：`pai chat` CLI 不变，LLM 可继续通过它发起独立 LLM 调用。

---

### thread — 改造为 CLI/LIB 双接口模块

见 [CLI-LIB-Module-Spec.md](./CLI-LIB-Module-Spec.md)。

**改造内容**：
- 核心存储逻辑提取到 `src/lib/`，CLI 作为薄包装
- lib 接口由 xar 的实际需求驱动定义，不是现有 CLI 的原样 lib 化
  - 现有 CLI 中为配合 notifier 文件轮询设计的部分（如 `push` 触发 `notifier task add`）在 lib 层不保留
  - lib 接口和 CLI 接口保持完全对等（便于测试）
- CLI 定位为管理和诊断工具，不作为 LLM 的主要工具推广

**xar 使用方式**：import thread lib，直接操作 SQLite，不通过 CLI。

**给 LLM 的价值**：thread CLI 保留，供高级用户和调试场景使用。

---

### notifier — 保持现状，独立演进

**不做改造**：notifier 逻辑简单，xar 无需依赖它，xar 自己实现所需的调度逻辑。

**定位**：作为独立的通用任务调度工具，适合非 agent 场景（任何需要简单 cron 或即时任务调度的场景）。

**给 LLM 的价值**：`notifier task add` / `notifier timer add` 是有效的 LLM 工具，LLM 可通过它调度任意 shell 命令。

---

### cmds — 保持现状，独立演进

**不做改造**：cmds 是 LLM 的能力发现入口，越稳定越好。

**定位**：LLM 工具层的核心组件，通过 `bash_exec` 调用，帮助 LLM 渐进发现系统能力。

---

### xdb — 保持现状，可选改造

**当前**：纯 CLI，保持不变。

**可选未来**：改造为 CLI/LIB 双接口模块，届时 cmds 可选择依赖其 lib 接口（但增量价值有限，不优先）。

---

### xweb — 保持现状，独立演进

**不做改造**：xweb 是 LLM 访问互联网的基础工具，作为稳定封装单元独立迭代。

**定位**：与未来的 `browser` 命令（处理 JS 动态渲染）共同构成 LLM 访问互联网的两个基本命令：
- `xweb`：静态内容（fetch/search/explore）
- `browser`（待实现）：动态渲染（JS 执行）

---

### agent（旧 repo）— 功能被 xar 吸收，已废弃归档

**不做重构**：旧 `agent` repo 的设计假设（notifier 驱动、文件锁串行）与 xar 差异太大，重构比重写更痛苦。

**处理方式**：已归档废弃（README 标注 DEPRECATED），保留作为设计参考文档。旧 `agent` CLI 的所有命令（init/start/stop/status/list/chat/send）已由 xar 的管理 CLI 完全接替。`agent run` 和 `agent deliver` 已内化为 xar daemon 的 run-loop 和 IPC 投递。

---

## Streaming 完整路径（v2）

```
用户输入
  → xgw-tui (WebSocket)
  → xgw TUI plugin
  → xgw IPC → xar (内存队列)
  → agent run-loop
  → pai lib (streaming LLM call)
  → streaming tokens → xar IPC → xgw
  → xgw TUI plugin (WebSocket push)
  → xgw-tui 终端实时显示
```

每一跳都在进程内或通过 streaming-capable IPC，没有批处理边界。

---

## xar IPC 协议（草案）

xar 对外暴露一个 IPC Server，支持以下操作：

### 连接方式

优先 Unix socket（`~/.theclaw/xar.sock`），fallback local HTTP+WebSocket（`127.0.0.1:18792`）。

### 消息类型

**入站（xgw → xar）**：
```json
{ "type": "inbound_message", "agent_id": "admin", "message": { ...Message } }
```

**出站 streaming（xar → xgw）**：
```json
{ "type": "stream_start", "reply_context": { "channel_id": "...", "peer_id": "...", "session_id": "..." } }
{ "type": "stream_token", "token": "Hello" }
{ "type": "stream_token", "token": " world" }
{ "type": "stream_end" }
```

**管理操作（CLI → xar）**：
```json
{ "type": "agent_init", "agent_id": "admin", "kind": "system" }
{ "type": "agent_start", "agent_id": "admin" }
{ "type": "agent_stop", "agent_id": "admin" }
{ "type": "agent_status", "agent_id": "admin" }
{ "type": "task_add", "author": "...", "task_id": "...", "command": "..." }
{ "type": "timer_add", "author": "...", "task_id": "...", "timer": "0 2 * * *", "command": "..." }
```

---

## xar 内部架构

xar 是**纯 CLI/Daemon 模块**，不是 CLI/LIB 双接口模块——没有 lib 入口，不会被其他模块 import。外部通过 IPC 和 CLI 与它交互。

**命名**：开发期间 CLI 命令名为 `xar`，稳定后重命名为 `agent`（届时废弃旧 `agent` repo）。

**依赖**：`thread`（lib）和 `pai`（lib）作为 npm dependencies import，不内嵌代码。

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

### CLI 命令结构

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

### 核心运行机制

#### 1. 消息队列模型

每个 agent 拥有独立的内存消息队列（`AsyncQueue<Message>`）。IPC server 收到入站消息后按 `agent_id` push 到对应队列，run-loop 通过 `for await` 持续消费。天然实现"不同 agent 并发，同一 agent 串行"。

```
IPC server
  → 按 agent_id 分发
  → agent-admin 队列: [msg1, msg2, ...]
  → agent-warden 队列: [msg3, ...]

run-loop(admin)  ←── for await ──── agent-admin 队列
run-loop(warden) ←── for await ──── agent-warden 队列
```

#### 2. run-loop 生命周期

run-loop 随 daemon 启动后**持续运行**，空队列时 await 等待新消息，不退出。这是 streaming 场景的必要条件——LLM 调用期间需要保持 IPC 连接持续 push token。

```
xar daemon start
  → 启动 IPC Server（WebSocket over Unix socket）
  → 加载所有已注册 agent 配置
  → 为每个 started agent 启动 async run-loop（持续运行）
  → 启动内置 cron scheduler

run-loop（per-agent，持续）:
  for await (const msg of agentQueue) {
    → router.ts：路由到目标 thread（通过 thread lib）
    → context.ts：组装 LLM context（读 memory + 读 thread 历史）
    → pai lib：发起 streaming LLM 调用（含 tool call 处理）
    → streaming tokens → deliver.ts → IPC → xgw
    → 写回复事件到 thread（通过 thread lib）
    → 抛出 session lifecycle 事件（供 memory 后台处理消费）
  }
```

#### 3. tool call 执行

tool call（`bash_exec`）由 **pai lib 内部处理**，xar 不拦截。xar 只需在调用 pai lib 时传入允许的工具配置，具体执行逻辑保持在 pai 内部，便于独立迭代。

#### 4. Memory 管理机制

Memory 分两个层次，处理方式不同：

**Session 级 compact（同步路径）**：
- 每次 LLM 调用前，context.ts 检查当前 session 的 token 估算
- 超过阈值时，在本次调用前先做 session 内的 compact（与 v1 agent 逻辑一致）
- 结果写入 `sessions/<thread_id>.jsonl`

**跨 session Memory（异步路径）**：
- run-loop 在处理完每条消息后，抛出 session lifecycle 事件（如 `session_turn_completed`、`session_ended` 等）
- 后台 memory processor（独立 async 任务，由 cron scheduler 或事件触发）消费这些事件
- 根据事件内容决定是否更新 per-peer memory（`memory/user-<peer_id>.md`）或 per-agent memory（`memory/agent.md`）
- run-loop 本身不等待 memory 更新完成，异步解耦

```
run-loop → emit(session_turn_completed, { thread_id, peer_id, ... })
                          ↓ 异步
              memory processor
                → 读取相关 thread 历史
                → 调用 pai lib 做摘要/压缩
                → 写入 memory/user-<peer_id>.md 或 memory/agent.md
```

#### 5. Session 文件与轻量 sub-agent

`pai chat --session <file>` 维护的 session 文件机制**完整保留**。这使得 `pai chat` 本身就能作为有历史记忆的多轮对话工具，特别适合：
- 临时性 sub-agent（不需要完整 xar agent 生命周期）
- 人类直接与 LLM 交互的轻量场景
- agent 内部发起的一次性子任务对话

xar 的 agent run-loop 使用 pai lib 时，session 文件路径由 xar 管理（`sessions/<thread_id>.jsonl`），与 `pai chat --session` 的文件格式完全兼容。

---

## 待讨论事项

### D1. xar 与 xgw 的 IPC 协议选型 ✅ 已确定

**结论**：WebSocket 协议，底层默认 Unix socket，配置保留 TCP loopback fallback。

两种底层对上层完全透明，切换只需改地址：

```typescript
// server（xar）
new WebSocketServer({ path: '~/.theclaw/xar.sock' })   // Unix socket（默认）
new WebSocketServer({ port: 18792 })                    // TCP loopback（fallback）

// client（xgw）
new WebSocket('ws+unix://~/.theclaw/xar.sock')          // Unix socket（默认）
new WebSocket('ws://127.0.0.1:18792')                   // TCP loopback（fallback）
```

上层 `ws.send()` / `ws.on('message')` 代码完全不变。实现时封装 `createIpcServer(config)` / `createIpcClient(config)`，上层感知不到底层差异。

xar 和 xgw 始终在同一台机器上，Unix socket 是正确的默认选择（无端口占用，无网络栈开销）。

---

### D2. pai lib 化时机 ✅ 已确定

**结论**：pai 改造为 CLI/LIB 双接口模块（见 [CLI-LIB-Module-Spec.md](./CLI-LIB-Module-Spec.md)），xar 使用其 lib 接口。lib 化与 xar 开发同步进行。

---

### D3. thread CLI 的定位 ✅ 已确定

**结论**：thread 改造为 CLI/LIB 双接口模块。CLI 保留完整功能，定位为管理和诊断工具。lib 接口由 xar 需求驱动定义，CLI 与 lib 完全对等（便于测试）。现有为配合 notifier 文件轮询设计的部分在 lib 层不保留。

---

### D4. notifier 的定位 ✅ 已确定

**结论**：notifier 保持现状，作为独立的通用任务调度工具独立演进，不依赖 xar。xar 自己实现所需的调度逻辑，不依赖 notifier。

---

### D5. agent 并发模型 ✅ 已确定

**结论**：不同 agent 并发，同一 agent 串行（Agent 级并发）。串行是安全的默认值，后续可按需升级为消息级并发。

---

### D6. xar cron 与 notifier cron 的职责分离 ✅ 已确定

**结论**：xar 内置 cron 仅用于 agent 内部定时任务（memory 压缩、定期自省等）。notifier cron 用于外部通用任务调度。两者职责不重叠。

---

### D7. 迁移策略 ✅ 已确定

**结论**：xar 从头重写，不从旧 agent repo 重构。开发顺序：
1. thread 改造为 CLI/LIB 双接口模块（lib 接口由 xar 需求驱动）
2. pai 改造为 CLI/LIB 双接口模块
3. xar 实现核心（event loop + thread lib + pai lib + agent run-loop）
4. xgw 升级 IPC 通信（替代现有 CLI 调用）

---

## 实施状态（2026-03-26 验证）

### 总览

| 组件 | 计划改造 | 状态 | 代码 | 测试 | 文档 |
|------|---------|------|------|------|------|
| pai | CLI/LIB 双接口 | ✅ 完成 | ✅ | ✅ 32 files passed | ✅ SPECv2.md |
| thread | CLI/LIB 双接口 | ✅ 完成 | ✅ | ✅ 20 files, 211 tests passed | ✅ SPECv2.md |
| xar | 全新 daemon | ✅ 完成 | ✅ | ✅ 26 files, 115 tests passed | ✅ SPECv2.md |
| xgw | IPC 通信升级 | ✅ 完成 | ✅ | ✅ 22 files, 209 tests passed | ✅ SPECv2.md |
| notifier | 保持现状 | ✅ 不变 | — | — | SPEC.md |
| cmds | 保持现状 | ✅ 不变 | — | — | SPEC.md |
| xdb | 保持现状 | ✅ 不变 | — | — | SPEC.md |
| xweb | 保持现状 | ✅ 不变 | — | — | SPEC.md |
| agent（旧） | 保留参考 | ✅ 已废弃归档 | — | — | SPEC.md |

### pai — CLI/LIB 双接口 ✅

- `src/lib/`：`chat.ts`、`config.ts`、`llm-client.ts`、`model-resolver.ts`、`embedding-client.ts`、`types.ts`
- `src/index.ts`：纯 LIB 入口（export only，无副作用）
- `src/cli.ts`：CLI 入口（EPIPE、exitOverride、错误码）
- `tsup.config.ts`：双 entry 构建（index.ts 无 shebang + cli.ts 带 shebang）
- `package.json`：`exports`/`main`/`types`/`bin` 均正确配置，version 2.0.0
- 测试：unit 19 files + pbt 12 files + integration 1 file，全部通过
- 详见 [pai/SPECv2.md](../pai/SPECv2.md)

### thread — CLI/LIB 双接口 ✅

- `src/lib/`：`thread-lib.ts`（ThreadLib）、`thread-store.ts`（ThreadStore）、`db.ts`、`event-log.ts`、`types.ts`
- `src/index.ts`：纯 LIB 入口（export ThreadLib、ThreadStore、ThreadEvent 等）
- `src/cli.ts`：CLI 入口
- `tsup.config.ts`：双 entry 构建
- `package.json`：`exports`/`main`/`types`/`bin` 均正确配置，version 2.0.0
- 测试：unit 12 files + pbt 7 files + integration 1 file，20 files 211 tests 全部通过
- 详见 [thread/SPECv2.md](../thread/SPECv2.md)

### xar — Agent Runtime Daemon ✅

- `src/daemon/`：`index.ts`（daemon 主入口）、`ipc-chunk-writer.ts`（Writable→IPC）、`pid.ts`
- `src/agent/`：`run-loop.ts`、`router.ts`、`context.ts`、`deliver.ts`、`memory.ts`、`session.ts`、`queue.ts`、`thread-lib.ts`、`config.ts`、`types.ts`
- `src/ipc/`：`server.ts`（createIpcServer）、`client.ts`（IpcClient）、`types.ts`
- `src/commands/`：`daemon.ts`、`init.ts`、`start.ts`、`stop.ts`、`status.ts`、`list.ts`、`chat.ts`、`send.ts`
- `package.json`：dependencies 包含 `pai`（file:../pai）和 `thread`（file:../thread）
- 测试：unit 6 files + pbt 18 files + integration 1 file + e2e 1 file
  - ⚠️ `memory-compressor.test.ts`：引用 `src/agent/memory-compressor.js` 不存在（文件已重命名为 `memory.ts`，测试未同步）
  - ⚠️ `retry-exponential-backoff.pbt.test.ts`：1 个 PBT 属性失败（`attemptNumber:0, jitterFactor:NaN` 边界未处理）
- 详见 [xar/SPECv2.md](../xar/SPECv2.md)

### xgw — IPC 通信升级 ✅

- `src/xar/client.ts`：XarClient 完整实现（Unix socket 优先 + TCP fallback、自动重连指数退避、断线缓冲 100 条、FIFO 重放）
- `src/xar/dispatcher.ts`：Dispatcher 完整实现（stream_start/token/end/error 路由、TUI 逐 token 发送、非 TUI 累积后发送）
- `src/xar/types.ts`：XarConfig、ReplyContext、InboundMessage、XarOutboundEvent、InboundEnvelope、SessionState
- `src/gateway/server.ts`、`src/config.ts`：已存在，待集成 XarClient（GatewayServer 构造函数改造）
- 测试：unit 9 files + pbt 13 files，20 files 197 tests 通过
  - ⚠️ `xar-client.test.ts`：3 个 WebSocket 时序相关测试 timeout（reconnect FIFO、outbound handler、invalid JSON），需增加 testTimeout 或修复异步等待逻辑
- 详见 [xgw/SPECv2.md](../xgw/SPECv2.md)

### 遗留问题

1. ~~**xar 测试修复**~~ ✅ 已修复：`memory-compressor.test.ts` 重写为测试 `memory.ts` + `session.ts` 实际 API；`memory-compression.pbt.test.ts` 重写；`retry-exponential-backoff` PBT 修复 NaN 边界（`attemptNumber` min 改为 1，增加 `noDefaultInfinity` + `isFinite` guard）
2. ~~**xgw xar-client 测试修复**~~ ✅ 已修复：3 个 WebSocket 时序测试重写，使用 `waitForConnection()` helper 在 `connect()` 前注册 listener 避免竞态，增加 `closeWsServer` 中 terminate 所有 client
3. ~~**xgw GatewayServer 集成**~~ ✅ 已完成（验证时发现已实现）：`server.ts` 已接受 `XarClient` 注入，`handleInbound` 已走 IPC，v1 `InboxWriter` 作为 fallback 保留
4. **端到端集成测试**：xgw → xar → pai/thread 完整消息流尚未端到端验证

---

## 不变的原则

以下原则在 v2 中继续坚守：

1. **LLM 工具接口全部是 CLI**：`cmds`、`xdb`、`xweb`、`pai`、`thread`（管理）、`agent`（管理）、`notifier`（任务调度）均保持 CLI 形式，LLM 通过唯一的 `bash_exec` tool 调用。
2. **Agent 即目录**：每个 agent 的数据仍然存放在 `~/.theclaw/agents/<id>/` 目录下，文件系统是 ground truth。
3. **Thread 是 first-class citizen**：事件流、持久化记忆、可观测性的基础不变。
4. **可观测性优先**：所有 thread 数据仍然是人类可读的（SQLite + JSONL），不因 runtime 合并而变成黑盒。
