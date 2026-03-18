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

## Low-level Concepts

Actors communicating through events (with artifacts) inside persistent threads.

### Actor

Actor has identity and address. Actor can send/receive events to/from threads, execute tool calls and produce artifacts.

- Agent: autonomous proactive intelligent machine.
- Human: real people — Owner (manages agent lifecycle) or Peer (receives agent service).

### Thread

Threads are persistent semantic conversations for events and artifacts. Thread = directory (path = thread ID), initialized via `thread init <path>`.

Events in a thread are append-only and never modified or deleted. Context selection (which events to feed into LLM) is the responsibility of each agent's runtime logic, not the thread layer.

```
<thread-dir>/
├── events.db                        # SQLite（WAL 模式）
├── events.jsonl                     # 只追加事件日志，供调试浏览
├── events-<YYYYMMDD-HHmmss>.jsonl   # 轮换后的历史日志
├── run/                             # Consumer 运行时 .lock 文件
└── logs/
```

### Event

Event is the unit of communication between Actors inside Thread.

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 自增主键 (SQLite) |
| `created_at` | TEXT | ISO 8601 |
| `source` | TEXT | 事件来源标识 |
| `type` | TEXT | `message` \| `record` |
| `subtype` | TEXT? | `toolcall` \| `decision` \| ... |
| `content` | TEXT | 事件内容 |

`message` 触发 agent 处理 (LLM 调用)；`record` 仅记录上下文 (如群聊未 mention 的消息)。

### Artifact

Actor 执行 toolcall 时产生的构建物(文件)。被 event 引用，属于相应的 Thread。

---

## High-level Design

### Agents

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

### Threads

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

## Gateway & Routing

```
peer → channel → xgw → agent.inbox (thread) → agent → thread → agent deliver → xgw send → channel → peer
```

**Gateway 职责**:
1. 身份确认 (peer / channel / session identity)
2. 渠道统一 (不同 IM 渠道 → 统一 Message 结构)
3. 入站路由 ((peer, channel) → agent)

**原则**:
- gateway 只处理跨系统通信，系统内部通信不经过 gateway
- thread 是内部通信的主要媒介，agent inbox 只是一个特殊 thread
- gateway 不负责语义路由（thread 选择由 agent 决定）

### 统一 Message 结构

xgw 将各渠道的原始消息归一化为统一 Message。字段分为两类:

**一级属性** — agent/thread 需要理解其语义，用于路由和处理决策:

| 字段 | 说明 |
|------|------|
| `peer_id` | 发送者标识 |
| `session_type` | 会话类型: `dm` \| `group` \| `channel` |
| `session_id` | 会话标识 (单聊=peer_id, 群聊=群组ID, 频道=频道ID) |
| `type` | 消息类型 (写入 thread 时映射为 event type: `message` 或 `record`) |
| `text` | 消息文本 |
| `attachments` | 附件列表 |
| `reply_to` | 被回复的消息 ID |

**附加属性** — agent/thread 透传但不解释，由 xgw 出站时使用:

| 字段 | 说明 |
|------|------|
| `id` | 渠道侧消息 ID |
| `channel_id` | 渠道实例标识 |
| `peer_name` | 发送者显示名 |
| `sub_thread_id` | 渠道侧子会话 ID (Slack thread / Telegram topic 等) |
| `was_mentioned` | 是否被 mention (渠道原生检测结果) |
| `visibility` | 回复可见性 (public/private，渠道侧标注) |
| `created_at` | 渠道侧时间戳 |
| `raw` | 原始渠道消息 (调试用) |

agent 路由时使用一级属性决定目标 thread；附加属性作为 event content 的一部分写入 thread，在出站时由 `xgw send` 提取使用。

### 两层路由

**xgw 层**: `(channel_id, peer_id) → agent_id` — 由 xgw 配置驱动，决定消息投递到哪个 agent 的 inbox。

**agent 层**: `inbox event → target thread` — agent 根据一级属性 (`session_type`, `session_id`, `peer_id`) 和自身 routing 配置决定目标 thread。

```yaml
# agent config.yaml
routing:
  dm: per-peer           # 单聊 → 每个 (channel, peer) 独立 thread
  group: per-session     # 群聊 → 每个群组一个 thread
  channel: per-session   # 频道 → 每个频道一个 thread
```

| 模式 | 说明 | Thread 路径 |
|------|------|-------------|
| `per-peer` | 每个 (channel_id, peer_id) 独立 thread | `threads/peers/<channel_id>-<peer_id>/` |
| `per-session` | 每个 (channel_id, session_id) 独立 thread | `threads/sessions/<channel_id>-<session_id>/` |
| `per-agent` | 所有消息共享一个 thread | `threads/main/` |

DM 默认 `per-peer`，天然隔离多用户上下文。

具体各渠道 (Telegram/Slack/Discord 等) 的映射场景详见 [ThreadMapping.md](ThreadMapping.md)。

---

## 组件详细设计

### 1. pai — LLM 交互层

Unix 风格 CLI，调用 LLM、管理 provider 配置、维护会话历史。

- 支持 20+ providers (OpenAI, Anthropic, Google, GitHub Copilot, Azure, Bedrock, etc.)
- 多种认证: API Key, OAuth, Azure, AWS Bedrock, Google Vertex
- Session 文件 (JSONL) 支持多轮对话，内置 `bash_exec` 工具
- 人类可读 (默认) 和机器可解析 (`--json`) 双模式

