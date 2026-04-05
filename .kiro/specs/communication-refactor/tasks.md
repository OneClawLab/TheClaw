# 实施计划：Communication Refactor

## 概述

将 CommunicationDesign.md 中的完整通信架构实现到 xar（主要）和 xgw（次要）中。采用自底向上的实施策略：先实现纯函数/数据模型层（可独立测试），再实现集成层（run-loop 状态机），最后处理 xgw 侧的少量变更。

实现语言：TypeScript（与现有代码一致）

## 任务

- [ ] 1. 扩展类型定义和 AgentConfig
  - [ ] 1.1 扩展 `xar/src/agent/types.ts` 中的 AgentConfig
    - 将 `routing.default` 替换为 `routing.mode: 'reactive' | 'autonomous'`、`routing.trigger: 'mention' | 'all'`、`routing.override?: Record<string, string>`
    - 添加向后兼容的 config 加载逻辑：旧 `routing.default` 自动映射到新字段
    - _Requirements: 3.1, 3.2, 3.6_

  - [ ] 1.2 扩展 `xar/src/types.ts` 中的 InboundMessage
    - 新增 `mentioned?: boolean` 和 `conversation_type?: string` 可选字段
    - _Requirements: 9.3_

  - [ ] 1.3 新增 Task/SubTask 类型定义到 `xar/src/agent/task-types.ts`
    - 定义 Task、SubTask、CreateTaskParams、AnnounceResult 接口
    - _Requirements: 1.1_

- [ ] 2. 实现 Task Manager 核心模块
  - [ ] 2.1 实现 `xar/src/agent/task-manager.ts`
    - 实现 TaskManager 类：createTask、cancelTask、handleAnnounce、getTask、getPendingTasks、isTaskCancelled
    - task_id 生成：`<agent_id>-<timestamp>-<random>` 格式
    - Task 持久化：JSON 文件存储在 `~/.theclaw/agents/<id>/tasks/<task_id>.json`
    - fan-in 检测：所有 subtask 终结时返回 taskCompleted=true
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 1.8, 2.1, 2.2, 2.3_

  - [ ]* 2.2 编写 Task Manager 属性测试 `xar/vitest/pbt/task-manager.pbt.test.ts`
    - **Property 1: Task 创建正确性**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 11.1, 11.2**
    - **Property 2: Task 状态机转换正确性**
    - **Validates: Requirements 1.6, 1.7, 10.2**
    - **Property 3: Task 持久化 round-trip**
    - **Validates: Requirements 1.8**
    - **Property 4: Task 取消正确性**
    - **Validates: Requirements 2.1, 2.2, 2.3**

  - [ ]* 2.3 编写 Task Manager 单元测试 `xar/vitest/unit/task-manager.test.ts`
    - 测试边界情况：空 subtask 列表、单 subtask、重复 announce、task 不存在、task 已完成时取消
    - _Requirements: 1.1, 2.1, 2.3_

- [ ] 3. 重构 Router 模块
  - [ ] 3.1 重构 `xar/src/agent/router.ts` 的 determineThreadId 函数
    - 从静态 routing.default 改为基于 mode + source 动态推导
    - reactive + dm → `peers/<peer_id>`
    - reactive + group → `conversations/<conv_id>/peers/<peer_id>`
    - autonomous → `conversations/<conv_id>`
    - internal → `internal/<task_id>`
    - 支持 routing.override
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 11.3_

  - [ ] 3.2 新增 determineEventType 函数到 `xar/src/agent/router.ts`
    - 根据 AgentConfig 的 mode + trigger 和消息的 conversation_type + mentioned 决定 event_type
    - _Requirements: 3.3, 3.4, 3.5, 9.2_

  - [ ]* 3.3 编写 Router 属性测试 `xar/vitest/pbt/router.pbt.test.ts`
    - **Property 5: Thread 分配正确性**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 11.3**
    - **Property 6: Event Type 判定正确性**
    - **Validates: Requirements 3.3, 3.4, 3.5, 9.2**
    - **Property 11: Source 地址解析 round-trip**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

  - [ ]* 3.4 编写 Router 单元测试 `xar/vitest/unit/router.test.ts`
    - 测试旧 config 向后兼容、malformed source、override 规则
    - _Requirements: 4.5_

- [ ] 4. Checkpoint - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [ ] 5. 重构 Communication Context 模块
  - [ ] 5.1 实现角色检测函数 detectRole 到 `xar/src/agent/context.ts`
    - 根据 source kind、reply_to、taskContext 动态判定角色
    - 返回 AgentRole 类型
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ] 5.2 重构 buildCommunicationContext 函数
    - 根据 detectRole 结果选择对应的场景模板（A-F）
    - 场景 A: Front Reactive — 身份、会话、流向、可用 agents
    - 场景 B: Front Autonomous — 身份、会话、参与者、自主决定
    - 场景 C: Worker — 身份、委派来源、任务、DO NOT send_message
    - 场景 D: Worker Synthesizing — 身份、委派来源、subtask 结果、Do NOT delegate
    - 场景 E: Orchestrator Synthesizing — Task ID、origin、subtask 结果、流向
    - 场景 F: Orchestrator Waiting — Task ID、subtask 状态、可选进度更新
    - 遵循统一原则：身份锚点在最前，出站义务单一，可用工具在最后
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [ ]* 5.3 编写 Context 属性测试 `xar/vitest/pbt/context.pbt.test.ts`
    - **Property 7: 角色检测正确性**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
    - **Property 8: Communication Context 生成正确性**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7**

  - [ ]* 5.4 编写 Context 单元测试 `xar/vitest/unit/context.test.ts`
    - 测试各场景模板的具体输出内容
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

