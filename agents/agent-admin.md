# Admin Agent 设计

Admin 是 TheClaw 的系统管理 agent，负责与 system agent 协调、管理 user agent 生命周期、引导新用户 onboarding。Admin 是外部消息的默认路由目标，但不是唯一能接收外部消息的 agent——user agent 创建后可以直接服务 peer，无需 admin 中转。

---

## 定位

- 外部消息的默认路由目标（xgw routing 的 fallback）
- 唯一直接与 peer 对话的 system agent（其他 system agent 不接收外部消息）
- System agent 的协调入口（warden/maintainer/evolver 不直接接收外部消息）
- User agent 生命周期管理者：创建时同时配置两层 routing，使 user agent 直接服务 peer
- Onboarding 引导者：新 peer 首次对话时引导完成初始设置
- 可选的中转者：peer 可以通过 admin 与 user agent 交互，但这不是必须路径

---

## 与 Peer 的交互协议

### 消息入站

xgw routing 中 admin 是默认 fallback——没有匹配到特定 user agent 的消息路由到 admin：

```yaml
# xgw config.yaml — 初始状态（setup 后）
routing:
  # user agent 的精确路由规则会在创建时动态添加到这里
  # ...

  # admin 作为 fallback（放在最后）
  - channel: "*"
    peer: "*"
    agent: admin
```

当 user agent 被创建并配置了 xgw routing 后，匹配到的 peer/channel 消息直接路由到 user agent，不经过 admin。

admin 从 inbox 消费消息后，根据 routing 配置路由到对话 thread：

```yaml
# admin config.yaml
routing:
  default: per-peer    # 每个 peer 独立 thread，保持独立上下文
```

### 消息处理

admin 的 run-loop 与通用 agent 一致（见 agent/SPEC.md 5.4），但在 LLM 调用前会额外注入以下 context：

1. **系统能力清单**：所有 system agent 的 USAGE.md 摘要（admin 启动时加载并缓存）
2. **当前 peer 的 user agent 列表**（如果有）及其 USAGE.md
3. **系统状态摘要**（可选，通过 `theclaw-health.sh` 获取）

这些 context 让 LLM 能判断：这条消息该自己处理，还是转发给某个 system/user agent。

### 消息出站

admin 的回复通过标准 outbound consumer 机制投递回渠道（见 agent/SPEC.md 6.4）。admin 不需要特殊的出站逻辑。

---

## 请求路由

admin 收到消息后，LLM 判断处理方式：

### 自己处理

日常对话、简单问答、系统状态查询等。admin 直接回复 peer。

### 转发给 System Agent

peer 的请求涉及其他 system agent 的职责时，admin 通过 `thread push` 写入目标 agent 的 inbox：

```bash
thread push \
  --thread ~/.theclaw/agents/<target_agent>/inbox \
  --source "internal:dm:default:admin" \
  --type message \
  --content '{"text":"<转发内容>","reply_context":<原始reply_context>,"forwarded_from":{"peer_id":"alice","channel_id":"tg-main"}}'
```

**路由决策依据**：admin 在 system prompt 中持有所有 system agent 的 USAGE.md 摘要。LLM 根据 USAGE.md 描述的能力范围判断转发目标。

**转发模式**：

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| fire-and-forget | 转发后告知 peer "已转交给 X 处理" | 不需要同步等待结果的任务 |
| wait-and-relay | 转发后订阅目标 agent 的回复，收到后转述给 peer | 需要把结果带回给 peer 的场景 |

**wait-and-relay 实现**：

1. admin 转发消息到目标 agent inbox，content 中携带 `callback` 字段：
   ```json
   {
     "text": "请检查系统健康状态",
     "callback": {
       "reply_to_agent": "admin",
       "reply_to_thread": "~/.theclaw/agents/admin/threads/peers/tg-main-alice",
       "context": "peer alice 询问系统状态"
     }
   }
   ```
2. 目标 agent 处理完成后，将结果写入 admin 的 inbox（source 为 `internal:dm:default:<target_agent>`）
3. admin 的 run-loop 消费到这条内部消息，识别为转发回复，组织语言后回复给 peer

### 转发给 User Agent

peer 请求与某个 user agent 交互时，admin 可以将消息转发到该 user agent 的 inbox（机制与转发给 system agent 相同）。但更常见的做法是修改 xgw routing，让后续消息直接路由到 user agent（见下方"路由切换"）。

