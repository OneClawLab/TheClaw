# 实现计划：测试覆盖补全

## 概述

按三阶段顺序实现测试覆盖补全。每个任务对应一个测试文件，包含集成测试和（部分）PBT 属性测试。跨 repo 测试统一放在 TheClaw repo 中。

## 任务

- [x] 1. 阶段一：thread intra-repo 集成测试
  - [x] 1.1 在 `thread/vitest/integration/thread.test.ts` 中实现 thread 完整流程集成测试
    - 使用真实 SQLite（tmpdir 隔离），直接调用 `openDb`、`insertEvent`、`popEvents`、`insertSubscription` 等内部模块
    - 测试场景：init 目录结构验证、push 持久化、subscribe+pop round-trip、batch push 顺序、filter pop、consumer_progress 更新、未初始化目录报错、thread info 输出
    - _需求: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_
  - [ ]* 1.2 在 `thread/vitest/pbt/push-pop-roundtrip.pbt.test.ts` 中实现 PBT 属性测试
    - **属性 1：push-pop round-trip** — 对任意有效 payload，push 后 pop 应读回相同内容
    - **属性 2：batch push 顺序不变量** — batch push N 条后，数据库新增恰好 N 条且 id 单调递增
    - **属性 3：filter 过滤正确性** — pop 返回的所有事件都满足 filter 条件
    - **属性 4：consumer_progress 单调递增** — pop 后 last_acked_id 等于传入的 last_event_id
    - 使用 fast-check，最少 100 次迭代
    - 注释格式：`// Feature: test-coverage, Property N: <text>`
    - _需求: 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 2. 检查点 — 确保 thread 所有测试通过，向用户确认后继续

- [x] 3. 阶段一：notifier intra-repo 集成测试
  - [x] 3.1 在 `notifier/vitest/integration/daemon.test.ts` 中实现 notifier daemon 生命周期集成测试
    - 通过 `npx tsx src/index.ts` spawn 真实 CLI 进程，使用 `NOTIFIER_HOME` 环境变量隔离测试目录
    - 测试场景：start 后 PID 文件存在、stop 后 PID 文件删除、task add 后文件出现在 pending 目录、daemon 未运行时 status 输出 running: false、重复 start 报错（exit 1）、timer add 后定时器文件出现
    - 注意：测试中 daemon 进程需要在 afterEach 中强制终止（kill PID），避免进程泄漏
    - _需求: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [x] 4. 检查点 — 确保 notifier 所有测试通过，向用户确认后继续

- [x] 5. 阶段一：xdb intra-repo 集成测试
  - [x] 5.1 在 `xdb/vitest/integration/collection.test.ts` 中实现 xdb collection 管理和数据读写集成测试
    - 直接调用 `CollectionManager`、`DataWriter`、`DataFinder`，使用真实 SQLite（relational 策略），mock embedder（返回固定维度随机向量）
    - 测试场景：init 创建目录和 meta 文件、重复 init 报 PARAMETER_ERROR、write 后 SQLite 持久化、find --match 查询返回匹配记录、remove 后目录删除、list 返回所有 collection、无 id 字段自动生成 UUID
    - _需求: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
  - [ ]* 5.2 在 `xdb/vitest/pbt/write-find-roundtrip.pbt.test.ts` 中实现 PBT 属性测试
    - **属性 5：write-find round-trip** — 对任意记录，写入后 --match 查询应能找到（当查询词在 FTS 字段中时）
    - **属性 6：collection list 计数不变量** — init N 个不同名 collection 后，list 返回数量等于 N
    - **属性 7：自动 UUID 生成** — 对任意不含 id 的记录，写入后查询到的记录有非空 id 字段
    - 使用 fast-check，最少 100 次迭代
    - _需求: 3.3, 3.4, 3.6, 3.7_
  - [x] 5.3 在 `xdb/vitest/integration/collection-real.test.ts` 中实现真实 embedding 手动测试
    - 新增 `xdb/vitest.real.config.ts`（include: `vitest/**/*-real.test.ts`，testTimeout: 60000）
    - 在 `xdb/package.json` 中新增 `"test:real": "vitest run --config vitest.real.config.ts"`
    - 测试场景：真实 embedding 写入、--similar 语义搜索（console.log 结果供人工评估）、embedding dimension 记录到 meta
    - _需求: 3.3, 3.4_

