# TheClaw CLI 设计

theclaw 是系统的组装/配置/观测入口。它不是运行时依赖——setup 完成后各组件独立运行，theclaw 仅在安装、升级、全局状态查看时介入。

---

## 设计原则

1. **薄壳层**。theclaw 自身不实现业务逻辑，只编排各组件的 CLI 命令。
2. **内置 Provider 驱动**。组件版本和安装方式内置在代码中，通过 `--provider` 参数选择，不使用 package.json dependencies 也不依赖外部 components.yaml 文件。
3. **Profile 驱动初始化**。所有 setup 行为由 profile 文件声明（详见 [BootstrapDesign.md](BootstrapDesign.md)）。
4. **可观测性优先**。提供一组 status/logs/trace 脚本，让人类和 maintainer agent 都能快速了解系统状态。

---

## 包结构

```
TheClaw/
├── profiles/
│   ├── minimal.yaml          # 最简配置 profile
│   └── standard.yaml         # 标准配置 profile
├── scripts/
│   ├── theclaw-status.sh     # 聚合各组件状态
│   ├── theclaw-logs.sh       # 聚合各组件日志
│   ├── theclaw-threads.sh    # 列出所有 thread 及摘要
│   ├── theclaw-trace.sh      # 追踪一条消息的完整路径
│   └── theclaw-health.sh     # 健康检查（供 maintainer agent 调用）
├── src/
│   ├── index.ts              # Entry point, CLI parsing & dispatch
│   ├── commands/
│   │   ├── setup.ts          # theclaw setup
│   │   ├── status.ts         # theclaw status
│   │   └── upgrade.ts        # theclaw upgrade
│   ├── profile-loader.ts     # Profile YAML 解析、占位符填充
│   ├── component-manager.ts  # 组件检测与安装（provider 内置在代码中）
│   └── types.ts              # 共享类型定义
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── SPEC.md
```

theclaw 本身也是一个 npm 包（`theclaw` 命令），但它不把其他组件声明为 npm dependencies。组件的版本和安装方式内置在代码中（`src/components.ts`），通过 `--provider` 参数选择。

---

## Components Provider

"怎么安装"由 provider 决定，内置在 theclaw 代码中。通过 `--provider` 参数选择，默认使用 `registry`。

```bash
theclaw setup --provider registry   # 默认
theclaw setup --provider local
theclaw upgrade --provider local
```

### 内置 Provider

**`registry`**（默认）

从 npm registry 安装：

```
npm install -g @theclaw/<name>@<version>
```

**`local`**

从本地源码构建并 link，依赖环境变量 `THECLAW_SOURCE_ROOT`：

```
cd ${THECLAW_SOURCE_ROOT}/<name> && npm run build && npm link
```

版本检测在 local 模式下只做 warning，不强制匹配（开发时版本号不重要）。

### 扩展性

未来新增 provider（如 `brew`、`cargo`、`binary`）只需在代码中添加实现，`components.yaml` 无需改动。

---

## CLI 命令

### `theclaw setup`

系统初始化。详细流程见 [BootstrapDesign.md](BootstrapDesign.md)。

```bash
theclaw setup [--profile <name|path>] [--reset]
```

| 参数 | 说明 |
|------|------|
| `--profile` | Profile 名称（在 `profiles/` 下查找）或文件路径。默认 `standard` |
| `--reset` | 清除已有配置重新初始化 |

**执行摘要**：

1. 读取内置 provider 中的组件列表，检测并安装缺失组件
2. 加载 profile，交互式填充 `${VAR}` 占位符
3. 配置 pai providers
4. 初始化 agents（admin → warden → maintainer → evolver）
5. 启动 notifier daemon
6. 配置并启动 xgw
7. 启动 agents（注册 inbox 订阅）
8. Smoke test

**幂等性**：重复执行跳过已完成步骤（除非 `--reset`）。详见 BootstrapDesign.md 幂等性规则表。

**退出码**：`0` 成功，`1` 组件安装失败或配置错误，`2` 参数错误。

---

### `theclaw status`

聚合各组件状态，给出系统全局视图。