---

## User Agent 管理

### 创建 User Agent

peer 通过与 admin 对话请求创建 user agent。admin 需要完成三件事：初始化 agent、配置两层 routing、启动 agent。

**创建流程**（admin 与 peer 的对话）：

```
Peer:  帮我创建一个专门写代码的 agent
Admin: 好的。给它起个名字？
Peer:  coder
Admin: coder 的主要职责是什么？
Peer:  专注于 TypeScript 项目，熟悉 Node.js 生态
Admin: 这个 agent 要服务哪些渠道和用户？
       1) 只服务你（当前渠道）
       2) 服务所有用户（当前渠道）
       3) 自定义
Peer:  只服务我
Admin: 创建完成。coder agent 已启动并直接服务你。
       后续你在 Telegram 上的消息会直接发给 coder。
       如果想和我对话，说"转给 admin"即可。
```

**admin 通过 `bash_exec` 执行的操作**：

```bash
# 1. 初始化 agent
xar init coder --kind user

# 2. 写入 IDENTITY.md（根据 peer 描述生成）
# 3. 写入 USAGE.md（根据 peer 描述生成）
# 4. 写入 config.json（含 agent 层 routing 配置）

# 5. 注册 agent inbox 到 xgw
xgw agent add --id coder --inbox ~/.theclaw/agents/coder/inbox

# 6. 配置 xgw routing — 添加精确路由规则（在 admin fallback 之前）
#    使 peer 的消息直接路由到 coder，不经过 admin
xgw route add --channel telegram-main --peer alice --agent coder

# 7. 启动 agent（注册到 xar daemon）
xar start coder
```

### 两层 Routing 配置

创建 user agent 时，admin 需要配置两层 routing：

**第一层：xgw routing（哪些外部消息路由到这个 agent）**

admin 调用 `xgw route add` 添加精确匹配规则。xgw routing 按顺序匹配，精确规则优先于 admin 的 `*` fallback。

```yaml
# xgw config.yaml — 创建 coder 后
routing:
  # 精确规则：alice 在 telegram-main 上的消息 → coder
  - channel: telegram-main
    peer: alice
    agent: coder

  # fallback：其余消息 → admin
  - channel: "*"
    peer: "*"
    agent: admin
```

常见 xgw routing 模式：

| 场景 | 规则 | 说明 |
|------|------|------|
| 单 peer 专属 | `channel=tg-main, peer=alice → coder` | 只有 alice 的消息到 coder |
| 整个渠道 | `channel=tg-main, peer=* → coder` | 该渠道所有 peer 到 coder |
| 多 peer | 多条规则，每条指定一个 peer | 指定的 peer 到 coder |

**第二层：agent routing（agent 内部如何路由到 thread）**

写入 user agent 的 `config.json`：

```yaml
# coder config.json
agent_id: coder
kind: user

pai:
  provider: openai
  model: gpt-4o

routing:
  default: per-peer    # 每个 peer 独立 thread
```

agent 层 routing 模式选择取决于 user agent 的使用场景：
- 单 peer 专属 agent → `per-agent`（所有消息共享一个 thread，最简单）
- 多 peer 共享 agent → `per-peer`（每个 peer 独立上下文）

### xgw route 管理命令

admin 创建/删除 user agent 时需要操作 xgw routing。这要求 xgw 提供动态路由管理接口：

```bash
# 添加路由规则（插入到 fallback 之前）
xgw route add --channel <channel_id> --peer <peer_id> --agent <agent_id>

# 删除路由规则
xgw route remove --channel <channel_id> --peer <peer_id>

# 列出当前路由规则
xgw route list [--json]
```

> **注意**：xgw route/channel/agent 管理命令已在 xgw SPEC 中定义。

### 路由切换

peer 可以通过当前 agent 请求切换路由目标：

```
Peer:  转给 admin        → 当前 agent 调用 xgw route 将 peer 的路由改回 admin
Peer:  转给 coder        → admin 调用 xgw route 将 peer 的路由改为 coder
```

实现方式：当前接收消息的 agent（无论是 admin 还是 user agent）识别"转给 X"指令后，调用 `xgw route add` 修改 xgw routing。后续消息直接路由到目标 agent，无中转开销。

这要求所有 agent（包括 user agent）的 IDENTITY.md 中包含路由切换指引，使其能识别"转给 X"类指令并执行 `xgw route add`。

### 列出 User Agent

