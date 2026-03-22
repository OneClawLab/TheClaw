# 需求文档：测试覆盖补全

## 简介

本功能旨在系统性地补全多 repo TypeScript ESM CLI 工具集的测试覆盖。当前各 repo 均有 unit 测试和 PBT（属性测试），但缺少 intra-repo 集成测试、跨 repo 集成测试和系统级 E2E 测试。本需求文档定义三个阶段的测试补全目标，以提升系统整体可靠性和回归检测能力。

## 术语表

- **Thread**：基于 SQLite 的消息总线 CLI 工具，提供 push/pop/subscribe/dispatch 等命令
- **Notifier**：定时任务和即时任务调度 daemon，通过 task/timer 文件触发命令执行
- **Xdb**：向量数据库 CLI 工具，支持 SQLite（关系型）和 LanceDB（向量）双引擎
- **Xweb**：互联网访问 CLI 工具，提供 search/fetch/explore 命令
- **Xgw**：消息网关 daemon，负责外部渠道（Telegram 等）与 agent inbox 之间的消息路由
- **Agent**：消息处理 CLI 工具，消费 thread inbox 消息并调用 LLM 生成回复
- **Pai**：LLM 对话 CLI 工具，提供 chat 命令
- **TheClaw**：系统编排入口 CLI，负责安装、初始化和管理所有组件
- **Intra-repo 集成测试**：在单个 repo 内测试多个模块协同工作的完整流程
- **跨 repo 集成测试**：测试两个或多个 repo 之间通过 CLI 调用或文件系统交互的协作流程
- **E2E 测试**：端到端测试，覆盖从外部输入到最终输出的完整系统链路
- **Consumer**：thread 的订阅者，通过 subscribe 注册并通过 pop 消费消息
- **InboxWriter**：xgw 中将外部消息写入 agent inbox thread 的组件

## 需求

### 需求 1：thread intra-repo 集成测试

**用户故事：** 作为开发者，我希望有集成测试覆盖 thread 的完整 push/pop/subscribe 流程（含真实 SQLite 持久化），以便在修改 thread 核心逻辑时能快速发现回归问题。

#### 验收标准

1. WHEN thread init 命令在临时目录执行后，THE Thread_Integration_Test SHALL 验证 events.db 文件和必要目录结构已创建
2. WHEN thread push 命令写入事件后，THE Thread_Integration_Test SHALL 验证事件已持久化到 SQLite 数据库
3. WHEN thread subscribe 注册 consumer 后再执行 thread pop，THE Thread_Integration_Test SHALL 验证能正确读取到已推送的事件
4. WHEN 多条事件通过 batch 模式推送后，THE Thread_Integration_Test SHALL 验证所有事件均按顺序持久化
5. WHEN thread pop 使用 --filter 参数时，THE Thread_Integration_Test SHALL 验证只返回符合过滤条件的事件
6. WHEN thread pop 被调用后，THE Thread_Integration_Test SHALL 验证 consumer_progress 已更新为最新已消费的 event id
7. IF thread push 在未初始化的目录执行，THEN THE Thread_Integration_Test SHALL 验证命令以 exit code 1 退出并输出错误信息到 stderr
8. WHEN thread info 命令执行后，THE Thread_Integration_Test SHALL 验证输出包含正确的事件数量和订阅信息

### 需求 2：notifier intra-repo 集成测试

**用户故事：** 作为开发者，我希望有集成测试覆盖 notifier daemon 的完整生命周期（start/stop/task 触发），以便验证 daemon 的进程管理和任务执行逻辑。

#### 验收标准

