# 网关与路由设计

本文档描述消息从外部世界进入 TheClaw、在系统内路由到正确的 Thread、以及从系统回到外部世界的完整设计。

核心概念见 [ConceptModel.md](ConceptModel.md)，session 策略见 [AgentSessionDesign.md](AgentSessionDesign.md)，系统总览见 [TheClawArchitecture.md](TheClawArchitecture.md)。

---

## 总体流程

```
peer → channel → xgw → agent.inbox (thread) → agent → thread → agent deliver → xgw send → channel → peer
```

**原则**:
- gateway 只处理跨系统通信，系统内部通信不经过 gateway
- thread 是内部通信的主要媒介，agent inbox 只是一个特殊 thread
- gateway 不负责语义路由（thread 选择由 agent 决定）

---

## 统一 Message 结构

xgw 将各渠道的原始消息归一化为统一 Message。字段分为两类:

### 一级属性

agent 需要理解其语义，用于路由和处理决策:

| 字段 | 说明 |
|------|------|
| `peer_id` | 发送者标识 |
| `channel_type` | 渠道类型: `TUI`\| `webapp` \| `feishu` \| `wechat` \| `telegram` \| `slack` \| `discord` \| `whatsapp` \| ... |
| `channel_id` | 渠道实例标识（同一 channel_type 下可能有多个实例，如多个 Telegram bot） |
| `session_type` | 渠道侧会话类型: `dm` \| `group` \| `channel` |
| `session_id` | 渠道侧会话标识（单聊=peer_id, 群聊=群组ID, 频道=频道ID, 子会话=父ID/子ID） |
| `type` | 消息类型 (写入 thread 时映射为 event type: `message` 或 `record`) |
| `text` | 消息文本 |
| `attachments` | 附件列表 |
| `reply_to` | 被回复的消息 ID |
| `reply_context` | 出站回复上下文（不透明 object），由 xgw 打包，agent 原样透传，出站时由 xgw 解包使用 |

### reply_context

`reply_context` 是 xgw 在入站归一化时打包的不透明对象，包含出站回复所需的全部渠道侧信息。agent 不解释其内容，只在回复时原样带上。

xgw 打包的内容:

| 字段 | 说明 |
|------|------|
| `channel_type` | 渠道类型（冗余，供 xgw send 选择渠道 plugin） |
| `channel_id` | 渠道实例标识 |
| `session_id` | 渠道侧会话标识（出站回复定位用） |
| `peer_id` | 发送者标识（私密回复时定位接收者） |
| `id` | 渠道侧消息 ID |
| `peer_name` | 发送者显示名 |
| `parent_session_id` | 子会话场景下的原始父 session ID（无子会话时不存在） |
| `sub_thread_id` | 渠道侧子会话原始 ID |
| `was_mentioned` | 是否被 mention（渠道原生检测结果） |
| `visibility` | 回复可见性（public/private，渠道侧标注） |
| `created_at` | 渠道侧时间戳 |
| `raw` | 原始渠道消息（调试用） |

**出站透传规则**: agent 回复时，必须把入站消息的 `reply_context` 原样附加到回复 event 上。outbound consumer 从回复 event 的 `reply_context` 中提取全部出站路由信息传给 `xgw send`。agent 的 LLM 逻辑不需要感知 `reply_context` 的内容——由 agent 运行时框架自动处理透传。

agent 路由时只使用一级属性（peer_id、session_type、session_id 等）；`reply_context` 对 agent 路由逻辑完全透明。
---

## 两层路由

### xgw 层

`(channel_id, peer_id) → agent_id` — 由 xgw 配置驱动，决定消息投递到哪个 agent 的 inbox。这是 S3 (Entity Multiplexing) 中 agent-route 的实现点。

入站流程:
```
渠道 webhook/polling → ChannelPlugin.onMessage(raw)
  → normalizer: raw → Message (一级属性 + reply_context)
  → router: (channel_id, peer_id) → agent_id
  → thread push → agent.inbox
```

### agent 层

`inbox event → target thread` — agent 根据一级属性 (`session_type`, `session_id`, `peer_id`) 和自身 routing 配置决定目标 thread。这是 S2 (Channel Routing) 和 S3 (user-isolate) 的实现点。

```yaml
# agent config.yaml
routing:
  dm: per-peer           # 单聊 → 每个 (channel, peer) 独立 thread → S3 user-isolate
  group: per-session     # 群聊 → 每个群组一个 thread → S2 isolate (按 session_id)
  channel: per-session   # 频道 → 每个频道一个 thread → S2 isolate (按 session_id)
```

