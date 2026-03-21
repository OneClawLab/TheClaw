# 实现计划：TheClaw CLI

## 概述

按照设计文档，将 TheClaw CLI 分为以下几个阶段实现：基础项目结构与类型定义、核心工具模块（profile-loader、component-manager、config）、三个 CLI 命令（setup、status、upgrade）、可观测性脚本，最后完成 CLI 入口与构建配置。

## 任务

- [ ] 1. 初始化项目结构与基础配置
  - 创建 `package.json`（ESM、Node 22+、commander、js-yaml、fast-check 依赖）
  - 创建 `tsconfig.json`（ESM、strict 模式）
  - 创建 `tsup.config.ts`（构建配置，输出 bin）
  - 创建 `vitest.config.ts`
  - 创建目录结构：`src/commands/`、`profiles/`、`scripts/`
  - _需求：8.4、8.5、8.6_

- [ ] 2. 定义共享类型与数据模型
  - [ ] 2.1 创建 `src/types.ts`，定义所有共享类型
    - `ComponentDef`、`ComponentsConfig`
    - `Profile`、`ProfileStep`
    - `TheClawConfig`
    - `ComponentStatus`
    - `NotifierStatus`、`XgwStatus`、`XgwChannel`、`AgentStatus`、`StatusResult`
    - `HealthCheck`、`HealthCheckResult`
    - _需求：1.1、4.6、7.4_

- [ ] 3. 实现 `src/config.ts` 配置管理模块
  - [ ] 3.1 实现配置读写函数
    - `readConfig(configPath?: string): Promise<TheClawConfig>`
    - `writeConfig(config: TheClawConfig, configPath?: string): Promise<void>`
    - 支持 `THECLAW_CONFIG` 和 `THECLAW_HOME` 环境变量覆盖
    - 配置目录不存在时自动创建（`mkdir -p`）
    - _需求：7.1、7.2、7.3、7.5_

  - [ ] 3.2 为配置读写编写属性测试
    - **属性 8：配置文件读写往返一致性**
    - **验证：需求 7.1、7.4**
    - `// Feature: theclaw-cli, Property 8: 配置文件读写往返一致性`
    - 使用 fast-check 生成随机 TheClawConfig 对象，写入临时目录后读取验证等价
    - _需求：7.1、7.4_

- [ ] 4. 实现 `src/profile-loader.ts` Profile 加载器
  - [ ] 4.1 实现 Profile 解析与占位符处理核心函数
    - `loadProfile(nameOrPath: string, profilesDir: string): Promise<Profile>`
    - `extractPlaceholders(content: string): string[]`（正则 `/\$\{([A-Z_][A-Z0-9_]*)\}/g`，返回唯一有序列表）
    - `fillPlaceholders(content: string, values: Record<string, string>): string`
    - profile 文件不存在时抛出退出码 2 的错误，格式非法时抛出退出码 1 的错误
    - _需求：3.1、3.2、3.3、3.4、3.5、3.6_

  - [ ] 4.2 为占位符提取编写属性测试
    - **属性 2：占位符提取完整性与唯一性**
    - **验证：需求 3.2、3.3**
    - `// Feature: theclaw-cli, Property 2: 占位符提取完整性与唯一性`
    - 使用 fast-check 生成含任意数量 `${VAR}` 的字符串，验证提取结果完整且无重复
    - _需求：3.2、3.3_

  - [ ] 4.3 为占位符填充编写属性测试
    - **属性 3：占位符填充完整性**
    - **属性 4：占位符填充幂等性**
    - **验证：需求 3.4**
    - `// Feature: theclaw-cli, Property 3: 占位符填充完整性`
    - `// Feature: theclaw-cli, Property 4: 占位符填充幂等性`
    - 使用 fast-check 生成模板和值映射，验证填充后无残留占位符，以及二次填充结果不变
    - _需求：3.4_

  - [ ] 4.4 创建内置 profile 文件
    - 创建 `profiles/minimal.yaml`
    - 创建 `profiles/standard.yaml`
    - _需求：3.7_