- [ ] 6. 实现 create_task 和 cancel_task 工具
  - [ ] 6.1 实现 `xar/src/agent/create-task.ts`
    - Tool schema 定义（name、description、parameters）
    - handler：调用 TaskManager.createTask，向 worker 发送委派消息
    - 从当前 Turn 上下文推断 origin.reply_target
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.5_

  - [ ] 6.2 实现 `xar/src/agent/cancel-task.ts`
    - Tool schema 定义
    - handler：调用 TaskManager.cancelTask，向 worker 发送取消通知
    - _Requirements: 2.1, 2.2_

  - [ ]* 6.3 编写 create-task/cancel-task 单元测试
    - `xar/vitest/unit/create-task.test.ts`
    - `xar/vitest/unit/cancel-task.test.ts`
    - 测试 worker 不存在、sendToAgent 失败、task 不存在等边界情况
    - _Requirements: 1.4, 2.1, 2.2_

- [ ] 7. 变更 send_message 工具
  - [ ] 7.1 修改 `xar/src/agent/send-message.ts`
    - deliverToAgent 中移除 task_context 和 reply_to 注入
    - send_message 变为纯 fire-and-forget 消息发送
    - _Requirements: 8.1, 8.2, 8.4_

  - [ ]* 7.2 编写 send_message 属性测试 `xar/vitest/pbt/send-message.pbt.test.ts`
    - **Property 9: send_message 纯净性**
    - **Validates: Requirements 8.1, 8.4**

  - [ ]* 7.3 更新 send_message 单元测试 `xar/vitest/unit/send-message.test.ts`
    - 验证发送给 agent 的消息不包含 reply_to 和 task_context
    - _Requirements: 8.1, 8.4_

- [ ] 8. 实现 Mid-Turn Injection 模块
  - [ ] 8.1 实现 `xar/src/agent/mid-turn.ts`
    - MidTurnInjector 类：checkAndInject 方法
    - 查询 Thread 中 lastCheckedEventId 之后的新 external message 事件
    - 构造 receive_user_update tool call + result 消息对
    - 将注入消息写入 Thread（type=record, subtype=mid_turn_injection）
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ]* 8.2 编写 Mid-Turn 属性测试 `xar/vitest/pbt/mid-turn.pbt.test.ts`
    - **Property 10: Mid-Turn Injection 构造正确性**
    - **Validates: Requirements 7.2**

  - [ ]* 8.3 编写 Mid-Turn 单元测试 `xar/vitest/unit/mid-turn.test.ts`
    - 测试无新消息、单条新消息、多条新消息、非 Human 消息被过滤
    - _Requirements: 7.1, 7.2, 7.3_

- [ ] 9. Checkpoint - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [ ] 10. 重构 Run-Loop 状态机
  - [ ] 10.1 重构 `xar/src/agent/run-loop.ts` 的 processMessage 方法
    - 入口处增加 Task 状态检查（cancelled task announce → 丢弃）
    - 使用 determineEventType 替代直接使用 msg.event_type
    - Worker announce 路径：调用 TaskManager.handleAnnounce → 检查 fan-in → 触发汇总 Turn
    - 汇总 Turn：构建包含 subtask 结果的 Communication Context，调用 LLM
    - 集成 create_task 和 cancel_task 作为 extraTools
    - 集成 MidTurnInjector：在 tool call 循环中插入检查点
    - 移除旧的 reply_to auto-announce 逻辑（由 Task Manager 接管）
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 7.1, 7.5_

  - [ ] 10.2 更新 system prompt 模板
    - 添加 receive_user_update 机制说明
    - _Requirements: 7.4_

  - [ ]* 10.3 编写 Run-Loop 集成测试 `xar/vitest/unit/run-loop.test.ts`
    - 测试完整的消息处理流程：External → Task 创建 → Worker announce → 汇总 Turn
    - 测试 cancelled task announce 丢弃
    - 测试 Mid-Turn Injection 集成
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

- [ ] 11. xgw 侧变更
  - [ ] 11.1 修改 `xgw/src/gateway/server.ts`
    - 移除 mention gating 逻辑（不再在 xgw 决定 event_type）
    - 将 `mentioned` 字段和 `conversation_type` 透传到 IPC 入站消息
    - _Requirements: 9.1_

  - [ ]* 11.2 更新 xgw 测试
    - 验证 mentioned 和 conversation_type 字段透传
    - _Requirements: 9.1_

- [ ] 12. 最终 Checkpoint
  - 确保 xar 和 xgw 所有测试通过，如有问题请询问用户。

## 备注

- 标记 `*` 的任务为可选任务，可跳过以加速 MVP
- 每个任务引用具体的需求编号以保证可追溯性
- 属性测试验证通用正确性属性，单元测试验证具体示例和边界情况
- Checkpoint 确保增量验证
- 实施顺序自底向上：类型 → 纯函数模块 → 集成层 → xgw 变更