---

## 路由模式

xgw 只负责将消息投递到 agent.inbox，不关心最终 thread 路径。以下路由模式是 agent 层根据一级属性和自身 routing 配置决定的目标 thread 选择策略:

| 模式 | 说明 | 对应策略 | Agent 内部 Thread 路径示例 |
|------|------|----------|---------------------------|
| `per-peer` | 每个 (channel_id, peer_id) 独立 thread | S3: user-isolate | `threads/peers/<channel_id>-<peer_id>/` |
| `per-session` | 每个 (channel_id, session_id) 独立 thread | S2: isolate | `threads/sessions/<channel_id>-<session_id>/` |
| `per-agent` | 所有消息共享一个 thread | S2: merge | `threads/main/` |

DM 默认 `per-peer`，天然实现 S3 user-isolate。

S1 (Session Segmentation) 在 thread 内部实现: single 模式下一个 thread 对应一个永续 session；multi 模式下 agent 在同一 thread 内按主题/超时切分多个 session，并维护 agent-level memory 实现跨 session 记忆。

### Session 策略与路由的对应关系

| 策略 | 路由层实现 |
|------|-----------|
| S1: Session Segmentation (single/multi) | agent 层: 同一 thread 内是否切分多个 session |
| S2: Channel Routing (merge/isolate) | agent 层: 多通道消息合并到同一 thread 还是每通道独立 thread |
| S3: Entity Multiplexing (user-isolate/agent-route/both) | xgw 层 + agent 层: user-isolate 由 per-peer 路由实现；agent-route 由 xgw 的 (channel_id, peer_id) → agent_id 映射实现 |

---

## IM Bot 场景

以一个 Telegram bot 同时服务单聊和群聊为例。

### 场景 1: 单聊 — bot 服务多个 peer

```
Alice 单聊 bot  →  session_type=dm, peer=alice, session=alice
                    → routing(dm)=per-peer → threads/peers/tg-bot-alice/

Bob 单聊 bot    →  session_type=dm, peer=bob, session=bob
                    → routing(dm)=per-peer → threads/peers/tg-bot-bob/
```

每个人独立上下文。outbound 直接回复到对应单聊。

### 场景 2: 群聊 — @bot 私密回复

bot 被 @ 时才收到消息，回复仅发问者可见。

```
Alice 在群里 @bot  →  session_type=group, peer=alice, session=group-123
                       reply_context: { visibility: "private", was_mentioned: true }
                       → routing: per-peer → threads/peers/tg-bot-alice/
```

虽然消息来自群聊（session_id=group-123），但交互本质是一对一。路由到 per-peer thread，与 Alice 的单聊共享上下文。outbound 回复时根据 `reply_context.visibility=private` 选择私密方式 (DM fallback 或 ephemeral)。

### 场景 3: 群聊 — bot 作为群成员公开参与

bot 看到所有消息，回复所有人可见。

```
Alice 在群里发言  →  session_type=group, peer=alice, session=group-123
                      reply_context: { visibility: "public", was_mentioned: false }
                      → routing(group)=per-session → threads/sessions/tg-bot-group-123/

Bob 在群里发言    →  同一个 thread: threads/sessions/tg-bot-group-123/
```

所有人的消息汇入同一个 thread。outbound 回复到群组（session_id=group-123），所有人可见。

---

## Mention Gating

群聊场景下，bot 通常不应对每条消息都回复。

**触发条件** (满足任一即触发):
- 被显式 @ 提及 (`reply_context.was_mentioned=true`)
- 消息匹配配置的 `mention_patterns`
- 回复了 bot 之前发送的消息 (reply-to-bot)

**未触发时的行为**:
- 消息仍然写入 thread (作为上下文)，但 event type 标记为 `record` (不触发 LLM 调用)

```yaml
# agent config.yaml
group_chat:
  require_mention: true
  mention_patterns: ["@mybot", "小助手"]
  history_limit: 50
  groups:
    "group-123":
      require_mention: false     # 此群组所有消息都触发
```

实现分两层: xgw channel plugin 解析原生 mention 并标注 `reply_context.was_mentioned`；agent inbox consumer 结合配置决定 event type。

---

## 回复可见性

