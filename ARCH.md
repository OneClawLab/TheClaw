# TheClaw 架构设计

本文档定义 TheClaw 系统的完整架构。Vision 和实现状态见 [SPEC.md](SPEC.md)。

## 1. 概述

TheClaw 是一个多 agent 系统，由 8 个独立组件组成，每个组件是一个独立的 npm 包/repo。两个常驻 daemon（xgw 和 xar）通过 IPC 通信，构成系统的运行时核心。其余组件作为 CLI 工具或 library 被调用。

### 组件总览

| 组件 | 命令 | 定位 | 运行形态 |
|------|------|------|---------|
| **pai** | `pai` | LLM 交互层 | CLI/LIB |
| **cmds** | `cmds` | 命令发现层 | CLI |
| **xdb** | `xdb` | 数据中心层 | CLI |
| **xweb** | `xweb` | 互联网访问层 | CLI |
| **notifier** | `notifier` | 任务调度层 | CLI/Daemon |
| **thread** | `thread` | 事件队列层 | CLI/LIB |
| **xar** | `xar` | Agent 运行时 | CLI/Daemon |
| **xgw** | `xgw` | 通信网关层 | CLI/Daemon |

统一技术栈: TypeScript + ESM, Node 22+, tsup 构建, vitest 测试, commander CLI 解析。

运行形态说明:
- CLI: 纯命令行工具，执行完即退出
- CLI/Daemon: 既有管理命令（start/stop/status），也有常驻 daemon 进程
- CLI/LIB: 既是独立 CLI，也作为 library 被其他组件 import

### 组件摘要

**pai — LLM 交互层**: Unix 风格 CLI，调用 LLM、管理 provider 配置、维护 session 历史。支持 20+ providers，多种认证方式，Session 文件 (JSONL) 支持多轮对话，内置 `bash_exec` 工具。同时作为 library 被 xar import，提供 LLM 调用能力。

**cmds — 命令发现层**: 系统命令发现工具，连接用户意图与可执行命令。自然语言搜索 (语义搜索 via xdb + 模糊匹配 fallback)，基于 tldr-pages 的命令详情。

**xdb — 数据集管理层**: 意图驱动的数据集管理命令，内部透明整合 LanceDB (向量) 与 SQLite (关系/FTS)。Policy 驱动的集合管理，内置 embedding 能力，JSONL 输入输出。

**xweb — 互联网访问层**: 为 AI Agent 设计的互联网访问工具，将网页内容转换为 LLM 友好的数据流。多 provider 搜索，网页抓取并清洗，网站结构探索等。

**notifier — 任务调度层**: 文件驱动的任务调度 daemon，支持即时任务和 CRON 定时任务。独立通用工具，xar 不依赖它。

**thread — 事件队列层**: 基于 SQLite 的持久化事件队列。Thread 即目录，双轨存储 (SQLite + JSONL)，events 只追加不修改。同时作为 library 被 xar import，提供 thread 读写能力。

**xar — Agent 运行时**: Agent 生命周期管理和核心处理流程。以 daemon 形式常驻运行，管理多个 agent 的并发执行。消息到达后立即 thread 分配并持久化，不经过内存队列缓冲。并发粒度为 thread：不同 agent 并发，同一 agent 的不同 thread 并发，同一 thread 内串行（通过 thread 级别的 lock 保证）。通过 IPC 接收 xgw 的入站消息，处理后通过 IPC 将 streaming 响应推回 xgw。依赖: pai (LLM 调用), thread (事件存储)。

**xgw — 通信网关**: Agent 与外部 peer 的双向消息桥接器。Channel 插件化，入站归一化 + 网关路由，出站通过 Dispatcher 将 streaming 事件转发到 channel plugin。持有到 xar 的持久 IPC 连接。不 import 任何其他组件，只通过 IPC 与 xar 交互。

### 组件依赖关系