- [x] 6. 检查点 — 确保 xdb 所有测试通过，向用户确认后继续

- [x] 7. 阶段一：xweb CLI 进程级集成测试
  - [x] 7.1 在 `xweb/vitest/integration/cli.test.ts` 中实现 xweb CLI 进程级集成测试
    - 通过 `npx tsx src/index.ts` spawn 真实 CLI 进程（参考 `cmds/vitest/integration/cli.test.ts` 的模式）
    - 测试场景：--help exit 0 且 stdout 包含命令说明、--version exit 0 且版本号格式正确、fetch 缺参数 exit 2、search 缺参数 exit 2、config --show exit 0、未知子命令 exit 非 0
    - _需求: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 8. 检查点 — 确保 xweb 所有测试通过，向用户确认后继续

- [x] 9. 阶段二：thread ↔ notifier 跨 repo 集成测试
  - [x] 9.1 在 `TheClaw/vitest/integration/thread-notifier.test.ts` 中实现跨 repo 集成测试
    - mock `thread/src/repo-utils/os.js` 的 `execCommand`，使用真实 SQLite（tmpdir）
    - 测试场景：push 后验证 execCommand('notifier', ...) 被调用且参数包含 task add、task-id 包含 threadDir 路径编码（相同路径生成相同 task-id）、notifier 不可用时 push 仍成功（事件已写入 SQLite）、scheduleDispatch 收到 exit 1 不抛出错误
    - _需求: 5.1, 5.2, 5.3, 5.4_
  - [ ]* 9.2 在 `TheClaw/vitest/pbt/thread-notifier.pbt.test.ts` 中实现 PBT 属性测试
    - **属性 8：push 触发 notifier 调度** — 对任意有效 push，scheduleDispatch 被调用且 task-id 是 threadDir 的确定性编码
    - **属性 9：notifier 失败不影响 push** — 对任意 push，即使 execCommand 抛出错误，事件仍写入 SQLite
    - 使用 fast-check，最少 100 次迭代
    - _需求: 5.1, 5.2, 5.3_

- [x] 10. 检查点 — 确保 thread-notifier 所有测试通过，向用户确认后继续

- [x] 11. 阶段二：xgw ↔ thread 跨 repo 集成测试
  - [x] 11.1 在 `TheClaw/vitest/integration/xgw-thread.test.ts` 中实现跨 repo 集成测试
    - mock `xgw/src/repo-utils/os.js` 的 `execCommand`，直接调用 `InboxWriter` 和 `Router` 类
    - 测试场景：InboxWriter.push 调用 thread push 且参数正确（--thread、--source、--type、--content）、source 格式为 `external:<channelType>:<channelId>:dm:<sessionId>:<peerId>`、Router 精确匹配优先于通配符、Router 无匹配返回 null、agent 不存在时 InboxWriter 报错
    - _需求: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [ ]* 11.2 在 `TheClaw/vitest/pbt/xgw-router.pbt.test.ts` 中实现 PBT 属性测试
    - **属性 10：InboxWriter source 格式正确性** — 对任意消息，--source 参数符合规定格式
    - **属性 11：Router 路由优先级** — 对任意规则集合，精确匹配优先于通配符；无匹配返回 null
    - 使用 fast-check，最少 100 次迭代
    - _需求: 6.1, 6.2, 6.3, 6.4_

- [x] 12. 检查点 — 确保 xgw-thread 所有测试通过，向用户确认后继续