| visibility | 说明 | 典型场景 |
|-----------|------|---------|
| `public` | 所有群成员可见 | bot 作为群成员参与讨论 |
| `private` | 仅发问者可见 | bot 被 @，私密回复 (ephemeral / DM fallback) |

visibility 由 channel plugin 根据渠道特性标注在 `reply_context.visibility` 中，agent 透传给 `xgw send`。

---

## 出站回复

outbound consumer 触发 `xgw send` 时，从回复 event 的 `reply_context` 中提取路由信息:

| 场景 | xgw send 参数 |
|------|--------------|
| 单聊 | `--session <peer_id>` |
| 群聊公开 | `--session <group_id>` |
| 群聊私密 | `--session <group_id> --peer <peer_id> --private` |
| 子会话 | `--session <group_id> --sub-thread <topic_id>` |

---

## 子会话的归一化

许多 IM 平台在群聊/频道内支持子会话（Slack thread、Discord thread、Telegram forum topic 等）。

**xgw 的职责**: 将子会话归一化为 agent 能理解的一级属性，而不是透传渠道侧的子会话 ID。具体做法是将子会话编码进 `session_id`，使 agent 看到的就是一个普通的独立 session:

| 平台 | 子会话类型 | 归一化后的 session_id |
|------|-----------|----------------------|
| Slack | thread | `<channel_id>/<thread_ts>` |
| Discord | thread | `<parent_channel_id>/<thread_channel_id>` |
| Telegram | forum topic | `<group_id>/<topic_id>` |

对 agent 来说，子会话就是一个独立的 session_id，路由逻辑不需要任何特殊处理。渠道侧的原始子会话 ID 保存在 `reply_context.sub_thread_id` 中，仅供 `xgw send` 出站时定位回复目标。

### 原始 session_id 的保留

当 xgw 将子会话编码进 session_id（如 `group-123/topic-456`）时，出站需要能还原出原始的父 session_id 和 sub_thread_id。采用双保险策略：

1. **session_id 编码约定**: xgw 统一用 `/` 分隔父子 ID（`<parent_session_id>/<sub_thread_id>`）。xgw 自己编码、自己拆解，格式由 xgw 内部约定。无子会话时 session_id 不含 `/`。
2. **reply_context 冗余保留**: `reply_context.parent_session_id` 和 `reply_context.sub_thread_id` 分别保存原始值，作为冗余保障和调试依据。

xgw 出站时优先从 session_id 按约定拆解；reply_context 中的原始值作为 fallback。

这样 agent 层完全不需要知道"子会话"这个渠道概念，路由逻辑保持统一。


---

## session_id 与 Thread 的关系

系统中有两个不同层次的 "session" 概念，不要混淆:

- **session_id** (渠道侧): xgw Message 的一级属性，标识外部渠道的会话（如 Telegram 群聊 ID、DM 对话 ID）。仅用于路由决策和出站回复定位。
- **Session** (agent 侧): agent 在某个 Thread 上与 LLM 交互的上下文管理单元，包含 context window、memory、LLM 调用历史。详见 [AgentSessionDesign.md](AgentSessionDesign.md)。

session_id 参与的是"消息路由到哪个 Thread"的决策；Session 是 agent 在 Thread 上"如何管理上下文"的机制。

session_id 在系统内部的具体角色:
- 入站: 作为一级属性写入 inbox event，供 agent 路由
- 出站: 编码进 `xgw send --session <id>`，确保回复投递到正确的渠道会话
- 路由: per-session 模式下参与 thread 选择；per-peer 模式下不参与

session_id ≠ Thread。一个 session_id 可能映射到一个 thread (per-session)，也可能同一 peer 的不同 session_id 汇入同一 thread (per-peer)，也可能所有 session_id 汇入同一 thread (per-agent)。

---

## 典型部署配置

**单用户 + 单渠道 (最简)**:
```
1 peer × 1 channel (dm) × 1 agent → 1 thread (per-agent 或 per-peer)
```

**多用户 + 单聊 (典型)**:
```
M peers × 1 channel (dm) × 1 agent → M threads (per-peer)
```

**群聊 — bot 公开参与**:
```
M peers × 1 channel (group) × 1 agent → 1 thread (per-session)
```

**混合 — 同一 bot 同时服务单聊和群聊**:
```
routing:
  dm: per-peer
  group: per-session

单聊 Alice → threads/peers/tg-bot-alice/
单聊 Bob   → threads/peers/tg-bot-bob/
群聊 G-123 → threads/sessions/tg-bot-group-123/
```