```bash
theclaw status [--json] [--deep]
```

| 参数 | 说明 |
|------|------|
| `--json` | 结构化 JSON 输出 |
| `--deep` | 深度检查（探测各组件连通性，而非仅读状态文件） |

**执行逻辑**：

```bash
# 对每个组件调用其 status 命令
notifier status --json
xgw status --json
agent status --json        # 列出所有 agent 及其状态
agent status admin --json  # 各 agent 详情
```

**默认输出（人类可读）**：

```
TheClaw Status
──────────────────────────────────
notifier    running   pid=12345
xgw         running   pid=12346   channels: telegram-main ✓
agents:
  admin       active    inbox: 0 pending
  warden      active    inbox: 0 pending
  maintainer  active    inbox: 0 pending
  evolver     active    inbox: 0 pending
──────────────────────────────────
```

**JSON 输出**：

```json
{
  "notifier": { "running": true, "pid": 12345 },
  "xgw": {
    "running": true,
    "pid": 12346,
    "channels": [
      { "id": "telegram-main", "type": "telegram", "healthy": true }
    ]
  },
  "agents": [
    {
      "id": "admin",
      "kind": "system",
      "started": true,
      "inbox_pending": 0,
      "last_activity": "2026-03-20T10:30:00Z"
    }
  ]
}
```

**`--deep` 模式**：除了读取状态文件，还主动探测：
- notifier：写一个 test task 并等待执行
- xgw：对每个 channel 调用 health check
- agent：检查 inbox thread 是否可读写

---

### `theclaw upgrade`

升级系统组件。

```bash
theclaw upgrade [--component <name>] [--dry-run]
```

| 参数 | 说明 |
|------|------|
| `--component` | 只升级指定组件。省略则升级全部 |
| `--dry-run` | 只显示将要执行的操作，不实际执行 |

**执行逻辑**：

1. 读取内置 provider 中各组件的目标版本
2. 对每个组件执行 `<command> --version`，比较当前版本与目标版本
3. 版本不匹配的组件，执行 `install` 字段中的安装命令（npm install -g 会自动升级）
4. 升级完成后，对受影响的运行中组件执行 graceful restart：
   - xgw：`xgw stop` → `xgw start`
   - notifier：`notifier stop` → `notifier start`
   - agent：无需重启（非常驻进程，下次 dispatch 自动使用新版本）

**升级 theclaw 自身**：`components.yaml` 不包含 theclaw 自身。theclaw 的升级通过 `npm install -g theclaw` 手动完成（或由 maintainer agent 执行）。升级后 `components.yaml` 随新版本更新。

**输出**：

```
Checking components...
  pai       0.5.0 → 0.5.0  (up to date)
  notifier  0.2.0 → 0.3.0  (upgrading...)  ✓
  xgw       0.1.0 → 0.1.0  (up to date)
  ...

Restarting affected services...
  notifier  stop → start  ✓

Upgrade complete.
```

---

## 配置数据边界

theclaw 只管理自己的配置，不侵入各组件的配置空间：

| 数据 | 位置 | 管理者 |
|------|------|--------|
| theclaw 自身配置 | `~/.config/theclaw/config.json` | theclaw |
| 使用的 profile 记录 | `~/.config/theclaw/config.json` | theclaw |
| pai 配置 | `~/.config/pai/default.json` | pai（setup 时由 theclaw 通过 `pai model config` 写入） |
| xgw 配置 | `~/.config/xgw/config.yaml` | xgw（setup 时由 theclaw 直接写入） |
| agent 配置 | `~/.theclaw/agents/<id>/config.yaml` | agent（setup 时由 theclaw 通过 `agent init` 写入） |
| notifier 数据 | `~/.local/share/notifier/` | notifier |

`~/.config/theclaw/config.json` 内容：

```json
{
  "schema_version": "1",
  "profile": "standard",
  "setup_completed_at": "2026-03-20T10:00:00Z",
  "components_yaml_path": "/usr/lib/node_modules/theclaw/components.yaml"
}
```

---

## 可观测性脚本

