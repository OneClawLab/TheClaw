# Maintainer Agent 设计 — 容错与运维（草案，尚未同步更新相关方）

Maintainer 是 TheClaw 的运维 agent，负责系统健康检查、错误恢复、组件升级协调。与 warden 的职责边界：warden 关注安全（危险行为检测与阻止），maintainer 关注可用性（组件是否正常运行、错误是否需要恢复、版本是否需要升级）。

---

## 定位

- 系统可用性的守护者：确保各组件持续正常运行
- 错误恢复的决策者：感知 agent error event，判断是否需要重试或人工介入
- 组件升级的执行者：协调各组件的版本升级（日常小版本，非 `theclaw setup --reset` 级别）
- 不直接接收外部 peer 消息，通过 inbox 接收 admin 转发的运维请求和 agent error 通知

---

## 运行模式

与 warden 类似，maintainer 同时使用事件驱动和定时巡检两种触发机制：

1. **事件驱动**（inbox）：接收 agent error hook 通知、admin 转发的运维请求
2. **定时巡检**（notifier timer）：周期性健康检查

```json
// maintainer config.json
{
  "agent_id": "maintainer",
  "kind": "system",
  "pai": { "provider": "openai", "model": "gpt-4o" },
  "routing": { "default": "per-agent" },
  "run_on_empty_inbox": true,
  "maintenance": {
    "health_check": {
      "interval_cron": "*/10 * * * *",
      "full_check_cron": "0 */6 * * *"
    },
    "recovery": {
      "auto_restart_daemons": true,
      "auto_retry_stuck_agents": true,
      "stuck_threshold": 50
    },
    "upgrade": {
      "auto_minor": false,
      "check_interval_cron": "0 4 * * *"
    }
  }
}
```

---

## 健康检查

### 检查项

maintainer 的健康检查覆盖系统所有层级：

| 层级 | 检查项 | 命令 | 健康判定 |
|------|--------|------|---------|
| daemon | notifier 是否运行 | `notifier status --json` | `running: true` |
| daemon | xgw 是否运行 | `xgw status --json` | `running: true` |
| channel | 各渠道是否连通 | `xgw channel health --json` | 所有 channel `healthy: true` |
| agent | 各 agent 是否已注册 | `xar status --json` | 所有 agent `started: true` |
| agent | inbox 是否积压 | `xar status <id> --json` | `inbox_pending < stuck_threshold` |
| agent | 最近是否有 error event | `thread peek` 检查 error 事件 | 无近期 error |
| storage | 磁盘空间 | `df`, `du` | 使用率 < 90% |

### status --json 统一 schema

各组件的 `status --json` 输出需要遵循统一的顶层结构，方便 maintainer 解析：

```json
{
  "component": "<component_name>",
  "version": "<version>",
  "status": "ok | degraded | error | stopped",
  "details": { ... }
}
```

| status 值 | 含义 |
|-----------|------|
| `ok` | 正常运行 |
| `degraded` | 运行中但部分功能异常（如某个 channel 不健康） |
| `error` | 运行中但核心功能异常 |
| `stopped` | 未运行 |

各组件 `details` 内容各异，但顶层 `component`/`version`/`status` 统一。

**具体 schema**：

notifier:
```json
{
  "component": "notifier",
  "version": "0.3.0",
  "status": "ok",
  "details": { "pid": 12345, "uptime_seconds": 86400, "pending_tasks": 0, "active_timers": 5 }
}
```

xgw:
```json
{
  "component": "xgw",
  "version": "0.1.0",
  "status": "ok",
  "details": {
    "pid": 12346,
    "uptime_seconds": 86400,
    "channels": [
      { "id": "telegram-main", "type": "telegram", "healthy": true, "paired": true }
    ],
    "routes": 3
  }
}
```

agent (单个):
```json
{
  "component": "agent",
  "version": "0.1.0",
  "status": "ok",
  "details": {
    "agent_id": "admin",
    "kind": "system",
    "started": true,
    "inbox_pending": 0,
    "last_run_at": "2026-03-20T10:30:00Z",
    "last_error_at": null,
    "thread_count": 5
  }
}
```

### 健康检查流程

```
maintainer run (定时触发)
  │
  ├── 1. notifier status --json → 检查 daemon
  ├── 2. xgw status --json → 检查 gateway + channels
  ├── 3. xar list --json → 遍历所有 agent
  │      └── 对每个 agent:
  │          ├── xar status <id> --json → 检查状态
  │          └── thread peek inbox → 检查积压和 error
  ├── 4. df / du → 检查磁盘
  │
  ├── 5. 汇总结果，写入 maintainer 的 health thread
  │
  └── 6. 发现异常 → 执行恢复动作 或 通知 owner
```

### 健康检查结果持久化

