# TheClaw 整体架构设计

TheClaw is an agent runtime with the following design principles:
- Loose-coupled system architecture with composition of CLI commands. Which means:
  - Every system capability is a CLI command.
  - LLM is equipped with only one `bash_exec` tool, with progressive discovery of system capabilities via builtin `cmds` CLI command.
- Event-driven architecture with Thread (stream of events with artifacts) as first-class citizen. This will:
  - Basically support agent to have persistent memory and context.
  - Keep human/agent or agent/agent collaboration consistent and easily manageable.
  - Improve system observability/auditability/recoverability/etc.

## WHY

自治 Agentic 系统需要一个更易于探索和扩展的架构:
- 不依赖的组件可以独自进化，包括不同的实现技术/分发形式。
- 系统的上层核心逻辑可以被人类方便的观察和理解。

Unix CLI 就是这种历久弥坚的沉淀:
- 每个命令都是一个语义稳定的可分发单元。
- 同时系统靠 Shell 组合能实现极其复杂的上层逻辑。

**安全**: 自治 Agentic 系统的安全保障需要智能体介入进行保障维护，不是简单的允许/拒绝某些 tool 调用就可以满足的。

**进化**: 自治 Agentic 系统的进化也需要智能体介入协调，但系统在结构上需要对人类保持可观察性和可控制性。

---

## 核心概念速览

Actors communicating through events (with artifacts) inside persistent threads.

- **Actor**: 有身份和地址的参与者。分为 Agent（自治智能体）和 Human（Owner 或 Peer）。
- **Thread**: 持久化的事件流容器。Thread = 目录（路径 = ID），事件只追加不修改。
- **Event**: Actor 之间通信的基本单元。存储层分为 `message`（触发处理）和 `record`（仅记录上下文）；语义层分为 message / command / artifact / decision。
- **Artifact**: Actor 执行 toolcall 时产生的构建物（文件），被 event 引用，属于相应的 Thread。

详见 [ConceptModel.md](ConceptModel.md)。

---

## 系统组件总览

TheClaw 由以下独立 CLI 命令组成，每个命令是一个独立的 npm 包/repo:

| 组件 | 命令 | 定位 | 状态 |
|------|------|------|------|
| **pai** | `pai` | LLM 交互层 | ✅ 已完成 |
| **cmds** | `cmds` | 命令发现层 | ✅ 已完成 |
| **xdb** | `xdb` | 数据中心层 | ✅ 已完成 |
| **xweb** | `xweb` | 互联网访问层 | ✅ 已完成 |
| **notifier** | `notifier` | 任务调度层 | ✅ 已完成 |
| **thread** | `thread` | 事件队列层 | ✅ 已完成 |
| **agent** | `agent` | Agent 运行时 | 🔧 设计中 |
| **xgw** | `xgw` | 通信网关层 | 🔧 设计中 |

统一技术栈: TypeScript + ESM, Node 22+, tsup 构建, vitest 测试, commander CLI 解析。

---

## 端到端数据流

```
peer → channel → xgw → agent.inbox (thread) → agent → thread → agent deliver → xgw send → channel → peer
```

详细流程:

```
                        ┌─ 入站 ─────────────────────────────────────────────────┐
                        │                                                         │
渠道 webhook/polling    │  xgw                        agent                       │
  → ChannelPlugin       │    normalize → route      inbox consumer (路由)          │
  → raw message         │    → thread push ──────→  thread pop (inbox)            │
                        │       (agent.inbox)        → 根据 session_type/peer_id  │
                        │                              + routing 配置             │
                        │                            → thread push (目标 thread)  │
                        └─────────────────────────────────────────────────────────┘

                        ┌─ 处理 ──────────────────────────────────────────────────┐
                        │                                                         │
                        │  inbound handler                                        │
                        │    thread pop (目标 thread)                              │
                        │    → pai chat (context = memory + recent messages)       │
                        │    → thread push (回复 + toolcall 记录)                  │
                        └─────────────────────────────────────────────────────────┘

                        ┌─ 出站 ──────────────────────────────────────────────────┐
                        │                                                         │
                        │  outbound consumer                                      │
                        │    → agent deliver                                      │
                        │    → xgw send --session <id> [--peer <id>] [--private]  │
                        │    → channel → peer                                     │
                        └─────────────────────────────────────────────────────────┘
```

调度驱动: 所有 thread push 通过 notifier 触发 dispatch，dispatch spawn consumer handler。

---

## 组件摘要

### pai — LLM 交互层

Unix 风格 CLI，调用 LLM、管理 provider 配置、维护 session 历史。支持 20+ providers，多种认证方式，Session 文件 (JSONL) 支持多轮对话，内置 `bash_exec` 工具。

主要命令: `pai chat`, `pai embed`, `pai model list/config/default/login`

### cmds — 命令发现层

系统命令发现工具，连接用户意图与可执行命令。自然语言搜索 (语义搜索 via xdb + 模糊匹配 fallback)，基于 tldr-pages 的命令详情。

主要命令: `cmds find <query>`, `cmds info <command>`, `cmds list`, `cmds scan`

### xdb — 数据中心层

意图驱动的数据中心 CLI，内部透明整合 LanceDB (向量) 与 SQLite (关系/FTS)。Policy 驱动的集合管理，内置 embedding 能力，JSONL 输入输出。

主要命令: `xdb put`, `xdb find`, `xdb embed`, `xdb col init/list/info/rm`

### xweb — 互联网访问层