放在 `scripts/` 目录下，随 theclaw 包分发。这些脚本是纯 bash，不依赖 theclaw 运行时，人类和 maintainer agent 都可以直接调用。

### `theclaw-status.sh`

聚合各组件状态的快捷脚本。等价于 `theclaw status` 但不依赖 theclaw 命令本身。

```bash
#!/bin/bash
echo "=== notifier ==="
notifier status
echo "=== xgw ==="
xgw status
echo "=== agents ==="
agent list
for id in $(agent list --json | jq -r '.[].id'); do
  echo "--- $id ---"
  agent status "$id"
done
```

### `theclaw-logs.sh`

聚合查看各组件最近日志。

```bash
theclaw-logs.sh [--lines <n>] [--component <name>]
```

默认显示每个组件最近 20 行日志：
- notifier: `~/.local/share/notifier/logs/notifier.log`
- xgw: `~/.local/share/xgw/logs/xgw.log`
- agents: `~/.theclaw/agents/*/logs/agent.log`

### `theclaw-threads.sh`

列出系统中所有 thread 及其摘要信息。

```bash
theclaw-threads.sh [--agent <id>]
```

遍历 `~/.theclaw/agents/*/` 下的所有 thread 目录，对每个调用 `thread info --json`，汇总输出：
- thread 路径
- 事件总数
- 订阅者数量
- 最近事件时间

### `theclaw-trace.sh`

追踪一条消息从入站到出站的完整路径。给定一个 event id 或消息关键词，在各组件日志和 thread 事件中搜索关联记录。

```bash
theclaw-trace.sh --message-id <uuid>
theclaw-trace.sh --keyword <text> [--since <time>]
```

搜索路径：
1. xgw 日志（入站记录）
2. agent inbox thread（`thread peek --filter "content LIKE '%<keyword>%'"`)
3. agent 对话 thread（路由后的目标 thread）
4. xgw 日志（出站记录）

输出时间线格式：

```
10:30:01.456  xgw      inbound   channel=telegram-main peer=alice msg_id=abc123
10:30:01.500  thread   inbox     agent=admin event_id=42
10:30:01.600  agent    route     admin → threads/peers/telegram-main-alice
10:30:02.100  pai      chat      tokens=1234 duration=1.5s
10:30:02.200  thread   push      agent=admin thread=peers/telegram-main-alice event_id=15
10:30:02.300  agent    deliver   channel=telegram-main peer=alice
10:30:02.400  xgw      outbound  channel=telegram-main peer=alice
```

### `theclaw-health.sh`

健康检查脚本，供 maintainer agent 定期调用。

```bash
theclaw-health.sh [--json]
```

检查项：
- notifier daemon 是否运行
- xgw daemon 是否运行，各 channel 是否 healthy
- 各 agent 是否已注册 inbox 订阅
- 各 agent inbox 是否有积压（pending 消息数超过阈值）
- 磁盘空间（日志和 thread 数据目录）

JSON 输出供 maintainer agent 解析决策：

```json
{
  "healthy": false,
  "checks": [
    { "name": "notifier", "status": "ok" },
    { "name": "xgw", "status": "ok" },
    { "name": "agent:admin", "status": "ok" },
    { "name": "agent:warden", "status": "warning", "detail": "inbox pending: 15" },
    { "name": "disk", "status": "ok", "detail": "logs: 120MB, threads: 45MB" }
  ]
}
```

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `THECLAW_HOME` | 数据根目录 | `~/.theclaw` |
| `THECLAW_CONFIG` | theclaw 配置文件路径 | `~/.config/theclaw/config.json` |

theclaw 不引入新的全局环境变量给其他组件——各组件的环境变量由各自 SPEC 定义。

---

## 技术栈

与其他组件一致：

- TypeScript + ESM (Node 22+)
- 构建: tsup
- CLI 解析: commander
- YAML 解析: js-yaml（profile 和 components.yaml）
- 测试: vitest（仅测试 profile-loader、component-manager 等自身逻辑）

theclaw 不需要 SQLite、better-sqlite3 等重依赖。它是一个轻量的编排层。