```
                    ┌─────────┐
                    │  xweb   │  互联网访问 (独立)
                    └─────────┘

                    ┌─────────┐
                    │   pai   │  LLM 交互 (独立，也作为 lib)
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
                    └──────────┘

                    ┌──────────┐
                    │  thread  │  事件队列 (独立，也作为 lib)
                    └──────────┘

              ┌─────────────────────────┐
              │                         │
         ┌────▼────┐    IPC (WS)   ┌────▼────┐
         │   xar   │◄────────────►│   xgw   │
         └─────────┘               └─────────┘
         import: pai, thread        独立运行
         CLI: cmds, xweb, xdb,     channel plugins
              notifier
```

xar 和 xgw 是两个独立的 daemon 进程，通过 IPC（WebSocket over Unix socket）通信。xar import pai 和 thread 作为 library；agent 通过 bash_exec 调用 cmds、xweb、xdb、notifier 等 CLI 工具。xgw 不 import 任何其他组件，只通过 IPC 与 xar 交互。

### 端到端数据流

```
入站:  peer → channel plugin → xgw (归一化 + 网关路由) → IPC → xar (thread 分配 → 写入 thread → LLM 调用)
出站:  xar (指定目标地址) → IPC → xgw (查找 channel plugin) → channel plugin → peer
```

入站和出站解耦: agent 收到入站消息后，可以不回复、回复一条、回复多条、延迟回复，或者在没有入站消息的情况下主动发送（如定时任务触发）。xgw 不维护入站与出站之间的对应关系。

---

## 2. 核心概念

### Actor

Actor 是系统中的参与者，有身份（Identity）和地址（Address），可以向 Thread 发送/接收 Event。

- **Agent**: 自治的智能机器。分为 System Agent（系统内置）和 User Agent（用户创建）。
- **Human**: 自然人。分为 Owner（管理 agent 生命周期）和 Peer（接受 agent 服务）。

### Thread

Thread 是持久化的事件流容器，是 Actor 之间异步通信的媒介，也是 xar 的并发处理单元（同一 thread 内串行，不同 thread 间并发）。技术上，Thread = 目录（路径 = Thread ID），通过 `thread init <path>` 初始化。

**核心约束**: Events 只追加，不修改，不删除。

**目录结构**:
```
<thread-dir>/
├── events.db                        # SQLite（WAL 模式）
├── events.jsonl                     # 只追加事件日志，供调试浏览
├── events-<YYYYMMDD-HHmmss>.jsonl   # 轮换后的历史日志
├── run/                             # Consumer 运行时 .lock 文件
└── logs/
```