```bash
xar list --json | jq '.[] | select(.kind == "user")'
```

### 停止/删除 User Agent

```bash
# 暂停
xar stop <agent_id>

# 删除前先清理 xgw routing 和 agent 注册
xgw route remove --channel telegram-main --peer alice
xgw agent remove --id <agent_id>

# 删除（直接删目录）
rm -rf ~/.theclaw/agents/<agent_id>/
```

admin 在执行删除前会向 peer 确认。

---

## Onboarding 引导

新 peer 首次与 admin 对话时，admin 检测到该 peer 没有历史 memory 文件（`memory/user-<peer_id>.md` 不存在），触发 onboarding 流程。

### Onboarding 步骤

1. **欢迎**：介绍 TheClaw 系统能力概览
2. **偏好收集**：
   - 交互语言偏好
   - 回复风格偏好（简洁/详细）
   - 主要使用场景（开发辅助/信息查询/任务自动化等）
3. **能力演示**：根据 peer 的使用场景，演示 1-2 个典型交互
4. **User Agent 建议**：根据 peer 描述的需求，建议是否创建专用 user agent
5. **记录偏好**：将收集到的信息写入 `memory/user-<peer_id>.md`

### Onboarding 实现

onboarding 不是硬编码的多步流程，而是 admin 的 IDENTITY.md 中包含 onboarding 指引，LLM 自然地引导对话。admin 通过检查 memory 文件是否存在来判断是否需要 onboarding。

---

## Admin 的 IDENTITY.md

```markdown
# Admin Agent

你是 TheClaw 系统的管理员 agent，是外部消息的默认入口。

## 核心职责

1. 与用户直接对话，处理日常问答和任务
2. 根据用户请求，将任务转发给合适的 system agent
3. 管理 user agent 的创建、配置、启停、路由
4. 引导新用户完成 onboarding

## 路由决策

你持有所有 system agent 的能力描述（USAGE.md）。当用户的请求超出你的直接处理范围时，
判断应该转发给哪个 agent：

- 安全相关（权限、异常行为）→ warden
- 运维相关（健康检查、升级、错误恢复）→ maintainer
- 系统优化（prompt 调优、配置建议）→ evolver

如果不确定，先自己尝试处理。只有明确属于其他 agent 职责范围的才转发。

## User Agent 管理

用户可以请求创建专用 agent。创建时你需要：
1. 初始化 agent（xar init + IDENTITY.md + USAGE.md + config.json）
2. 配置 xgw routing（xgw route add），使 peer 的消息直接路由到新 agent
3. 配置 agent 层 routing（per-peer / per-agent 等）
4. 启动 agent（xar start）

创建完成后，peer 的消息会直接发给新 agent，不再经过你。

## 路由切换

当用户说"转给 X"时，调用 xgw route add 修改路由，使后续消息直接到达目标 agent。

## 交互风格

- 简洁直接，不啰嗦
- 根据用户的 memory 中记录的偏好调整风格
- 执行操作前简要说明将要做什么
- 操作完成后给出简短确认

## 工具使用

你通过 bash_exec 调用系统命令。常用命令：
- `xar list` / `xar status` — 查看 agent 状态
- `xar init` / `xar start` / `xar stop` — 管理 agent 生命周期
- `xgw route add/remove/list` — 管理消息路由
- `xgw channel add/remove/list` — 管理渠道实例
- `xgw channel pair` — 配对新渠道（验证 credentials、设置 webhook 等）
- `xgw agent add/remove/list` — 管理 agent inbox 注册
- `thread push` — 向其他 agent 发送消息
- `thread peek` — 查看 thread 内容（不消费）
- `theclaw-status.sh` — 查看系统全局状态
- `theclaw-health.sh` — 健康检查

## 新用户引导

当你发现 memory/user-<peer_id>.md 不存在时，说明这是一个新用户。
请自然地引导对话，了解用户的需求和偏好，但不要像问卷一样逐条询问。
在对话过程中逐步收集以下信息并记录到 memory 文件：
- 语言偏好
- 回复风格偏好
- 主要使用场景
- 是否需要创建专用 agent
```

---

## Admin 的 USAGE.md