- [ ] 5. 实现 `src/component-manager.ts` 组件管理器
  - [ ] 5.1 实现 ComponentsYaml 解析与版本检测
    - `loadComponents(yamlPath: string): Promise<ComponentsConfig>`（文件不存在或格式非法时抛出退出码 1 的错误）
    - `extractVersion(output: string): string | null`（从 `--version` 输出中提取 semver，正则 `/v?(\d+\.\d+\.\d+)/`）
    - `isInstalled(command: string): Promise<boolean>`（通过 `which` 检测）
    - `getInstalledVersion(component: ComponentDef): Promise<string | null>`（执行 `<command> --version`）
    - `needsUpgrade(current: string | null, target: string): boolean`
    - _需求：1.1、1.2、1.3、1.4、1.5_

  - [ ] 5.2 为 ComponentsYaml 解析编写属性测试
    - **属性 1：ComponentsYaml 解析往返一致性**
    - **验证：需求 1.1、1.2**
    - `// Feature: theclaw-cli, Property 1: ComponentsYaml 解析往返一致性`
    - 使用 fast-check 生成随机组件定义集合，序列化为 YAML 后解析，验证等价
    - _需求：1.1、1.2_

  - [ ] 5.3 为版本号提取编写属性测试
    - **属性 5：版本号提取鲁棒性**
    - **验证：需求 1.5**
    - `// Feature: theclaw-cli, Property 5: 版本号提取鲁棒性`
    - 使用 fast-check 生成含 semver 的字符串（带前缀 `v`、多行、额外文本），验证正确提取；生成不含 semver 的字符串，验证返回 null
    - _需求：1.5_

  - [ ] 5.4 为非法 YAML 输入编写属性测试
    - **属性 12：非法 YAML 输入错误处理**
    - **验证：需求 1.3、3.6**
    - `// Feature: theclaw-cli, Property 12: 非法 YAML 输入错误处理`
    - 使用 fast-check 生成缺少必要字段的对象，验证解析函数抛出包含描述性信息的错误
    - _需求：1.3、3.6_

  - [ ] 5.5 实现组件安装函数
    - `installComponent(component: ComponentDef, dryRun?: boolean): Promise<void>`（执行 `install` 字段命令）
    - `checkAll(config: ComponentsConfig): Promise<ComponentStatus[]>`（并发检测所有组件状态）
    - _需求：1.6_

- [ ] 6. 检查点 - 确保所有测试通过
  - 确保所有测试通过，如有问题请告知。

- [ ] 7. 实现 `src/commands/setup.ts` Setup 命令
  - [ ] 7.1 实现 setup 步骤执行器与幂等性逻辑
    - 定义 `SETUP_STEPS` 常量数组（8 个步骤）
    - `shouldSkipStep(step: string, config: TheClawConfig): boolean`（检查 `completed_steps`）
    - `markStepComplete(step: string, config: TheClawConfig): TheClawConfig`（更新 `completed_steps`）
    - `runSetup(options: SetupOptions): Promise<void>`（按顺序执行步骤，跳过已完成步骤）
    - `--reset` 时清空 `completed_steps` 并重新执行所有步骤
    - _需求：2.1、2.5、2.6、2.10_

  - [ ] 7.2 为 setup 幂等性编写属性测试
    - **属性 9：setup 幂等性**
    - **验证：需求 2.5**
    - `// Feature: theclaw-cli, Property 9: setup 幂等性`
    - 使用 fast-check 生成任意非空已完成步骤集合，验证 `shouldSkipStep` 对集合中每个步骤返回 true
    - _需求：2.5_

  - [ ] 7.3 实现各 setup 步骤的具体执行逻辑
    - `installComponents`：调用 component-manager 检测并安装缺失组件
    - `loadAndFillProfile`：加载 profile，交互式填充占位符（使用 `@inquirer/prompts`）
    - `configurePai`：调用 `pai model config` 写入 pai 配置
    - `initAgents`：按顺序调用 `agent init <id>` 初始化 admin、warden、maintainer、evolver
    - `startNotifier`：调用 `notifier start`
    - `configureXgw`：写入 xgw 配置并调用 `xgw start`
    - `startAgents`：调用 `agent start <id>` 启动各 agent
    - `smokeTest`：调用各组件 status 命令验证启动成功
    - _需求：2.1、2.2、2.3、2.4、2.7、2.8、2.9_