为 AI Agent 设计的互联网出口，将网页内容转换为 LLM 友好的数据流。多 provider 搜索，网页抓取并清洗。

主要命令: `xweb search <query>`, `xweb fetch <url>`, `xweb explore <url>`

### notifier — 任务调度层

文件驱动的任务调度 daemon，支持即时任务和 CRON 定时任务。

主要命令: `notifier task add/list/remove`, `notifier timer add/list/remove`, `notifier --daemon`, `notifier status`

### thread — 事件队列层

基于 SQLite 的持久化事件队列，支持 consumer 订阅和异步 dispatch。Thread 即目录，双轨存储 (SQLite + JSONL)，events 只追加不修改。

主要命令: `thread init/push/pop/subscribe/unsubscribe/info/dispatch`

### agent — Agent 运行时 (设计中)

Agent 生命周期管理和核心运行循环。Agent 即目录，inbox 是特殊 thread，运行循环由 notifier 驱动。

主要命令: `agent init/start/stop/run/deliver/status/list`

### xgw — 通信网关 (设计中)

Agent 与外部 peer 的通信网关。Channel 插件化，入站归一化 + 路由，出站 CLI 接口。

主要命令: `xgw start/stop/status`, `xgw send`, `xgw config check`

---

## Session 架构

Agent 的 session 架构分为基座层（单个 session 内的上下文管理）+ 三个正交策略开关（Session Segmentation / Channel Routing / Entity Multiplexing）。任何场景 = 基座层 + S1/S2/S3 的组合选择。

注: Session 是 agent 在某个 Thread 上与 LLM 交互的上下文管理单元，与 xgw Message 中的 `session_id`（渠道侧会话标识）是不同层次的概念。

详见 [AgentSessionDesign.md](AgentSessionDesign.md)。

---

## 网关与路由

xgw 将各渠道消息归一化为统一 Message 结构，通过两层路由（xgw 层决定目标 agent，agent 层决定目标 thread）投递到正确的 Thread。路由模式（per-peer / per-session / per-agent）是 session 策略 S2/S3 的具体实现。

详见 [GatewayRouting.md](GatewayRouting.md)。

---

## Agents

**System Agents**:

| agent_id | 职责 |
|----------|------|
| `admin` | 系统管理员，面向用户，处理日常交互和 agent 管理 |
| `warden` | 安全/审计/合规，监控系统行为 |
| `maintainer` | 升级/维护，处理系统更新 |
| `evolver` | 自我迭代/学习/优化 |

**User Agents**: 由用户通过和 admin 交互创建。默认在 onboarding 时只创建一个。

**Agent 目录设计**:
```
~/.theclaw/agents/<agent_id>/
├── IDENTITY.md               # agent 身份描述
├── config.yaml               # agent 配置
├── inbox/                    # inbox thread 目录
├── sessions/                 # pai chat session 文件（按 thread_id 命名）
├── threads/                  # agent 私有 thread
│   ├── memory/
│   └── tasks/
├── workdir/                  # 临时工作区
└── logs/
```

**Thread 拓扑**:
```
agents/<agent_id>/
  inbox/    → 私有 thread，入站队列
  memory/   → 私有 thread，只能自己读写
  tasks/    → 非共享 thread，仅自己可见
threads/
  tasks/    → 共享 thread，可被多个 agent 订阅
  archive/  → 历史 thread，可回溯
  global/   → 系统 thread，默认订阅者是系统 agent
```

---

## 组件依赖关系

```
                    ┌─────────┐
                    │  xweb   │  互联网访问 (独立)
                    └─────────┘

                    ┌─────────┐
                    │   pai   │  LLM 交互 (独立)
                    └─────────┘

                    ┌─────────┐
                    │   xdb   │  数据中心 (独立，内置 embedding)
                    └────┬────┘
                         │ 语义搜索 (松耦合，可选)
                    ┌────▼────┐
                    │  cmds   │  命令发现 (xdb 不可用时 fallback 模糊匹配)
                    └─────────┘

                    ┌──────────┐
                    │ notifier │  任务调度 (独立)
                    └────┬─────┘
                         │ dispatch 驱动
                    ┌────▼────┐
                    │ thread  │  事件队列 (依赖 notifier)
                    └────┬────┘
                         │ inbox / 事件
              ┌──────────┼──────────┐
              │                     │
         ┌────▼────┐          ┌────▼────┐
         │  agent  │◄────────►│   xgw   │
         └─────────┘          └─────────┘
         依赖: pai, thread,    依赖: thread
               cmds, xgw
```

---

## 统一约定

**退出码**: `0` 成功, `1` 逻辑错误, `2` 参数错误 (pai 额外: `3` API 错误, `4` IO 错误)

**输出模式**: 默认人类可读，`--json` 机器可解析，部分组件 TTY 自动检测

**错误输出**: stderr `Error: <什么错了> - <怎么修>`，`--json` 模式 `{"error": "...", "suggestion": "..."}`

**日志**: 各组件日志超过 10000 行自动轮换，格式 `[ISO8601] [LEVEL] message`

**环境变量**:

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `THECLAW_HOME` | 数据根目录 | `~/.theclaw` |
| `NOTIFIER_HOME` | notifier 数据目录 | `~/.local/share/notifier` |
| `XGW_CONFIG` | xgw 配置文件 | `~/.config/xgw/config.yaml` |
| `XGW_HOME` | xgw 数据目录 | `~/.local/share/xgw` |
| `PAI_CONFIG` | pai 配置文件 | `~/.config/pai/default.json` |