- [x] 13. 阶段二：agent ↔ thread ↔ pai 跨 repo 集成测试
  - [x] 13.1 在 `TheClaw/vitest/integration/agent-pipeline.test.ts` 中实现跨 repo 集成测试
    - mock `agent/src/repo-utils/os.js` 的 `execCommand`、`agent/src/runner/llm.js` 的 `invokeLlm`，使用真实文件系统（tmpdir）
    - 注意：`agent/vitest/integration/integration.test.ts` 已有完整的 init→start→run→deliver 测试，本测试聚焦跨 repo 接口契约（与 thread、xgw 的交互参数）
    - 测试场景：agent run 消费 inbox 消息（consumeMessages 被调用）、agent run 处理消息（invokeLlm 被调用且参数正确）、agent run 完成后回复写入 peer thread、run.lock 清理、agent deliver 调用 xgw send
    - _需求: 7.1, 7.2, 7.3, 7.4, 7.5_
  - [x] 13.2 在 `TheClaw/vitest/integration/agent-pipeline-real.test.ts` 中实现真实 LLM 手动测试
    - 新增 `TheClaw/vitest.real.config.ts`（include: `vitest/**/*-real.test.ts`，testTimeout: 60000）
    - 在 `TheClaw/package.json` 中新增 `"test:real": "vitest run --config vitest.real.config.ts"`
    - 测试场景：真实 LLM agent 处理消息，结构性断言（回复非空、peer thread 有新事件），console.log 输出供人工评估
    - _需求: 7.2, 7.3_

- [x] 14. 检查点 — 确保 agent-pipeline 所有测试通过，向用户确认后继续

- [x] 15. 阶段三：TheClaw setup E2E 测试
  - [x] 15.1 在 `TheClaw/vitest/integration/setup-e2e.test.ts` 中实现完整 setup 流程 E2E 测试
    - mock `TheClaw/src/repo-utils/os.js` 的 `execShell`/`execCommand`，使用真实文件系统（tmpdir）
    - 注意：`TheClaw/vitest/integration/setup.test.ts` 已有 setup 原语测试，本文件测试**完整 setup 命令流程**（多步骤串联）
    - 测试场景：完整 setup 流程（config 创建 → profile 加载 → 步骤执行 → 完成标记）、幂等性（重复执行跳过已完成步骤）、smoke-test 步骤验证 notifier status 和 agent status 调用
    - _需求: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 16. 检查点 — 确保 setup-e2e 所有测试通过，向用户确认后继续

- [x] 17. 阶段三：全链路 E2E 测试
  - [x] 17.1 在 `TheClaw/vitest/integration/full-pipeline.test.ts` 中实现全链路 E2E 测试
    - mock `execCommand`（捕获所有跨 repo CLI 调用）和 `invokeLlm`，使用真实文件系统（tmpdir）
    - 测试场景：xgw InboxWriter 写入消息（thread push 调用验证）、agent 消费消息（LLM 调用验证）、回复写入 peer thread、agent deliver（xgw send 调用验证）、全链路完成后 consumer_progress 更新
    - _需求: 9.1, 9.2, 9.3, 9.4_
  - [x] 17.2 在 `TheClaw/vitest/integration/full-pipeline-real.test.ts` 中实现真实 LLM 全链路手动测试
    - 使用已有的 `TheClaw/vitest.real.config.ts`（任务 13.2 中创建）
    - 测试场景：真实 LLM 全链路（xgw 写入 → agent run → deliver），结构性断言（投递内容非空、格式正确），console.log 输出供人工评估
    - _需求: 9.1, 9.2, 9.3_

- [x] 18. 最终检查点 — 确保所有测试通过，向用户确认 spec 实现完成

## 备注

- 标有 `*` 的子任务（PBT 测试）为可选，可跳过以优先完成核心集成测试
- 每个任务引用的需求编号对应 requirements.md 中的验收标准
- 跨 repo 测试（任务 9-17）需要 TheClaw 的 tsconfig.json 能解析其他 repo 的源码路径
- 真实调用手动测试（`*-real.test.ts`）通过独立 `vitest.real.config.ts` 运行，永远不纳入 `npm test`