- [ ] 8. 实现 `src/commands/status.ts` Status 命令
  - [ ] 8.1 实现状态聚合与格式化逻辑
    - `fetchComponentStatus(name: string, cmd: string): Promise<unknown>`（调用组件 status --json，失败时返回 error 对象）
    - `aggregateStatus(options: StatusOptions): Promise<StatusResult>`（并发调用各组件，错误隔离）
    - `formatStatusText(result: StatusResult): string`（人类可读格式）
    - `formatStatusJson(result: StatusResult): string`（JSON.stringify）
    - _需求：4.1、4.2、4.3、4.5、4.6_

  - [ ] 8.2 为 status JSON 输出编写属性测试
    - **属性 7：status JSON 输出结构完整性**
    - **验证：需求 4.3、4.6**
    - `// Feature: theclaw-cli, Property 7: status JSON 输出结构完整性`
    - 使用 fast-check 生成随机 StatusResult 数据，验证 `formatStatusJson` 输出合法 JSON 且含三个顶层字段
    - _需求：4.3、4.6_

  - [ ] 8.3 为错误隔离编写属性测试
    - **属性 10：错误状态不中断 status 聚合**
    - **验证：需求 4.5**
    - `// Feature: theclaw-cli, Property 10: 错误状态不中断 status 聚合`
    - 使用 fast-check 生成随机失败组件子集，验证聚合结果包含所有组件且失败组件标记为 error
    - _需求：4.5_

- [ ] 9. 实现 `src/commands/upgrade.ts` Upgrade 命令
  - [ ] 9.1 实现版本比较与升级执行逻辑
    - `filterComponents(config: ComponentsConfig, name?: string): ComponentDef[]`（--component 过滤）
    - `runUpgrade(options: UpgradeOptions): Promise<void>`（读取 components.yaml，比较版本，执行升级，重启服务）
    - dry-run 模式：只输出将要执行的操作，不调用任何 shell 命令
    - 升级后对 xgw、notifier 执行 graceful restart（stop → start）
    - _需求：5.1、5.2、5.3、5.4、5.5、5.6、5.7_

  - [ ] 9.2 为 dry-run 无副作用编写属性测试
    - **属性 6：dry-run 无副作用**
    - **验证：需求 5.4**
    - `// Feature: theclaw-cli, Property 6: dry-run 无副作用`
    - mock shell 执行器，使用 fast-check 生成任意组件列表，验证 dry-run 模式下 shell 命令执行次数为 0
    - _需求：5.4_

  - [ ] 9.3 为 --component 过滤编写属性测试
    - **属性 11：--component 过滤正确性**
    - **验证：需求 5.3**
    - `// Feature: theclaw-cli, Property 11: --component 过滤正确性`
    - 使用 fast-check 生成组件列表和目标名称，验证过滤结果有且仅有匹配组件
    - _需求：5.3_

- [ ] 10. 检查点 - 确保所有测试通过
  - 确保所有测试通过，如有问题请告知。

- [ ] 11. 实现 `src/index.ts` CLI 入口与命令注册
  - 使用 commander 注册 `setup`、`status`、`upgrade` 三个子命令及其选项
  - 注册 `--version` 和 `--help`
  - 未知命令时显示错误提示并建议使用 `--help`
  - 统一错误处理：捕获命令抛出的错误，根据错误类型设置退出码（1 或 2）
  - _需求：8.1、8.2、8.3、2.7、2.8、2.9_

- [ ] 12. 创建可观测性脚本
  - [ ] 12.1 创建 `scripts/theclaw-status.sh`
    - 聚合调用 notifier、xgw、agent 的 status 命令
    - _需求：6.1_

  - [ ] 12.2 创建 `scripts/theclaw-logs.sh`
    - 支持 `--lines <n>`（默认 20）和 `--component <name>` 参数
    - 显示 notifier、xgw、agents 的日志文件内容
    - _需求：6.2_

  - [ ] 12.3 创建 `scripts/theclaw-threads.sh`
    - 遍历 `${THECLAW_HOME:-~/.theclaw}/agents/*/` 下所有 thread 目录
    - 支持 `--agent <id>` 过滤
    - _需求：6.3_

  - [ ] 12.4 创建 `scripts/theclaw-trace.sh`
    - 支持 `--message-id <uuid>` 和 `--keyword <text> [--since <time>]` 参数
    - 按时间线格式输出消息追踪路径
    - _需求：6.4_

  - [ ] 12.5 创建 `scripts/theclaw-health.sh`
    - 检查 notifier、xgw、agents 运行状态及 inbox 积压
    - 支持 `--json` 输出 HealthCheckResult 格式
    - _需求：6.5、6.6、6.7_

- [ ] 13. 最终检查点 - 确保所有测试通过
  - 确保所有测试通过，如有问题请告知。

## 备注

- 每个属性测试必须包含注释 `// Feature: theclaw-cli, Property N: <描述>`
- 属性测试最少运行 100 次迭代（`{ numRuns: 100 }`）
- shell 命令调用函数参考 pai repo 的 `os-utils.ts` 实现，直接复制使用
- 各任务均可访问 requirements.md 和 design.md 获取完整上下文