每个 Thread 内部还包含上下文管理机制（详见 [Thread 上下文管理](#thread-上下文管理)），负责 LLM 调用时的 context 生成和 memory 压缩。

所有 thread 均为 agent 私有，不存在全局共享 thread。

### Event

Event 是 Actor 之间通信的基本单元，存在于 Thread 中。

#### 处理语义（type 字段）

| type | 说明 |
|------|------|
| `message` | 触发 agent 处理（LLM 调用） |
| `record` | 仅记录上下文，不触发处理（如群聊中未 mention 的消息） |

#### 语义分类（subtype 字段）

| subtype | 说明 |
|---------|------|
| `message` | 自然语言传递 |
| `command` | 行动请求 |
| `artifact` | 产出物（代码、文档、计算结果等） |
| `decision` | 路径选择或逻辑转折点 |
| `toolcall` | tool call 及其结果 |
| `usage` | LLM token 用量记录 |
| `error` | 运行时错误记录 |

两个维度正交: `type=message` + `subtype=command` 表示"需要 agent 处理的行动请求"；`type=record` + `subtype=message` 表示"仅作为上下文记录的消息"。subtype 可扩展。

#### Event Schema

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 自增主键 (SQLite) |
| `created_at` | TEXT | ISO 8601 |
| `source` | TEXT | 事件来源标识（结构化地址） |
| `type` | TEXT | `message` \| `record` |
| `subtype` | TEXT? | 语义分类 |
| `content` | TEXT | 事件内容 |

### Source 地址格式

Event 的 `source` 字段使用结构化地址编码，标识事件的来源。

| 前缀 | 格式 | 说明 |
|------|------|------|
| `external` | `external:<channel_id>:<conversation_type>:<conversation_id>:<peer_id>` | 外部渠道消息 |
| `internal` | `internal:<conversation_type>:<conversation_id>:<sender_agent_id>` | agent 间通信 |
| `self` | `self` | agent 自身产生的事件 |

所有段的值统一小写。示例：
- Telegram 单聊 Alice: `external:telegram:main:dm:alice:alice`
- Telegram 群聊 Bob: `external:telegram:main:group:grp-123:bob`
- 子会话: `external:telegram:main:group:grp-123/topic-456:alice`
- Agent 间: `internal:dm:admin-to-warden:admin`

### Thread 上下文管理

Thread 内部的上下文管理机制负责 LLM 调用时的 context 生成和历史压缩。这是所有场景的基础设施。

#### Context 生成

agent 每次调用 LLM 时，并不是把完整的事件流全部传入，而是滚动处理:

1. 维护原始 messages 数组（role = user/assistant/tool），即 agent 事件流的完整记录
2. 维护 memory（markdown 文件），存放从历史中抽取的压缩信息
3. 每次调用 LLM 时，取最新的未被 memory 覆盖的 messages + memory 中的相关片段，拼成 context
4. 最近几轮的完整消息直接保留在 context 中（不从 memory 提取），以保证效果

#### Memory 更新

触发时机:
- context 占 context-window 比例超过阈值（如 80%）
- 定期更新（如每 5 轮）
- 用户明确要求
- thread 闲置一段时间无活动时

Memory 内容: 当前 goal、用户 preference & facts、历史 summary。

触发方式:
- agent 框架触发: 在调用 LLM 前后检查并执行
- LLM 自触发: prompt 中告知 context-window 大小和已用量，超过阈值时 LLM 调用 session-compact tool 自行压缩

#### Memory 层级

| 层级 | 文件 | 作用域 | 说明 |
|------|------|--------|------|
| Thread Memory | `memory/thread-<thread_id>.md` | 单个 thread | 该 thread 的历史压缩摘要 |
| Per-Peer Memory | `memory/user-<peer_id>.md` | 跨 thread | 某个 peer 的长期偏好、事实 |
| Agent Memory | `memory/agent.md` | 跨所有 peer/thread | agent 级别的全局记忆 |

Thread Memory 用于 context 压缩（基础设施）。Per-Peer Memory 和 Agent Memory 用于跨 thread 的长期记忆（当 agent 服务多个 peer 或管理多个 thread 时启用）。

---

## 3. 通信网关 (xgw)

### 设计原则

1. 入站和出站是两个独立的异步消息流，不存在 request-response 对应关系
2. xgw 是双向消息桥接器：外部渠道 ↔ 内部 agent
3. xgw 负责渠道侧的一切（连接管理、消息归一化、网关路由），xar 不接触渠道细节
4. xar 出站时只需指定目标地址，xgw 知道怎么投递
5. gateway 只处理跨系统通信，agent 间通信不经过 gateway

### 网关层概念

**Channel**: 外部通信渠道的实例。每个 channel 由 `channel_id` 唯一标识，格式为 `<channel_type>:<instance>`（如 `telegram:main`、`tui:default`、`slack:workspace-1`）。channel_type 标识渠道类型（对应一个 channel plugin 实现），instance 区分同一类型下的不同实例（如多个 Telegram bot）。xgw 解析 channel_id 的前缀即可找到对应的 plugin。

**Peer**: 外部通信的对端（人类用户或其他系统）。由 `peer_id` 标识，在特定 channel 内唯一。

**Conversation**: 渠道侧的会话标识，由 `conversation_type` + `conversation_id` 描述。
- `conversation_type`: `dm`（单聊）| `group`（群聊）| `channel`（频道）
- `conversation_id`: 会话标识。一般单聊时通常等于 peer_id，群聊时为群组 ID。(某些IM内叫 chat_id等，如飞书)。

### 入站协议

#### Channel Plugin → xgw

每个 channel_type 对应一个 channel plugin 实现，各 plugin 将渠道原始消息归一化为统一的 Message 结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 渠道侧消息 ID |
| `channel_id` | string | 渠道实例标识 |
| `peer_id` | string | 发送者标识 |
| `peer_name` | string \| null | 发送者显示名 |
| `conversation_id` | string | 渠道侧会话标识 |
| `text` | string | 消息文本 |
| `attachments` | Attachment[] | 附件列表 |
| `reply_to` | string \| null | 被回复的消息 ID |
| `created_at` | string | ISO 8601 时间戳 |
| `raw` | object | 原始渠道消息（调试用） |

Channel plugin 还负责检测渠道原生的 mention 状态和会话类型，这些信息编码进 source 地址和入站消息的元数据中。

#### xgw → xar（IPC 入站消息）

xgw 将 Message 转换为 IPC 入站消息发送给 xar：

```typescript
interface InboundMessage {
  source: string    // 结构化来源地址
  content: string   // 消息文本
}
```

xgw 在此步骤完成：
1. 构造 `source` 地址（从 Message 的一级属性编码）
2. 通过网关路由解析 `(channel_id, peer_id) → agent_id`
3. 通过 XarClient 发送 `{ agentId, message: InboundMessage }` 给 xar

渠道侧元数据（was_mentioned、visibility、peer_name、raw 等）不通过 IPC 传递给 xar，由 xgw 在入站时自行处理和记录。

> **设计说明：source（字符串） vs target（JSON）**
>
> 入站用结构化字符串（`source`）：因为 source 要持久化到 thread event 的 TEXT 字段，字符串更紧凑，也方便 grep/调试。
>
> 出站用 JSON 结构（`OutboundTarget`）：因为 target 是运行时 IPC 消息的一部分，不需要持久化，JSON 更易于程序处理。

### 出站协议

#### xar → xgw（IPC 出站事件）

xar 通过 IPC 向 xgw 发送出站事件。一次 streaming 会话由 `stream_start` 开始，`stream_end` 或 `stream_error` 结束，中间的事件通过 `stream_id` 关联。

| 事件类型 | 携带字段 | 说明 |
|---------|---------|------|
| `stream_start` | `target`, `stream_id` | 开始一次出站流，携带完整目标地址 |
| `stream_token` | `stream_id`, `token` | LLM 生成的文本 token |
| `stream_thinking` | `stream_id`, `delta` | LLM 思考过程 |
| `stream_tool_call` | `stream_id`, `tool_call` | 工具调用事件 |
| `stream_tool_result` | `stream_id`, `tool_result` | 工具调用结果 |
| `stream_ctx_usage` | `stream_id`, `ctx_usage` | Context window 使用情况 |
| `stream_compact_start` | `stream_id`, `compact_start` | Session 压缩开始 |
| `stream_compact_end` | `stream_id`, `compact_end` | Session 压缩结束 |
| `stream_end` | `stream_id` | 流结束 |
| `stream_error` | `stream_id`, `error` | 流错误 |

#### OutboundTarget

`stream_start` 是唯一携带目标地址的事件：

```typescript
interface OutboundTarget {
  channel_id: string
  peer_id: string
  conversation_id: string
}
```

target 的来源因场景而异：

| 场景 | target 来源 |
|------|------------|
| 回复入站消息 | 从入站消息的 `source` 地址解析 |
| 定时任务触发 | 从任务配置中读取 |
| Agent 主动推送 | 从 agent 配置或运行时状态中获取 |
| Agent 间通信结果回传 | 从原始请求的 source 中解析 |

所有场景最终都走同一条出站路径。xgw 不区分这些场景。

#### stream_id

由 xar 生成，格式为 `<channel_id>:<conversation_id>:<seq>`，其中 `seq` 是 xar per-agent 的单调递增计数器。这保证了同一 conversation 的前后两次 streaming 可以区分。xgw 用 stream_id 关联同一次 streaming 的所有事件，不解释其内部结构。

#### Dispatcher 处理逻辑

xgw Dispatcher 维护 `stream_id → StreamState` 的映射：

```typescript
interface StreamState {
  channelId: string       // 如 "telegram:main"，解析前缀即得 channel type
  peerId: string
  conversationId: string
  streaming: boolean      // channel plugin 是否支持 streaming
  tokenBuffer: string[]
  flushTimer: Timer       // TUI 批量刷新定时器
  watchdogTimer: Timer    // stream_end 超时看门狗
}
```

投递策略因 channel 类型而异：

| Channel 类型 | 投递方式 |
|-------------|---------|
| TUI | 批量刷新（每 100ms 合并 token 发送），stream_end 时发送结束帧 |
| Streaming plugin | 实时转发每个 token chunk，stream_end 时发送完整文本 |
| 非 Streaming plugin | 累积所有 token，stream_end 时一次性发送完整文本 |

#### xgw → Channel Plugin

xgw 通过 channel plugin 的 `send()` 方法投递消息：

```typescript
interface SendParams {
  peer_id: string
  conversation_id: string
  text: string
  reply_to?: string
  stream?: 'chunk' | 'end'
  progress?: 'thinking' | 'tool_call' | 'tool_result' | 'ctx_usage' | 'compact_start' | 'compact_end'
}
```

### IPC 连接

xgw 与 xar 之间通过持久 WebSocket 连接通信：

- 主连接：Unix socket（`~/.theclaw/xar.sock`）
- 备用连接：TCP loopback（`127.0.0.1:18792`）
- 自动重连：断线后指数退避重连（3s → 60s 上限）
- 入站缓冲：xar 不可用时，xgw 在内存中缓冲最多 100 条入站消息，重连后按序发送

### 网关路由

网关路由决定入站消息投递给哪个 agent：`(channel_id, peer_id) → agent_id`。

```yaml
# xgw config.yaml
routing:
  - channel: tui:default
    peer: "*"
    agent: admin
  - channel: telegram:main
    peer: alice
    agent: admin
  - channel: telegram:main
    peer: bob
    agent: support
```

网关路由只负责"消息给哪个 agent"。消息到达 agent 后放入哪个 thread，由 agent 的 Thread 分配策略决定（见 [Thread 分配](#thread-分配)）。

### Mention Gating

群聊场景下，bot 通常不应对每条消息都回复。

触发条件（满足任一即触发）：
- 被显式 @ 提及
- 消息匹配配置的 `mention_patterns`
- 回复了 bot 之前发送的消息（reply-to-bot）

未触发时：消息仍然写入 thread（作为上下文），但 event type 标记为 `record`（不触发 LLM 调用）。

Mention 检测分两层：channel plugin 解析渠道原生 mention 状态；xgw 在构造入站消息时结合 agent 配置决定消息的 type（message vs record）。

### 回复可见性

| visibility | 说明 | 典型场景 |
|-----------|------|---------|
| `public` | 所有群成员可见 | bot 作为群成员参与讨论 |
| `private` | 仅发问者可见 | bot 被 @，私密回复 |

可见性由 channel plugin 在入站时检测，xgw 记录在自己的状态中。出站时，xgw 根据记录的可见性选择投递方式。xar 不需要感知可见性。

### 子会话归一化

xgw 将 IM 平台的子会话（Slack thread、Discord thread、Telegram forum topic 等）编码进 `conversation_id`：

| 平台 | 子会话类型 | 归一化后的 conversation_id |
|------|-----------|--------------------------|
| Slack | thread | `<channel_id>/<thread_ts>` |
| Discord | thread | `<parent_channel_id>/<thread_channel_id>` |
| Telegram | forum topic | `<group_id>/<topic_id>` |

编码约定：统一用 `/` 分隔父子 ID。无子会话时 conversation_id 不含 `/`。xgw 自己编码、自己拆解。agent 层完全不需要知道"子会话"这个渠道概念。

---

## 4. Agent 运行时 (xar)

### 处理流程

消息到达 xar 后的处理流程：

```
IPC 入站 → Thread 分配（根据 source + agent 配置，解析目标 thread 路径）
  → 写入目标 thread（持久化，thread CLI/LIB）
  → 获取 thread lock（同一 thread 内串行）
  → 构造 context（最新 messages + memory）
  → LLM 调用（pai LIB）
  → 写回 thread（assistant 消息、toolcall 等）
  → 出站（stream_start → stream_token... → stream_end → IPC → xgw）
  → 释放 thread lock
```

并发粒度为 thread：不同 agent 并发，同一 agent 的不同 thread 并发，同一 thread 内串行。

### Thread 分配

消息到达 agent 后，xar 根据 source 中的属性（conversation_type、conversation_id、peer_id）和 agent 配置决定写入哪个 thread。

```json
// agent config.json
{
  "routing": {
    "default": "per-peer"
  }
}
```

| 分配模式 | 说明 | Thread 路径 |
|---------|------|------------|
| `per-peer` | 每个 peer 独立 thread | `threads/peers/<peer_id>/` |
| `per-conversation` | 每个渠道侧 conversation 独立 thread | `threads/conversations/<conversation_id>/` |
| `per-agent` | 所有消息共享一个 thread | `threads/main/` |

每个目标 thread 是一个由 thread CLI/LIB 管理的持久化事件队列（SQLite + JSONL）。Thread 按需创建——首次路由到某个 thread 路径时自动 `thread init`。

### Message 到 Thread Event 的映射

xar 将入站消息写入 thread 时的映射规则：

| 入站字段 | → Event 字段 | 说明 |
|---------|-------------|------|
| `source` | `source` | 直接使用 |
| （由 mention gating 决定） | `type` | `message` 或 `record` |
| `content`（text + attachments + reply_to） | `content` | 序列化为 JSON |

Agent 自身写入 thread 的事件（toolcall、decision 等）使用 `self` 作为 source。

### Agent 间通信

Agent 间通信通过 xar daemon 内部投递，不经过 xgw。Agent A 向 Agent B 发消息时，xar 将消息路由到 B 的目标 thread（复用 Thread 分配逻辑），source 使用 `internal:...` 地址格式。

### System Agents

| agent_id | 职责 |
|----------|------|
| `admin` | 系统管理员，面向用户，处理日常交互和 agent 管理 |
| `warden` | 安全/审计/合规，监控系统行为 |
| `maintainer` | 升级/维护，处理系统更新 |
| `evolver` | 自我迭代/学习/优化 |

User Agents 由用户通过和 admin 交互创建。

### Agent 目录结构

```
~/.theclaw/agents/<agent_id>/
├── IDENTITY.md               # agent 身份描述
├── config.json               # agent 配置
├── sessions/                 # LLM session 文件（JSONL，按 thread_id 命名）
├── memory/                   # Memory 文件（Markdown）
│   ├── agent.md              # 跨所有 peer/thread 的记忆
│   ├── user-<peer_id>.md     # per-peer 跨 thread 的记忆
│   └── thread-<thread_id>.md # per-thread 压缩摘要
├── threads/                  # 按 Thread 分配规则创建
│   ├── peers/                # per-peer threads
│   ├── conversations/        # per-conversation threads
│   └── main/                 # per-agent 单一 thread
├── workdir/                  # 临时工作区
└── logs/
```

### IM Bot 场景示例

以一个 Telegram bot 同时服务单聊和群聊为例。

**单聊 — bot 服务多个 peer**（per-peer 分配）:

```
Alice 单聊 bot  →  网关路由 → admin agent → Thread 分配(per-peer) → threads/peers/alice/
Bob 单聊 bot    →  网关路由 → admin agent → Thread 分配(per-peer) → threads/peers/bob/
```

**群聊 — bot 作为群成员公开参与**（per-conversation 分配）:

```
Alice 在群里发言  →  网关路由 → admin agent → Thread 分配(per-conversation) → threads/conversations/grp-123/
Bob 在群里发言    →  同一个 thread: threads/conversations/grp-123/
```

**定时任务 — agent 主动推送**:

```
定时触发 → agent 处理 → Deliver(conn, savedTarget) → IPC → xgw → channel → peer
```

与普通回复走完全一样的出站路径。

### 典型部署配置

| 场景 | 配置 |
|------|------|
| 单用户 + 单渠道（最简） | 1 peer × 1 channel × 1 agent → 1 thread (per-agent) |
| 多用户 + 单聊（典型） | M peers × 1 channel × 1 agent → M threads (per-peer) |
| 群聊 — bot 公开参与 | M peers × 1 channel (group) × 1 agent → 1 thread (per-conversation) |
| 混合 — 单聊 + 群聊 | dm: per-peer, group: per-conversation |

---

## 5. Bootstrap

### 设计原则

1. **TheClaw 是安装器，不是运行时依赖**。setup 完成后，系统运行不需要 theclaw 命令参与。
2. **Profile 驱动**。所有初始化行为由 profile 文件声明，setup 只是 profile 的执行器。
3. **幂等性**。重复执行 setup 时，已存在的配置/agent 跳过（除非 `--reset`）。
4. **占位符交互填充**。profile 中的敏感信息用 `${VAR}` 占位符，setup 时交互式填充或从环境变量读取。

### Profile 格式

Profile 是一份 YAML 声明式配置模板，描述"我要一个什么样的 TheClaw 实例"。

```yaml
# profile: standard.yaml
meta:
  name: standard
  description: "单用户 + Telegram + 全部 system agents"
  version: "1.0"

pai:
  providers:
    - name: openai
      provider: openai
      apiKey: "${OPENAI_API_KEY}"
      defaultModel: gpt-4o

xgw:
  gateway:
    host: 127.0.0.1
    port: 18790
  channels:
    - id: telegram:main
      token: "${TELEGRAM_BOT_TOKEN}"
  routing:
    - channel: telegram:main
      peer: "*"
      agent: admin

agents:
  - id: admin
    kind: system
    pai:
      provider: openai
      model: gpt-4o
    routing:
      default: per-peer
    identity: |
      你是 TheClaw 系统的管理员 agent。
    usage: |
      Admin 是 TheClaw 的入口 agent。

  - id: warden
    kind: system
    pai:
      provider: openai
      model: gpt-4o
    routing:
      default: per-agent
    identity: |
      你是 TheClaw 系统的安全守卫 agent。

  - id: maintainer
    kind: system
    pai:
      provider: openai
      model: gpt-4o
    routing:
      default: per-agent
    identity: |
      你是 TheClaw 系统的维护 agent。

  - id: evolver
    kind: system
    pai:
      provider: openai
      model: gpt-4o
    routing:
      default: per-agent
    identity: |
      你是 TheClaw 系统的进化 agent。

defaults:
  retry:
    max_attempts: 3
  deliver:
    max_attempts: 3
```

#### Profile 段说明

| 段 | 对应组件 | setup 时的动作 |
|----|---------|---------------|
| `meta` | theclaw | 记录到 theclaw 自身配置 |
| `pai.providers[]` | pai | 调用 `pai model config --add` 逐个添加 |
| `xgw` | xgw | 写入 `~/.config/xgw/config.yaml` |
| `agents[]` | xar | 逐个 `xar init` + 写 config.json/IDENTITY.md/USAGE.md |
| `defaults` | xar | 写入各 agent 的 config.json |

#### 占位符

`${VAR}` 格式的值在 setup 时按以下优先级填充：
1. 环境变量（`export OPENAI_API_KEY=sk-...`）
2. 交互式提示（`Enter your OpenAI API key:`）
3. 未填充则报错退出

### `theclaw setup` 流程

```bash
theclaw setup [--profile <name|path>] [--reset]
```

默认 profile: `standard`。`--reset` 清除已有配置重新初始化。

#### 执行步骤

```
1. 检测组件
   ├── which pai && pai --version
   ├── which thread && thread --version
   ├── which notifier && notifier --version
   ├── which xgw && xgw --version
   └── which xar && xar --version
   未安装的组件：报错退出

2. 加载 Profile
   ├── 解析 YAML
   ├── 扫描 ${VAR} 占位符
   └── 交互式填充（或从环境变量读取）

3. 配置 pai
   └── 对 profile.pai.providers[] 逐个执行:
       pai model config --add --name <name> --provider <provider> --set apiKey=<key> ...

4. 创建目录结构
   └── mkdir -p ~/.theclaw/agents/

5. 初始化 agents（按顺序：admin → warden → maintainer → evolver）
   对每个 agent:
   ├── xar init <id> --kind <kind>
   ├── 写入 config.json（从 profile 生成）
   ├── 写入 IDENTITY.md
   └── 写入 defaults（retry 等配置项合并到 config.json）

6. 启动 xar daemon
   └── xar daemon start

7. 配置并启动 xgw
   ├── 写入 ~/.config/xgw/config.yaml（从 profile.xgw 生成）
   └── xgw start

8. 启动 agents（注册到 xar daemon）
   └── 对每个 agent: xar start <id>

9. Smoke test
   ├── xar daemon status → 确认 running
   ├── xgw status → 确认 running + channels healthy
   ├── xar list → 确认各 agent 已注册
   └── 输出摘要
```

#### 幂等性规则

| 场景 | 行为 |
|------|------|
| agent 已存在 | 跳过 init，但更新 config.json/IDENTITY.md（如果 profile 内容有变化） |
| pai provider 已配置 | 覆盖更新 |
| xgw 已在运行 | 先 stop，更新配置，再 start |
| xar daemon 已在运行 | 先 stop，重新 start |
| `--reset` | 删除 `~/.theclaw/` 和各组件配置，从头开始 |

### "退场"原则

setup 完成后，theclaw CLI 不参与系统日常运行。各组件独立运行：

- xar daemon 管理 agent 生命周期和消息处理
- xgw daemon 监听渠道消息，通过 IPC 与 xar 通信
- notifier daemon 处理定时任务调度

theclaw 仅在以下场景重新介入：
- 全新安装：`theclaw setup`
- 大版本升级：`theclaw upgrade`
- 配置重置：`theclaw setup --reset`
- 查看全局状态：`theclaw status`

日常运维由 maintainer agent 完成，系统进化由 evolver agent 完成。

### 预置 Profile

**minimal**: 单用户 + TUI + admin only。最快体验，无需外部 IM 配置。

```yaml
meta:
  name: minimal
  description: "最简配置：单用户 + TUI + admin only"
  version: "1.0"

pai:
  providers:
    - name: openai
      provider: openai
      apiKey: "${OPENAI_API_KEY}"
      defaultModel: gpt-4o

xgw:
  gateway:
    host: 127.0.0.1
    port: 18790
  channels: []
  routing: []

agents:
  - id: admin
    kind: system
    pai:
      provider: openai
      model: gpt-4o
    routing:
      default: per-agent
    identity: |
      你是 TheClaw 的管理员 agent。

defaults:
  retry:
    max_attempts: 3
  deliver:
    max_attempts: 3
```

**standard**: 见上文完整 profile 示例。

---

## 6. 约定

**退出码**: `0` 成功, `1` 运行时错误, `2` 参数/用法错误

**输出模式**: 默认人类可读，`--json` 机器可解析，部分组件 TTY 自动检测

**stdout/stderr 约定**: stdout 输出命令结果数据，stderr 输出进度、调试、错误和警告信息

**日志**: 各组件日志超过 10000 行自动轮换，格式 `[ISO8601] [LEVEL] message`

**环境变量**:

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `THECLAW_HOME` | 数据根目录 | `~/.theclaw` |
| `NOTIFIER_HOME` | notifier 数据目录 | `~/.local/share/notifier` |
| `XGW_CONFIG` | xgw 配置文件 | `~/.config/xgw/config.yaml` |
| `XGW_HOME` | xgw 数据目录 | `~/.local/share/xgw` |
| `PAI_CONFIG` | pai 配置文件 | `~/.config/pai/default.json` |

**端口与 Socket 分配**:

| 用途 | 类型 | 地址 | 说明 |
|------|------|------|------|
| xar IPC（主） | Unix socket | `~/.theclaw/xar.sock` | xgw ↔ xar 内部通信 |
| xar IPC（备用） | TCP | `127.0.0.1:18792` | Unix socket 不可用时的 fallback |
| xgw gateway | TCP | `127.0.0.1:18790` | xgw 对外服务端口（WebSocket/HTTP，供 TUI 等客户端连接） |