1. WHEN notifier start 命令执行后，THE Notifier_Integration_Test SHALL 验证 PID 文件已创建且进程存活
2. WHEN notifier stop 命令执行后，THE Notifier_Integration_Test SHALL 验证 PID 文件已删除
3. WHEN notifier task add 命令添加任务文件后，THE Notifier_Integration_Test SHALL 验证任务文件出现在 tasks/pending/ 目录
4. WHEN notifier status 命令执行时 daemon 未运行，THE Notifier_Integration_Test SHALL 验证输出包含 running: false
5. WHEN notifier start 被重复调用时 daemon 已在运行，THE Notifier_Integration_Test SHALL 验证命令以 exit code 1 退出并输出错误信息
6. WHEN notifier timer add 命令添加定时器文件后，THE Notifier_Integration_Test SHALL 验证定时器文件出现在 timers/ 目录

### 需求 3：xdb intra-repo 集成测试

**用户故事：** 作为开发者，我希望有集成测试覆盖 xdb 的 collection 管理和数据读写流程（使用真实 SQLite），以便验证数据持久化和查询逻辑的正确性。

#### 验收标准

1. WHEN CollectionManager.init 在临时目录执行后，THE Xdb_Integration_Test SHALL 验证 collection 目录和 collection_meta.json 已创建
2. WHEN CollectionManager.init 对同名 collection 重复调用时，THE Xdb_Integration_Test SHALL 验证抛出 PARAMETER_ERROR 错误
3. WHEN DataWriter 写入记录到 relational 策略的 collection 后，THE Xdb_Integration_Test SHALL 验证记录已持久化到 SQLite
4. WHEN DataFinder 对已写入数据执行 --match 查询时，THE Xdb_Integration_Test SHALL 验证返回包含匹配关键词的记录
5. WHEN CollectionManager.remove 执行后，THE Xdb_Integration_Test SHALL 验证 collection 目录已被删除
6. WHEN CollectionManager.list 执行时，THE Xdb_Integration_Test SHALL 验证返回所有已创建的 collection 信息
7. WHEN DataWriter 写入不含 id 字段的记录时，THE Xdb_Integration_Test SHALL 验证自动生成 UUID 并持久化

### 需求 4：xweb CLI 进程级集成测试

**用户故事：** 作为开发者，我希望有 CLI 进程级集成测试覆盖 xweb 的 fetch/search/explore 命令，以便验证 CLI 参数解析、exit code 和输出格式的正确性。

#### 验收标准

1. WHEN xweb --help 命令执行时，THE Xweb_Integration_Test SHALL 验证 exit code 为 0 且 stdout 包含命令说明
2. WHEN xweb --version 命令执行时，THE Xweb_Integration_Test SHALL 验证 exit code 为 0 且输出包含版本号
3. WHEN xweb fetch 命令缺少必需参数时，THE Xweb_Integration_Test SHALL 验证 exit code 为 2
4. WHEN xweb search 命令缺少必需参数时，THE Xweb_Integration_Test SHALL 验证 exit code 为 2
5. WHEN xweb config --show 命令执行时，THE Xweb_Integration_Test SHALL 验证 exit code 为 0
6. WHEN xweb 收到未知子命令时，THE Xweb_Integration_Test SHALL 验证 exit code 不为 0

### 需求 5：thread ↔ notifier 跨 repo 集成测试

**用户故事：** 作为开发者，我希望有跨 repo 集成测试验证 thread push 触发 notifier 调度的完整链路，以便确认两个 repo 之间的协作接口正确。

#### 验收标准

1. WHEN thread push 命令执行后，THE Cross_Repo_Integration_Test SHALL 验证 notifier task add 被调用（通过 mock execCommand 捕获调用参数）
2. WHEN notifier 的 scheduleDispatch 被调用时，THE Cross_Repo_Integration_Test SHALL 验证生成的 task-id 包含 thread 目录路径的编码
3. WHEN thread push 在 notifier 不可用时执行，THE Cross_Repo_Integration_Test SHALL 验证 push 操作仍然成功（notifier 调度失败不影响主流程）
4. WHEN scheduleDispatch 收到 exit code 1 的响应时，THE Cross_Repo_Integration_Test SHALL 验证不抛出错误（任务已存在属于正常情况）

### 需求 6：xgw ↔ thread 跨 repo 集成测试

