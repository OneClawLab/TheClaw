# 需求文档：TheClaw CLI

## 简介

TheClaw 是一个 agent 运行时平台的组装、配置与观测入口 CLI 工具。它作为薄壳层编排各组件的安装与配置，自身不实现业务逻辑。setup 完成后各组件独立运行，theclaw 仅在安装、升级、全局状态查看时介入。

## 术语表

- **TheClaw_CLI**：theclaw 命令行工具本身
- **Component**：被 theclaw 管理的外部工具（如 pai、xgw、notifier、agent 等）
- **Profile**：声明 setup 行为的 YAML 配置文件，包含占位符变量
- **ComponentsYaml**：声明所有组件版本与安装方式的 `components.yaml` 文件
- **Placeholder**：Profile 中形如 `${VAR}` 的变量，需在 setup 时交互式填充
- **Setup**：系统初始化流程，包括组件安装、配置写入、服务启动
- **Upgrade**：将已安装组件升级到 components.yaml 中声明的目标版本
- **Status**：聚合各组件运行状态的全局视图
- **ObservabilityScript**：放在 `scripts/` 目录下的纯 bash 可观测性脚本
- **THECLAW_HOME**：theclaw 数据根目录，默认 `~/.theclaw`

---

## 需求

### 需求 1：组件管理（components.yaml 驱动）

**用户故事：** 作为系统管理员，我希望通过 `components.yaml` 声明所有组件的版本和安装方式，以便 theclaw 能自动检测、安装和升级各组件，而不依赖 package.json dependencies。

#### 验收标准

1. THE ComponentsYaml SHALL 支持 `schema_version`、`components` 两个顶层字段，每个组件包含 `version`、`command`、`install` 三个字段
2. WHEN TheClaw_CLI 读取 ComponentsYaml 时，THE TheClaw_CLI SHALL 解析所有组件定义并构建组件列表
3. IF ComponentsYaml 文件不存在或格式不合法，THEN THE TheClaw_CLI SHALL 返回退出码 1 并输出描述性错误信息
4. WHEN TheClaw_CLI 检测组件是否已安装时，THE TheClaw_CLI SHALL 通过 `which <command>` 判断命令是否存在
5. WHEN TheClaw_CLI 检测已安装组件版本时，THE TheClaw_CLI SHALL 执行 `<command> --version` 并解析输出中的版本号
6. IF 组件未安装或版本不匹配，THEN THE TheClaw_CLI SHALL 执行 `install` 字段中的完整 shell 命令进行安装

---

### 需求 2：`theclaw setup` 命令

**用户故事：** 作为系统管理员，我希望通过 `theclaw setup` 一键完成整个平台的初始化，以便快速搭建可运行的 agent 运行时环境。

#### 验收标准

1. WHEN 用户执行 `theclaw setup` 时，THE TheClaw_CLI SHALL 按顺序执行：检测安装组件、加载 profile、配置 pai providers、初始化 agents、启动 notifier daemon、配置启动 xgw、启动 agents、执行 smoke test
2. WHEN `--profile <name>` 参数被指定时，THE TheClaw_CLI SHALL 在 `profiles/` 目录下查找 `<name>.yaml` 文件；WHEN `--profile <path>` 为文件路径时，THE TheClaw_CLI SHALL 直接加载该路径的文件
3. WHERE `--profile` 参数未指定，THE TheClaw_CLI SHALL 使用 `standard` 作为默认 profile
4. WHEN Profile 中存在 `${VAR}` 占位符时，THE TheClaw_CLI SHALL 交互式提示用户输入每个占位符的值
5. WHEN setup 步骤已完成（记录在 `~/.config/theclaw/config.json`）时，THE TheClaw_CLI SHALL 跳过该步骤，除非指定了 `--reset`
6. WHERE `--reset` 参数被指定，THE TheClaw_CLI SHALL 清除已有配置并重新执行所有 setup 步骤
7. WHEN setup 成功完成时，THE TheClaw_CLI SHALL 返回退出码 0
8. IF 组件安装失败或配置错误，THEN THE TheClaw_CLI SHALL 返回退出码 1 并输出失败原因
9. IF 参数格式错误（如 profile 文件不存在），THEN THE TheClaw_CLI SHALL 返回退出码 2 并输出参数错误说明
10. WHEN setup 完成时，THE TheClaw_CLI SHALL 将 profile 名称和完成时间写入 `~/.config/theclaw/config.json`

---

### 需求 3：Profile 加载与占位符填充

**用户故事：** 作为系统管理员，我希望通过 profile 文件声明 setup 行为，并在初始化时交互式填充环境变量，以便灵活配置不同环境。

#### 验收标准

1. THE TheClaw_CLI SHALL 支持解析 YAML 格式的 profile 文件
2. WHEN Profile 文件包含 `${VAR}` 格式的占位符时，THE TheClaw_CLI SHALL 识别所有唯一占位符名称
3. WHEN 识别到占位符时，THE TheClaw_CLI SHALL 按占位符出现顺序逐一提示用户输入值
4. WHEN 用户输入占位符值后，THE TheClaw_CLI SHALL 将所有同名占位符替换为该值
5. IF Profile 文件不存在，THEN THE TheClaw_CLI SHALL 返回退出码 2 并提示文件路径不存在
6. IF Profile 文件格式不合法，THEN THE TheClaw_CLI SHALL 返回退出码 1 并输出解析错误详情
7. THE TheClaw_CLI SHALL 支持 `minimal` 和 `standard` 两种内置 profile

---

### 需求 4：`theclaw status` 命令