```markdown
# Admin — 使用说明

Admin 是 TheClaw 的默认入口 agent。没有匹配到特定 user agent 的外部消息会路由到 admin。

## 能力

- 日常对话和问答
- 系统状态查询
- 创建、管理 user agent（含 xgw routing 配置）
- 将请求转发给合适的 system agent
- 新用户 onboarding 引导
- 路由切换（"转给 X"）

## 交互方式

直接发消息即可。Admin 会判断自己处理还是转发给其他 agent。

## 创建 User Agent

告诉 admin 你想创建什么样的 agent，admin 会引导你完成创建并配置路由，
创建后你的消息会直接发给新 agent。

## 路由切换

- "转给 coder" — 后续消息直接路由到 coder
- "转给 admin" — 后续消息路由回 admin
```

---

## 渠道管理

admin 还负责帮助 peer 接入新的 IM 渠道。渠道接入需要三步：添加配置、配对验证、配置路由。

### 接入新渠道

peer 通过与 admin 对话请求接入新渠道：

```
Peer:  我想把飞书也接进来
Admin: 好的，接入飞书需要以下信息：
       - App ID
       - App Secret
       - Verification Token
       你可以在飞书开放平台创建一个机器人应用获取这些。
Peer:  App ID 是 cli_xxx，Secret 是 yyy，Token 是 zzz
Admin: 正在配置飞书渠道...
       1) 添加渠道配置 ✓
       2) 验证 credentials 并配对 ✓
          Bot 名称: TheClaw助手
          消息接收模式: webhook
       3) 配置路由: 飞书消息默认路由到 admin ✓
       飞书渠道已接入。
```

admin 执行的操作：

```bash
# 1. 添加渠道配置
xgw channel add --id feishu-main --type feishu \
  --set app_id=cli_xxx --set app_secret=yyy --set verification_token=zzz

# 2. 配对验证（验证 credentials、注册 webhook）
xgw channel pair --id feishu-main

# 3. 配置路由（新渠道默认路由到 admin）
xgw route add --channel feishu-main --peer "*" --agent admin
```

如果 peer 希望新渠道直接路由到某个 user agent，admin 在第 3 步配置对应的路由规则即可。

### 渠道健康检查

```bash
xgw channel health --json
```

admin 可以主动检查渠道状态，也可以在 peer 反馈"消息收不到"时排查。

---

## 与其他 System Agent 的协作

### Admin → Warden

场景：peer 询问安全状况，或 admin 发现异常需要 warden 介入。

```
admin → thread push → warden inbox
        source: internal:dm:default:admin
        content: { "text": "请检查最近 1 小时的异常行为", "callback": {...} }
```

### Admin → Maintainer

场景：peer 请求系统升级，或 admin 发现组件异常。

```
admin → thread push → maintainer inbox
        source: internal:dm:default:admin
        content: { "text": "pai 组件需要升级到 0.6.0", "callback": {...} }
```

### Admin → Evolver

场景：peer 请求优化建议，或 admin 转发 peer 的改进意见。

```
admin → thread push → evolver inbox
        source: internal:dm:default:admin
        content: { "text": "用户反馈回复太慢，请分析优化", "callback": {...} }
```

### Warden/Maintainer/Evolver → Admin

其他 system agent 需要通知 peer 时，通过 admin 中转：

```
warden → thread push → admin inbox
         source: internal:dm:default:warden
         content: { "text": "检测到 agent coder 的 LLM 调用量异常飙升，已暂停该 agent", "notify_peer": "alice" }
```

admin 收到后，根据 `notify_peer` 找到对应 peer 的对话 thread，将消息转述给 peer。

---

## 配置

```json
// admin config.json
{
  "agent_id": "admin",
  "kind": "system",
  "pai": {
    "provider": "openai",
    "model": "gpt-4o"
  },
  "routing": {
    "default": "per-peer"
  },
  "admin": {
    "usage_cache_ttl": 3600,
    "onboarding_enabled": true
  }
}
```

---

## 安全边界

- admin 可以创建/启停 user agent 并配置其 xgw routing，但不能创建/启停 system agent（system agent 只能通过 `theclaw setup` 管理）
- admin 可以读取其他 agent 的 USAGE.md，但不能读取 IDENTITY.md（内部 system prompt 不对外暴露）
- admin 转发消息时保留原始 peer 信息（`forwarded_from`），目标 agent 知道请求来源
- admin 不能直接修改其他 agent 的配置文件，只能通过 xar CLI 和 xgw CLI 命令操作
- user agent 也可以执行 `xgw route add`（用于"转给 X"），但只能修改自己当前服务的 peer 的路由