**用户故事：** 作为开发者，我希望有跨 repo 集成测试验证 xgw InboxWriter 将消息写入 agent inbox thread 的完整流程，以便确认消息格式和路由逻辑正确。

#### 验收标准

1. WHEN InboxWriter.push 被调用时，THE Cross_Repo_Integration_Test SHALL 验证 thread push 命令被调用且参数包含正确的 --thread、--source、--type 和 --content
2. WHEN InboxWriter.push 处理外部消息时，THE Cross_Repo_Integration_Test SHALL 验证 source 字段格式为 `external:<channelType>:<channelId>:dm:<sessionId>:<peerId>`
3. WHEN Router.resolve 被调用时，THE Cross_Repo_Integration_Test SHALL 验证精确匹配优先于通配符匹配
4. WHEN Router.resolve 找不到匹配规则时，THE Cross_Repo_Integration_Test SHALL 验证返回 null
5. IF InboxWriter.push 中 agent 不存在于配置时，THEN THE Cross_Repo_Integration_Test SHALL 验证抛出包含 agent id 的错误信息

### 需求 7：agent ↔ thread ↔ pai 跨 repo 集成测试

**用户故事：** 作为开发者，我希望有跨 repo 集成测试验证 agent 消费 thread 消息、调用 pai 并将回复写回 thread 的完整流程，以便确认 agent 的消息处理链路正确。

#### 验收标准

1. WHEN agent run 命令执行时，THE Cross_Repo_Integration_Test SHALL 验证 consumeMessages 被调用以读取 inbox 消息
2. WHEN agent run 处理消息时，THE Cross_Repo_Integration_Test SHALL 验证 invokeLlm 被调用且传入正确的 agent 配置
3. WHEN agent run 完成消息处理后，THE Cross_Repo_Integration_Test SHALL 验证回复被写入对应的 peer thread
4. WHEN agent run 处理完所有消息后，THE Cross_Repo_Integration_Test SHALL 验证 run.lock 文件已被清理
5. WHEN agent deliver 命令执行时，THE Cross_Repo_Integration_Test SHALL 验证 xgw send 命令被调用以投递回复

### 需求 8：TheClaw setup E2E 测试

**用户故事：** 作为开发者，我希望有 E2E 测试覆盖 TheClaw 的完整 setup 流程，以便验证配置持久化、profile 加载和 agent 初始化的端到端正确性。

#### 验收标准

1. WHEN TheClaw setup 命令执行时，THE E2E_Test SHALL 验证 config.json 被创建并包含正确的 schema_version 和 profile 字段
2. WHEN TheClaw setup 完成某个步骤后，THE E2E_Test SHALL 验证该步骤被记录到 completed_steps 列表
3. WHEN TheClaw setup 重新执行时已完成的步骤存在，THE E2E_Test SHALL 验证已完成步骤被跳过（幂等性）
4. WHEN TheClaw setup 加载 profile 文件时，THE E2E_Test SHALL 验证 profile 中的 steps 被正确解析和执行
5. WHEN TheClaw setup 的 smoke-test 步骤执行时，THE E2E_Test SHALL 验证 notifier status 和 agent status 命令被调用

### 需求 9：全链路 E2E 测试

**用户故事：** 作为开发者，我希望有全链路 E2E 测试验证从 xgw 收到外部消息到最终通过 xgw 投递回复的完整系统链路，以便确认各组件协作的端到端正确性。

#### 验收标准

1. WHEN xgw 收到外部消息时，THE E2E_Test SHALL 验证消息通过 InboxWriter 写入 agent inbox thread（mock execCommand）
2. WHEN agent 消费 inbox 消息并生成回复时，THE E2E_Test SHALL 验证回复被写入 peer thread（mock LLM）
3. WHEN agent deliver 执行时，THE E2E_Test SHALL 验证 xgw send 命令被调用以投递回复
4. WHEN 全链路执行完成后，THE E2E_Test SHALL 验证 inbox thread 的 consumer_progress 已更新
