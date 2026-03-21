《Agent Session 架构设计 — 从基座到策略的正交分解》

# 术语约定

本文档中的核心术语:

- **Session**: agent 在某个 Thread 上与 LLM 交互的上下文管理单元，包含 context window、memory、LLM 调用历史。本文档的主角。
- **Thread**: 系统内部的持久化事件流容器（目录）。Session 建立在 Thread 之上——Thread 承载原始事件流，Session 管理 agent 如何使用这些事件流。
- **session_id**: xgw Message 的一级属性，标识外部渠道的会话（如 Telegram 群聊 ID）。仅用于路由决策，与本文档的 Session 是不同层次的概念。

# 核心思想

任何 Agent 的 session 架构，都可以分解为一个基座层 + 三个正交的策略开关。
基座层是所有场景的标配，策略层按需组合即可覆盖从最简单到最复杂的全部场景。

---

# 基座层: Session Context Management

无论什么场景，单个 session 内部的上下文管理机制是一切的基础。

## 两个事件流

用户看到的消息流:
  - user 消息 (role = user)
  - assistant 每轮结束时不含 tool call 的消息 (role = assistant)
  - 注: thinking 消息可以看成是 output 的另一个通道

agent 看到的事件流 = 用户消息流 + agent 内部动作产生的事件:
  - user 消息 (role = user)
  - assistant 不含 tool call 的消息 (role = assistant)
  - assistant 包含 tool call 的消息 (role = assistant)
  - tool call result 的消息 (role = tool)

## 存储

用户看到的事件流 → 存储在用户交互界面里。
agent 看到的事件流 → 存储在 agent 的 session 里，原始事件流可无限追加。

## Context 生成

agent 每次调用 LLM 时，并不是把完整的原始事件流全部传入，而是滚动处理:

1. 维护一个原始 messages 数组 (role = user/assistant/tool)，即 agent 事件流的完整记录。
2. 维护一个 session memory (可以是数据库/json/markdown 等)，存放从历史中抽取的压缩信息。
3. 每次调用 LLM 时，取原始 messages 中最新的未被 memory 覆盖的部分 + memory 中的相关片段，拼成 context。
4. context 一般作为 messages 数组传给 LLM (system prompt 只是 messages[0], role=system)。
5. 最近几轮的完整消息通常直接保留在 context 中，而非从 memory 提取，以保证效果。

## Memory 更新

触发时机:
  - context 占 context-window 比例超过阈值 (如 80%)。适合 session 无限延长或自动轮换的情况。
  - 定期更新 (如每 5 轮)。适合滚动压缩。
  - 用户明确要求。
  - session 闲置一段时间无活动时。

Memory 内容:
  - 当前 goal
  - 用户 preference & facts
  - 历史 summary

谁来触发:
  - agent 框架触发: 在调用 LLM 前后检查并执行。
  - LLM 自触发: prompt 中告知 context-window 大小和已用量，超过阈值时 LLM 调用 session-compact tool 自行压缩。

---

# 策略层: 三个正交开关

在基座层之上，有三个独立的策略维度。每个维度是一个开关/选项，彼此正交，按需组合。

## S1: Session Segmentation — 是否允许多 session

同一个 (agent, user, channel) 元组下，是只有一个持续 session，还是允许多段独立 session。

| 选项 | 含义 |
|------|------|
| single | 只有一个 session，永不切断，靠基座层的滚动压缩续命 |
| multi | 允许多段 session，每段围绕一个主题，可切换/回溯 |

### multi 模式的设计要点

Session 生命周期管理:
  - 新 session 产生: 用户主动创建 / 超期后系统自动创建
  - Session 切换: 用户可主动回到之前的 session 继续交互
  - Session 归档: 长期不活跃的 session 可归档

跨 session 记忆 (Agent-Level Memory):
  当存在多 session 时，除了每个 session 自己的 memory (用于 context 压缩)，还需要一个 agent 级别的、关于当前用户的跨 session 记忆:
  - 用户的长期 goal (超越单个 session 的)
  - 用户的 preference
  - 用户的 facts
  - 历史 summary

  这个 agent-level memory 可以从各 session 的 memory 中提取，也可以从原始事件流中提取 (效率较低)。

## S2: Channel Routing — 多通道消息如何映射到 thread

当用户有多个通道 (SMS / IM / voice call / email 等) 接入时，消息如何路由。

| 选项 | 含义 |
|------|------|
| N/A | 只有一个通道，无需路由 |
| merge | 所有通道的消息合并进同一个 thread 处理。出站可只发给最新来源通道，或广播到所有通道 |
| isolate | 每个通道独立一个 thread (或独立一组 session，取决于 S1)。用户可能用不同通道分饰不同角色 |

### merge 模式的典型场景
用户有多个 IM，希望各处收到的信息汇入一个 thread 集中处理。

### isolate 模式的典型场景
用户在微信上是工作模式，Telegram 上是生活模式，需要上下文隔离。

## S3: Entity Multiplexing — 多实体的隔离与路由

当系统中存在多个 agent 或多个 user 时，如何隔离上下文、路由请求。

| 选项 | 含义 |
|------|------|
| N/A | 单 agent + 单 user，无需处理 |
| user-isolate | 单 agent 服务多用户，每个用户的 session 和 memory 完全隔离 |
| agent-route | 单用户使用多 agent，需要路由机制 (@切换 / 主 agent 中转) |
| both | 多 agent + 多用户，同时需要用户隔离和 agent 路由 |

### user-isolate 的设计要点
- 每个用户拥有独立的 session 集合和 agent-level memory
- agent 的 owner (主人) 也是用户之一，但可能有管理权限
- 同一个 agent 对不同用户做出不同的服务

### agent-route 的设计要点
- @切换模式: 用户在同一个通道里通过 @agent_name 切换目标 agent
- 主 agent 中转模式: 用户始终和一个主 agent 交互，主 agent 按需将请求转发给专业 agent
- 每个 agent 可以有不同的能力 (tools / system prompt / knowledge)

---

# 组合表: 现实场景 → 策略选择

拿到一个新场景时，只需回答 3 个问题 (S1/S2/S3 各选什么)，即可确定架构方案。基座层 (Session Context Management) 是标配，不用选。

| 现实场景 | S1 | S2 | S3 | 说明 |
|----------|----|----|-----|------|
| 个人 AI 助手 (如 ChatGPT) | multi | N/A | N/A | 单用户单通道，核心就是多 session 管理 |
| 全渠道个人助手 (跨 IM/email/voice) | multi | merge | N/A | 所有渠道信息汇入同一 thread 处理 |
| 多角色个人助手 (不同通道不同人格) | multi | isolate | N/A | 微信=工作，Telegram=生活，上下文隔离 |
| 客服机器人 | multi | isolate | user-isolate | 典型 SaaS 客服: 每客户独立，每通道独立，支持多轮 |
| 企业内部多 agent 工作台 | multi | merge | agent-route | 员工通过一个入口 @不同 agent，通道消息合并 |
| 多 agent SaaS 平台 | multi | isolate | both | 多租户 + 多 agent + 多通道，全部拉满 |
| IoT/监控 agent (单设备单流) | single | N/A | N/A | 持续单 session，永不切断，靠滚动压缩续命 |
| 多设备监控中心 | single | merge | user-isolate | 每设备(用户)独立，多传感器通道合并 |