```
~/.theclaw/agents/maintainer/
├── threads/
│   └── health/               # 健康检查记录 thread
├── memory/
│   ├── agent.md              # maintainer 的运维笔记
│   └── health-state.json     # 上次健康检查状态快照
└── ...
```

`health-state.json` 记录上次检查的各组件状态，用于对比检测状态变化（从 ok 变为 error 时触发告警，持续 error 时不重复告警）。

```json
{
  "last_check_at": "2026-03-20T10:30:00Z",
  "components": {
    "notifier": { "status": "ok", "since": "2026-03-20T00:00:00Z" },
    "xgw": { "status": "ok", "since": "2026-03-20T00:00:00Z" },
    "agent:admin": { "status": "ok", "since": "2026-03-20T00:00:00Z" },
    "agent:warden": { "status": "ok", "since": "2026-03-20T00:00:00Z" },
    "agent:coder": { "status": "degraded", "since": "2026-03-20T09:15:00Z", "detail": "inbox_pending: 23" }
  }
}
```

---

## 错误恢复

### 错误感知

maintainer 通过两个渠道感知错误：

1. **error hook**：agent run 写 `record/error` 事件时，同时通知 maintainer inbox（与通知 warden 的机制相同）

```yaml
# agent config.yaml（所有 agent 的 defaults）
maintainer:
  notify_on_error: true
  maintainer_inbox: ~/.theclaw/agents/maintainer/inbox
```

2. **定时巡检**：健康检查发现组件异常

### 恢复决策

maintainer 收到 error 通知后，根据错误类型决定恢复策略：

| 错误类型 | 判断依据 | 恢复动作 |
|---------|---------|---------|
| daemon 挂了 | `notifier status` / `xgw status` 返回 stopped | 自动重启：`notifier start` / `xgw start` |
| agent inbox 积压 | `inbox_pending > stuck_threshold` | 向 agent 发送唤醒消息触发处理 |
| agent 持续 error | 同一 agent 短时间内多次 error | 通知 owner，建议检查 agent 配置或 IDENTITY.md |
| channel 不健康 | `xgw channel health` 返回 unhealthy | 尝试 `xgw reload`；仍不健康则通知 owner |
| 磁盘空间不足 | `df` 使用率 > 90% | 清理旧日志（rotated logs）；仍不足则通知 owner |
| agent 被 warden 停止 | agent status = stopped + 近期有 warden 告警 | 不自动恢复（warden 停止的 agent 需要 owner 确认后才能重启） |

### 恢复动作实现

```bash
# daemon 重启
xar daemon start
xgw start

# 触发 stuck agent（向其 inbox 发送唤醒消息）
xar send <id> --text "处理积压消息"

# 清理旧日志
find ~/.theclaw/agents/*/logs/ -name "*-20*.log" -mtime +7 -delete
find ~/.local/share/notifier/logs/ -name "*-20*.log" -mtime +7 -delete
find ~/.local/share/xgw/logs/ -name "*-20*.log" -mtime +7 -delete

# 清理旧 thread JSONL（rotated 的，不影响 SQLite）
find ~/.theclaw/agents/*/threads/ -name "events-20*.jsonl" -mtime +30 -delete
find ~/.theclaw/agents/*/inbox/ -name "events-20*.jsonl" -mtime +30 -delete
```

### 恢复安全边界

- maintainer 可以重启 daemon（xar、xgw）
- maintainer 可以向 agent 发送唤醒消息（处理积压）
- maintainer 不能重启被 warden 停止的 agent（需要 owner 确认）
- maintainer 不能修改 agent 的 IDENTITY.md 或 config.json（那是 evolver 或 owner 的职责）
- maintainer 可以清理旧日志和 rotated 文件，但不能删除当前活跃的日志或 thread 数据

---

## 组件升级

### 升级检测

maintainer 定期检查各组件是否有新版本可用：

```bash
# 读取 components.yaml 中的目标版本
# 对比各组件当前版本
pai --version
notifier --version
thread --version
# ...
```

如果 `components.yaml` 中的版本高于当前安装版本，说明有升级可用（`components.yaml` 随 theclaw 包更新）。

### 升级执行

maintainer 不直接执行升级，而是通过 `theclaw upgrade` 命令：

```bash
# 升级单个组件
theclaw upgrade --component <name>

# 升级全部
theclaw upgrade
```

升级策略：

| 场景 | 行为 |
|------|------|
| `auto_minor: true` | maintainer 自动执行 `theclaw upgrade`，完成后通知 owner |
| `auto_minor: false`（默认） | maintainer 检测到新版本后通知 owner，等待确认 |
| 大版本升级 | 始终通知 owner，不自动执行 |

### 升级通知

```bash
thread push \
  --thread ~/.theclaw/agents/admin/inbox \
  --source "internal:dm:default:maintainer" \
  --type message \
  --content '{"text":"组件升级可用: pai 0.5.0 → 0.6.0, thread 0.3.0 → 0.4.0。是否执行升级？","notify_peer":"alice","action":"upgrade_available"}'
```

