# TheClaw 核心概念模型

本文档定义 TheClaw 系统中所有核心抽象的语义。不涉及具体实现细节（那是各组件 SPEC 的事），只定义概念。

系统总览见 [TheClawArchitecture.md](TheClawArchitecture.md)。

---

## 世界观

整个世界由 Actor 和 Thread 组成。

Actor 通过 Event（携带 Artifact）在持久化的 Thread 中通信。

Thread 在现实世界中的对应物:
- IM 单聊 / 群聊
- Slack 频道的主线程
- GitHub Issue 的评论区
- 代码仓库的 commit 流
- 任意的 multi-party async 通信
- 任意的 event-stream

---

## Actor

Actor 有身份（Identity）和地址（Address）。Actor 可以向 Thread 发送/接收 Event，执行 tool call 并产生 Artifact。

**分类**:
- **Agent**: 自治的、主动的智能机器。
- **Human**: 自然人。分为 Owner（管理 agent 生命周期）和 Peer（接受 agent 服务）。

**Identity**:
- Role: 在特定 Thread 里承担的角色。
- Scope: 能力范围与权限边界。

---

## Thread

Thread 是持久化的事件流容器，是 Actor 之间异步通信的媒介。

技术上，Thread = 目录（路径 = Thread ID），通过 `thread init <path>` 初始化。

**核心约束**: Events 只追加，不修改，不删除。Context 选择（哪些 event 喂给 LLM）是 agent 运行时的职责，不是 thread 层的职责。

**目录结构**:
```
<thread-dir>/
├── events.db                        # SQLite（WAL 模式）
├── events.jsonl                     # 只追加事件日志，供调试浏览
├── events-<YYYYMMDD-HHmmss>.jsonl   # 轮换后的历史日志
├── run/                             # Consumer 运行时 .lock 文件
└── logs/
```

---

## Event

Event 是 Actor 之间通信的基本单元，存在于 Thread 中。

### 存储层分类（type 字段）

Thread 层使用 `type` 字段决定事件的处理语义:

| type | 说明 |
|------|------|
| `message` | 触发 agent 处理（LLM 调用） |
| `record` | 仅记录上下文，不触发处理（如群聊中未 mention 的消息） |

### 语义层分类（subtype 字段）

描述事件的本质含义:

| subtype | 说明 |
|---------|------|
| `message` | 纯粹的自然语言传递，用于对齐认知 |
| `command` | 明确的行动请求，触发系统或工具 |
| `artifact` | 世界中产生的具体对象（代码、文档、计算结果） |
| `decision` | 对路径的选择或权力的行使，标记逻辑转折点 |
| `toolcall` | tool call 及其结果 |

两个维度正交: 一个 event 的 `type=message` + `subtype=command` 表示"这是一个需要 agent 处理的行动请求"；`type=record` + `subtype=message` 表示"这是一条仅作为上下文记录的自然语言消息"。

### 因果链

```
Message {产生} Command {执行} Artifact {确认} Decision {沉淀} State
```

### Event Schema

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 自增主键 (SQLite) |
| `created_at` | TEXT | ISO 8601 |
| `source` | TEXT | 事件来源标识 |
| `type` | TEXT | `message` \| `record` |
| `subtype` | TEXT? | `message` \| `command` \| `artifact` \| `decision` \| `toolcall` \| ... |
| `content` | TEXT | 事件内容 |

---

## Artifact

Actor 执行 toolcall 时产生的构建物（文件）。被 event 引用，属于相应的 Thread。

---

## Agent 内部模型

### Agent 看到的世界

```
World = {
  Inbox        // 我能看到的事件流 (event stream)
  State        // 我记住的压缩状态 (goal/plan/memory)
  Actions      // 我可以执行的动作 (tool/message)
  Identity     // 我是谁 (role/scope)
}
```

### State

- **Goal**: 当前 session 的目标。
- **Plan**: 为达成目标而制定的策略。
- **Memory**: 分两级:
  - Session Memory: 单个 session 内的滚动压缩记忆（基座层，详见 [AgentSessionDesign.md](AgentSessionDesign.md)）。
  - Agent-Level Memory: 跨 session 的长期记忆（S1=multi 时启用），包含用户长期 goal、preference、facts、history summary。

### Agent 内部结构

```
Agent = Inbox + Reducer + Executor
```

- **Inbox**: Thread 的一个视图 = `Visibility(Thread, Identity)`
- **Reducer**: 将 Inbox 事件流转化为可理解的状态。包含基座层的 context 生成逻辑（原始 messages + session memory → context）。
- **Executor**: 执行动作产生副作用并写回 Thread。

### OUDA 运作循环

1. **Observe**: 监听 Inbox 中新产生的 Events。
2. **Update**: State_new = Reducer(State_old, Inbox_new)。
3. **Decide**: 基于 Identity 和 State 决定下一步动作。
4. **Act**: 通过 Actions 接口执行动作，产生新事件写回 Thread。

---

## Session 与 Thread 的关系

**Thread** 是系统内部的持久化事件流容器（底层基础设施）。**Session** 是 agent 在某个 Thread 上与 LLM 交互的上下文管理单元（agent 运行时概念）。

一个 Thread 承载原始事件流；一个 Session 在该 Thread 之上维护 context window、memory、LLM 调用历史。Thread 是管道，Session 是 agent 使用管道的方式。

另外，xgw Message 中的 `session_id` 是渠道侧概念（如 Telegram 群聊 ID），仅用于路由决策和出站回复，与 agent 的 Session 是不同层次的东西。

Session 架构的完整设计（基座层 + 三个正交策略开关）详见 [AgentSessionDesign.md](AgentSessionDesign.md)。

| 策略 | 问题域 | 选项 |
|------|--------|------|
| S1: Session Segmentation | 同一 (agent, user, channel) 下是否允许多个 session | single / multi |
| S2: Channel Routing | 多通道消息如何映射到 thread | N/A / merge / isolate |
| S3: Entity Multiplexing | 多 agent 或多用户时的隔离与路由 | N/A / user-isolate / agent-route / both |
