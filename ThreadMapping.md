# Thread 映射详解

本文档描述 xgw Message 的属性如何映射到 agent 内部的 thread，覆盖各种 IM 场景和渠道特性。

核心概念和两层路由的定义见 [DESIGN.md](DESIGN.md)。

---

## 路由模式回顾

| 模式 | 说明 | Thread 路径 |
|------|------|-------------|
| `per-peer` | 每个 (channel_id, peer_id) 独立 thread | `threads/peers/<channel_id>-<peer_id>/` |
| `per-session` | 每个 (channel_id, session_id) 独立 thread | `threads/sessions/<channel_id>-<session_id>/` |
| `per-agent` | 所有消息共享一个 thread | `threads/main/` |

默认配置:
```yaml
routing:
  dm: per-peer
  group: per-session
  channel: per-session
```

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
                       附加属性: visibility=private, was_mentioned=true
                       → routing: per-peer → threads/peers/tg-bot-alice/
```

虽然消息来自群聊 session，但交互本质是一对一。路由到 per-peer thread，与 Alice 的单聊共享上下文。outbound 回复时根据 `visibility=private` 选择私密方式 (DM fallback 或 ephemeral)。

### 场景 3: 群聊 — bot 作为群成员公开参与

bot 看到所有消息，回复所有人可见。

```
Alice 在群里发言  →  session_type=group, peer=alice, session=group-123
                      附加属性: visibility=public, was_mentioned=false
                      → routing(group)=per-session → threads/sessions/tg-bot-group-123/

Bob 在群里发言    →  同一个 thread: threads/sessions/tg-bot-group-123/
```

所有人的消息汇入同一个 thread。outbound 回复到群组 session，所有人可见。

---

## Mention Gating

群聊场景下，bot 通常不应对每条消息都回复。

**触发条件** (满足任一即触发):
- 被显式 @ 提及 (附加属性 `was_mentioned=true`)
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

实现分两层: xgw channel plugin 解析原生 mention 并标注 `was_mentioned`；agent inbox consumer 结合配置决定 event type。

---

## 回复可见性

| visibility | 说明 | 典型场景 |
|-----------|------|---------|
| `public` | 所有群成员可见 | bot 作为群成员参与讨论 |
| `private` | 仅发问者可见 | bot 被 @，私密回复 (ephemeral / DM fallback) |

visibility 由 channel plugin 根据渠道特性标注，agent 透传给 `xgw send`。

---

## 出站回复

outbound consumer 触发 `xgw send` 时，从 event 的附加属性中提取路由信息:

| 场景 | xgw send 参数 |
|------|--------------|
| 单聊 | `--session <peer_id>` |
| 群聊公开 | `--session <group_id>` |
| 群聊私密 | `--session <group_id> --peer <peer_id> --private` |
| 子会话 | `--session <group_id> --sub-thread <topic_id>` |

---

## 子会话 (Sub-thread)

许多 IM 平台在群聊/频道内支持子会话:

| 平台 | 子会话类型 | sub_thread_id 来源 |
|------|-----------|-------------------|
| Slack | thread | `message.thread_ts` |
| Discord | thread | `message.channel_id` (当 channel 是 thread 类型时) |
| Telegram | forum topic | `message.message_thread_id` (当群组 `is_forum=true`) |

xgw 在归一化时提取 `sub_thread_id` 作为附加属性。agent 路由时在 session thread 基础上追加子目录:

```
threads/sessions/<channel_id>-<group_id>/                    # 普通群聊
threads/sessions/<channel_id>-<group_id>/topics/<topic_id>/  # Telegram forum topic
threads/sessions/<channel_id>-<group_id>/threads/<thread_id>/ # Slack/Discord thread
```

子会话 thread 是独立的 thread 目录 (独立 events.db)，与父 session thread 不共享事件流。

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

---

## session_id 的角色

session_id 是渠道侧概念，在系统内部:
- 入站: 作为一级属性写入 inbox event，供 agent 路由
- 出站: 编码进 `xgw send --session <id>`，确保回复投递到正确的渠道会话
- 路由: per-session 模式下参与 thread 选择；per-peer 模式下不参与

session_id ≠ thread。一个 session 可能映射到一个 thread (per-session)，也可能同一 peer 的不同 session 汇入同一 thread (per-peer)，也可能所有 session 汇入同一 thread (per-agent)。