---

## 与其他 Agent 的协作

### Warden → Maintainer

warden 停止了一个 agent 后，可能通知 maintainer 记录事件：

```
warden → thread push → maintainer inbox
         source: internal:dm:default:warden
         content: { "text": "已停止 agent coder（高危命令），请记录并等待 owner 确认后恢复" }
```

maintainer 记录到 health thread，不自动恢复。

### Maintainer → Admin

maintainer 需要通知 owner 时，统一通过 admin 中转：

```
maintainer → thread push → admin inbox
             source: internal:dm:default:maintainer
             content: { "text": "...", "notify_peer": "alice" }
```

### Admin → Maintainer

owner 通过 admin 向 maintainer 发送运维指令：

```
admin → thread push → maintainer inbox
        source: internal:dm:default:admin
        content: { "text": "执行系统升级" }
```

---

## Maintainer 的 IDENTITY.md

```markdown
# Maintainer Agent

你是 TheClaw 系统的运维 agent。你的职责是确保系统持续正常运行。

## 核心职责

1. 定期健康检查各组件状态
2. 感知 agent error event，判断是否需要恢复
3. daemon 挂了自动重启
4. agent inbox 积压时触发处理
5. 检测组件新版本，协调升级
6. 清理旧日志和 rotated 文件

## 健康检查

每次你被唤醒时，执行健康检查：

1. `notifier status --json` — 检查 notifier daemon
2. `xgw status --json` — 检查 xgw daemon 和 channels
3. `xar list --json` + 逐个 `xar status <id> --json` — 检查所有 agent
4. 检查磁盘使用
5. 对比 health-state.json，检测状态变化
6. 更新 health-state.json
7. 状态恶化时通知 admin

## 错误恢复

收到 error 通知时：
- daemon 挂了 → 自动重启（xar daemon start / xgw start）
- agent inbox 积压 → 发送唤醒消息
- agent 持续 error → 通知 owner
- channel 不健康 → 尝试 xgw reload，仍不行则通知 owner
- 磁盘不足 → 清理旧日志，仍不足则通知 owner

**重要**：不要重启被 warden 停止的 agent。warden 停止 agent 是出于安全原因，
需要 owner 确认后才能恢复。

## 组件升级

定期检查 components.yaml 中的目标版本与当前版本是否一致。
发现新版本时通知 owner（通过 admin）。
收到 owner 确认后执行 theclaw upgrade。

## 工具使用

你通过 bash_exec 调用系统命令。常用命令：
- `notifier status --json` / `notifier start` / `notifier stop`
- `xgw status --json` / `xgw start` / `xgw stop` / `xgw reload`
- `xgw channel health --json`
- `xar status --json` / `xar status <id> --json`
- `xar send <id> --text "..."` — 向 agent 发送唤醒消息
- `theclaw-health.sh --json` — 快速健康检查
- `theclaw upgrade [--component <name>]` — 执行升级
- `du -sh ~/.theclaw/agents/*/` — 磁盘使用
- `df -h` — 磁盘空间

## 通知 owner

通过 thread push 向 admin inbox 发送通知：
```
thread push --thread ~/.theclaw/agents/admin/inbox \
  --source "internal:dm:default:maintainer" \
  --type message \
  --content '{"text":"通知内容","notify_peer":"<peer_id>"}'
```
```

---

## Maintainer 的 USAGE.md

```markdown
# Maintainer — 使用说明

Maintainer 是 TheClaw 的运维 agent，负责系统健康和可用性。

## 能力

- 定期健康检查所有组件
- daemon 挂了自动重启
- agent 错误恢复（inbox 积压处理、stuck 检测）
- 组件版本升级协调
- 旧日志清理

## 交互方式

Maintainer 主要自主运行（定时巡检 + error 事件驱动），不需要主动交互。
可以通过 admin 向 maintainer 发送指令：
- "检查系统健康" — 执行一次完整健康检查
- "执行系统升级" — 升级所有可升级组件
- "清理旧日志" — 清理 7 天前的 rotated 日志
- "重启 notifier" — 重启 notifier daemon

## 不会做的事

- 不会重启被 warden 停止的 agent（需要 owner 确认）
- 不会修改 agent 的 IDENTITY.md 或配置（那是 evolver 的职责）
```

---

## 待回写需求

| 修改 | 目标 SPEC | 说明 |
|------|----------|------|
| status --json 统一 schema | 所有组件 SPEC | 顶层 `component`/`version`/`status`/`details` 统一结构 |
| error hook 通知 maintainer | xar/SPEC.md | config.json 新增 `maintainer.notify_on_error` + `maintainer.maintainer_inbox`（与 warden notify 机制并列） |