**用户故事：** 作为系统管理员或 maintainer agent，我希望通过 `theclaw status` 快速获取整个平台的运行状态，以便了解系统健康情况。

#### 验收标准

1. WHEN 用户执行 `theclaw status` 时，THE TheClaw_CLI SHALL 对每个组件调用其 status 命令并聚合结果
2. WHEN 默认输出时，THE TheClaw_CLI SHALL 以人类可读格式显示各组件名称、运行状态和关键指标
3. WHERE `--json` 参数被指定，THE TheClaw_CLI SHALL 输出结构化 JSON，包含所有组件的状态信息
4. WHERE `--deep` 参数被指定，THE TheClaw_CLI SHALL 主动探测各组件连通性（而非仅读取状态文件）
5. IF 某个组件的 status 命令执行失败，THEN THE TheClaw_CLI SHALL 在该组件状态中标记为 `error` 并继续检查其他组件
6. WHEN `--json` 输出时，THE TheClaw_CLI SHALL 包含 notifier、xgw、agents 三个顶层字段

---

### 需求 5：`theclaw upgrade` 命令

**用户故事：** 作为系统管理员，我希望通过 `theclaw upgrade` 将各组件升级到 components.yaml 中声明的目标版本，以便保持系统组件版本一致。

#### 验收标准

1. WHEN 用户执行 `theclaw upgrade` 时，THE TheClaw_CLI SHALL 读取 ComponentsYaml 并对每个组件比较当前版本与目标版本
2. WHEN 组件版本不匹配时，THE TheClaw_CLI SHALL 执行该组件的 `install` 命令进行升级
3. WHERE `--component <name>` 参数被指定，THE TheClaw_CLI SHALL 只升级指定的单个组件
4. WHERE `--dry-run` 参数被指定，THE TheClaw_CLI SHALL 只显示将要执行的操作，不实际执行任何安装或重启命令
5. WHEN 组件升级完成后，THE TheClaw_CLI SHALL 对受影响的运行中服务（xgw、notifier）执行 graceful restart
6. WHEN 输出升级结果时，THE TheClaw_CLI SHALL 显示每个组件的当前版本、目标版本和操作结果
7. IF 指定的 `--component <name>` 在 ComponentsYaml 中不存在，THEN THE TheClaw_CLI SHALL 返回退出码 2 并提示组件名称无效

---

### 需求 6：可观测性脚本

**用户故事：** 作为系统管理员或 maintainer agent，我希望通过一组纯 bash 脚本快速查看系统状态、日志和消息追踪，以便在不依赖 theclaw 命令本身的情况下诊断问题。

#### 验收标准

1. THE ObservabilityScript `theclaw-status.sh` SHALL 聚合调用各组件 status 命令并输出结果
2. THE ObservabilityScript `theclaw-logs.sh` SHALL 支持 `--lines <n>` 和 `--component <name>` 参数，显示各组件最近日志
3. THE ObservabilityScript `theclaw-threads.sh` SHALL 遍历 `${THECLAW_HOME}/agents/*/` 下所有 thread 目录并输出摘要信息
4. THE ObservabilityScript `theclaw-trace.sh` SHALL 支持 `--message-id <uuid>` 和 `--keyword <text>` 参数，追踪消息完整路径
5. THE ObservabilityScript `theclaw-health.sh` SHALL 检查 notifier、xgw、agents 运行状态及 inbox 积压情况
6. WHERE `--json` 参数被指定，THE ObservabilityScript `theclaw-health.sh` SHALL 输出结构化 JSON 供 maintainer agent 解析
7. THE ObservabilityScript SHALL 不依赖 theclaw 命令本身，仅依赖各组件的 CLI 命令

---

### 需求 7：配置管理

**用户故事：** 作为系统管理员，我希望 theclaw 将自身配置存储在标准位置，并通过环境变量支持自定义路径，以便在不同环境中灵活部署。

#### 验收标准

1. THE TheClaw_CLI SHALL 将自身配置存储在 `~/.config/theclaw/config.json`
2. WHERE 环境变量 `THECLAW_CONFIG` 被设置，THE TheClaw_CLI SHALL 使用该路径作为配置文件路径
3. WHERE 环境变量 `THECLAW_HOME` 被设置，THE TheClaw_CLI SHALL 使用该路径作为数据根目录，否则使用 `~/.theclaw`
4. THE TheClaw_CLI SHALL 在配置文件中记录 `schema_version`、`profile`、`setup_completed_at`、`components_yaml_path` 字段
5. IF 配置目录不存在，THEN THE TheClaw_CLI SHALL 自动创建所需目录

---

### 需求 8：CLI 基础结构

**用户故事：** 作为开发者，我希望 theclaw 提供标准的 CLI 体验，包括帮助信息、版本显示和错误提示，以便易于使用和调试。

#### 验收标准

1. WHEN 用户执行 `theclaw --help` 时，THE TheClaw_CLI SHALL 显示所有可用命令和选项的说明
2. WHEN 用户执行 `theclaw --version` 时，THE TheClaw_CLI SHALL 显示当前版本号
3. WHEN 用户输入未知命令时，THE TheClaw_CLI SHALL 显示错误提示并建议使用 `--help`
4. THE TheClaw_CLI SHALL 使用 TypeScript + ESM 构建，运行于 Node.js 22+
5. THE TheClaw_CLI SHALL 使用 commander 库解析 CLI 参数，使用 js-yaml 解析 YAML 文件
6. THE TheClaw_CLI SHALL 通过 tsup 构建为可分发的 npm 包