主要命令: `pai chat`, `pai embed`, `pai model list/config/default/login`

配置: `~/.config/pai/default.json`。底层基于 @mariozechner/pi-ai。

---

### 2. cmds — 命令发现层

系统命令发现工具，连接用户意图与可执行命令。

- 自然语言搜索 (语义搜索 via xdb + 模糊匹配 fallback)
- 基于 tldr-pages 的命令详情，分类浏览

主要命令: `cmds find <query>`, `cmds info <command>`, `cmds list`, `cmds scan`

数据: 静态 `dist/data/tldr-index.json` + 运行时 `~/.config/cmds/index.json`

---

### 3. xdb — 数据中心层

意图驱动的数据中心 CLI，内部透明整合 LanceDB (向量) 与 SQLite (关系/FTS)。

- Policy 驱动的集合管理，内置 embedding 能力
- JSONL 输入输出，Upsert 语义

主要命令: `xdb put`, `xdb find` (`--similar`/`--match`/`--where`), `xdb embed`, `xdb col init/list/info/rm`

预设 Policy: `hybrid/knowledge-base`, `relational/structured-logs`, `relational/simple-kv`, `vector/feature-store`

存储: `~/.local/share/xdb/collections/<name>/`

---

### 4. xweb — 互联网访问层

为 AI Agent 设计的互联网出口，将网页内容转换为 LLM 友好的数据流。

- 多 provider 搜索 (Brave, Tavily, Serper, 内置 fallback)
- 网页抓取并清洗为 Markdown/text/HTML/JSON
- 站点结构发现 (sitemap/链接提取)

主要命令: `xweb search <query>`, `xweb fetch <url>`, `xweb explore <url>`

配置: `~/.config/xweb/default.json`

---

### 5. notifier — 任务调度层

文件驱动的任务调度 daemon，支持即时任务和 CRON 定时任务。

- 即时任务: 文件投递到 `tasks/pending/` → daemon 执行 → 移动到 `tasks/done/`
- 定时任务: CRON 表达式调度
- 信号处理: SIGTERM/SIGINT 优雅退出

主要命令: `notifier task add/list/remove`, `notifier timer add/list/remove`, `notifier --daemon`, `notifier status`

数据目录: `~/.local/share/notifier/`

在系统中的角色: thread push 后通过 notifier 触发 dispatch，dispatch 再 spawn consumer handler。

---

### 6. thread — 事件队列层

基于 SQLite 的持久化事件队列，支持 consumer 订阅和异步 dispatch。

- Thread 即目录 (path = ID)，双轨存储: SQLite + JSONL
- Consumer 订阅: handler 命令 + 可选 SQL filter
- Push 自动触发 notifier dispatch，Pop 支持 at-least-once 消费语义
- 文件锁保证 consumer 不并发运行
- Events 只追加不修改，永久保留原始数据

主要命令: `thread init/push/pop/subscribe/unsubscribe/info/dispatch`

调度流程:
```
thread push → notifier task add → notifier daemon → thread dispatch
  → 遍历 subscriptions → 加文件锁 → spawn handler_cmd
  → handler 内部调用 thread pop 消费事件
```

---

### 7. agent — Agent 运行时 (设计中)

Agent 生命周期管理和核心运行循环。

- Agent 即目录 (`~/.theclaw/agents/<agent_id>/`)
- Inbox 是特殊 thread，xgw 写入，agent 消费
- 运行循环由 notifier 驱动 (非常驻进程，每次处理一个批次后退出)
- `agent run` 承担两个角色:
  1. inbox consumer: pop 事件 → 路由到目标 thread
  2. inbound handler: 调用 `pai chat` 处理消息 → 回复 push 回 thread
- 出站: outbound consumer → `agent deliver` → `xgw send`

主要命令: `agent init/start/stop/run/deliver/status/list`

运行循环:
```
xgw → thread push → agent.inbox → notifier dispatch → agent run <id>

  ── inbox consumer (路由) ──
  → thread pop (inbox)
  → 根据一级属性 (session_type, session_id, peer_id) + routing 配置 → 目标 thread
  → thread push (写入目标 thread)

  ── inbound handler (处理) ──
  → pai chat (上下文选择由 agent 运行时决定)
  → thread push (回复 + toolcall 记录)
  → outbound consumer → agent deliver → xgw send → peer
```

---

### 8. xgw — 通信网关 (设计中)

Agent 与外部 peer 的通信网关。

- Channel 插件化: Telegram, Slack, Discord 等各为独立 plugin
- 入站: 渠道消息归一化 → 路由到 agent inbox (`thread push`)
- 出站: `xgw send` CLI 接口供 `agent deliver` 调用
- Daemon 模式常驻运行，自管理 PID 文件

主要命令: `xgw start/stop/status`, `xgw send`, `xgw config check`

入站流程:
```
渠道 webhook/polling → ChannelPlugin.onMessage(raw)
  → normalizer: raw → Message (一级属性 + 附加属性)
  → router: (channel_id, peer_id) → agent_id
  → thread push → agent.inbox
```

配置: `~/.config/xgw/config.yaml`

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