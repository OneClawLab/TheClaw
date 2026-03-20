# Bootstrap 设计 — 系统初始化与 Profile

本文档描述 TheClaw 系统从零到可用的初始化流程。核心思路：TheClaw 是组装/配置器，setup 完成后退场。

---

## 设计原则

1. **TheClaw 是安装器，不是运行时依赖**。setup 完成后，系统运行不需要 theclaw 命令参与。
2. **Profile 驱动**。所有初始化行为由 profile 文件声明，setup 只是 profile 的执行器。
3. **幂等性**。重复执行 setup 时，已存在的配置/agent 跳过（除非 `--reset`）。
4. **占位符交互填充**。profile 中的敏感信息用 `${VAR}` 占位符，setup 时交互式填充或从环境变量读取。

---

## Profile 格式

Profile 是一份 YAML 声明式配置模板，描述"我要一个什么样的 TheClaw 实例"。

```yaml
# profile: standard.yaml
meta:
  name: standard
  description: "单用户 + Telegram + 全部 system agents"
  version: "1.0"

# pai LLM provider 配置
pai:
  providers:
    - name: openai
      provider: openai
      apiKey: "${OPENAI_API_KEY}"
      defaultModel: gpt-4o

# xgw 网关配置
xgw:
  gateway:
    host: 127.0.0.1
    port: 18790
  channels:
    - id: telegram-main
      type: telegram
      token: "${TELEGRAM_BOT_TOKEN}"
  routing:
    - channel: telegram-main
      peer: "*"
      agent: admin

# agent 配置
agents:
  - id: admin
    kind: system
    pai:
      provider: openai
      model: gpt-4o
    routing:
      default: per-peer
    identity: |
      你是 TheClaw 系统的管理员 agent。你负责与用户直接交互，
      管理其他 agent，转发用户请求到合适的 system agent。
    usage: |
      Admin 是 TheClaw 的入口 agent。你可以：
      - 直接对话（日常问答、任务委派）
      - 请求创建新的 user agent
      - 查询系统状态

  - id: warden
    kind: system
    pai:
      provider: openai
      model: gpt-4o
    routing:
      default: per-agent
    identity: |
      你是 TheClaw 系统的安全守卫 agent。你负责监控系统行为，
      检测异常，保障安全。
    usage: |
      Warden 负责系统安全。它会：
      - 监控其他 agent 的行为是否越界
      - 检测资源异常（LLM 调用量飙升等）
      - 发现问题时通知 admin 或直接暂停相关 agent

  - id: maintainer
    kind: system
    pai:
      provider: openai
      model: gpt-4o
    routing:
      default: per-agent
    identity: |
      你是 TheClaw 系统的维护 agent。你负责系统健康检查、
      错误恢复、组件升级。
    usage: |
      Maintainer 负责系统运维。它会：
      - 定期健康检查各组件状态
      - 感知其他 agent 的 error event 并决定是否重试
      - 协调组件升级

  - id: evolver
    kind: system
    pai:
      provider: openai
      model: gpt-4o
    routing:
      default: per-agent
    identity: |
      你是 TheClaw 系统的进化 agent。你负责观察系统行为，
      发现优化机会，提出改进提案。
    usage: |
      Evolver 负责系统自进化。它会：
      - 分析日志和事件流发现优化点
      - 提出改进提案（分级审批）
      - 自动执行低风险优化

# notifier daemon 配置
notifier:
  auto_start: true    # setup 时自动启动 daemon

# 容错默认值
defaults:
  retry:
    max_attempts: 3
  deliver:
    max_attempts: 3
```

### Profile 段说明

| 段 | 对应组件 | setup 时的动作 |
|----|---------|---------------|
| `meta` | theclaw | 记录到 theclaw 自身配置 |
| `pai.providers[]` | pai | 调用 `pai model config --add` 逐个添加 |
| `xgw` | xgw | 写入 `~/.config/xgw/config.yaml` |
| `agents[]` | agent | 逐个 `agent init` + 写 config.yaml/IDENTITY.md/USAGE.md |
| `notifier` | notifier | `notifier start` |
| `defaults` | agent | 写入各 agent 的 config.yaml |

### 占位符

`${VAR}` 格式的值在 setup 时按以下优先级填充：
1. 环境变量（`export OPENAI_API_KEY=sk-...`）
2. 交互式提示（`Enter your OpenAI API key:`）
3. 未填充则报错退出

---

## `theclaw setup` 流程

```bash
theclaw setup [--profile <name|path>] [--reset]
```

默认 profile: `standard`。`--reset` 清除已有配置重新初始化。

### 执行步骤

```
1. 检测组件
   ├── which pai && pai --version
   ├── which thread && thread --version
   ├── which notifier && notifier --version
   ├── which xgw && xgw --version
   └── which agent && agent --version
   未安装的组件：读取 components.yaml，按指定方式安装

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
   ├── agent init <id> --kind <kind>
   ├── 写入 config.yaml（从 profile 生成）
   ├── 写入 IDENTITY.md（从 profile.agents[].identity 生成）
   ├── 写入 USAGE.md（从 profile.agents[].usage 生成）
   └── 写入 defaults（retry 等配置项合并到 config.yaml）

6. 启动 notifier daemon
   └── notifier start

7. 配置并启动 xgw
   ├── 写入 ~/.config/xgw/config.yaml（从 profile.xgw 生成，补充 agents inbox 路径）
   └── xgw start

8. 启动 agents
   └── 对每个 agent: agent start <id>

9. Smoke test
   ├── notifier status → 确认 running
   ├── xgw status → 确认 running + channels healthy
   ├── agent status → 确认各 agent 已注册订阅
   └── 输出摘要
```

### 幂等性规则

| 场景 | 行为 |
|------|------|
| agent 已存在 | 跳过 init，但更新 config.yaml/IDENTITY.md/USAGE.md（如果 profile 内容有变化） |
| pai provider 已配置 | 覆盖更新（`--add` 支持替换同名配置） |
| xgw 已在运行 | 先 stop，更新配置，再 start |
| notifier 已在运行 | 跳过 |
| `--reset` | 删除 `~/.theclaw/` 和各组件配置，从头开始 |

---

## "退场"原则

setup 完成后，theclaw CLI 不参与系统运行。各组件独立运行：

- notifier daemon 监听任务
- xgw daemon 监听渠道消息
- agent 由 notifier dispatch 按需启动

theclaw 仅在以下场景重新介入：
- 全新安装：`theclaw setup`
- 大版本升级：`theclaw upgrade`
- 配置重置：`theclaw setup --reset`
- 查看全局状态：`theclaw status`

日常运维（健康检查、错误恢复、组件小版本升级）由 maintainer agent 通过直接调用各组件 CLI 完成。系统进化（优化 prompt、调整配置）由 evolver agent 完成。

---

## 预置 Profile

### minimal

单用户 + TUI + admin only。最快体验，无需外部 IM 配置。

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
  channels: []       # 无外部渠道，仅 TUI
  routing: []

agents:
  - id: admin
    kind: system
    pai:
      provider: openai
      model: gpt-4o
    routing:
      default: per-agent    # 单用户无需 per-peer
    identity: |
      你是 TheClaw 的管理员 agent。
    usage: |
      Admin 是 TheClaw 的入口。直接对话即可。

notifier:
  auto_start: true

defaults:
  retry:
    max_attempts: 3
  deliver:
    max_attempts: 3
```

### standard

见本文档开头的完整 profile 示例。
