# 需求文档：Communication Refactor

## 简介

本次重构将 TheClaw 多 Agent 通信系统从当前的简单 send_message + reply_to 模型升级为 CommunicationDesign.md 中定义的完整通信架构。核心变更包括：引入 Task/SubTask 协调抽象、动态 Agent 角色检测、Reactive/Autonomous 模式支持、Mid-Turn 用户注入机制，以及全面重构的 Communication Context 注入系统。

## 术语表

- **Agent**: 系统中的自治智能体，由代码和 LLM 驱动
- **Peer**: 外部通信的对端（人类用户）
- **Thread**: 持久化的事件流容器，Agent 处理消息的上下文单元
- **Turn**: Agent 对一条入站消息的完整处理过程（从消息写入 Thread 到 LLM 最终 text response 生成完毕）
- **Task**: 代码层的协调单元，管理 fan-out/fan-in 的任务委派
- **SubTask**: Task 内的子任务，对应一个 Worker Agent 的委派
- **Orchestrator**: 通过 create_task 向下游委派任务的 Agent 角色
- **Worker**: 被上游委派执行任务的 Agent 角色
- **Front**: 面向 Human 的服务者角色
- **Participant**: 收到通知但无需回复的 Agent 角色
- **Communication_Context**: 每次 LLM 调用前注入的通信环境描述
- **Mid_Turn_Injection**: Turn 执行期间将用户新消息注入 LLM 上下文的机制
- **Internal_Conversation**: Agent 间通信的会话，ID 格式为 `internal:<orchestrator_id>:<task_id>`
- **External_Conversation**: Agent 与 Human 之间的会话，由外部渠道决定 ID
- **Run_Loop**: xar 中 per-agent 的消息处理循环
- **Reactive_Mode**: Agent 对触达消息有问必答的模式
- **Autonomous_Mode**: Agent 自主决定是否回复的模式
- **Fan_Out**: Orchestrator 同时向多个 Worker 委派子任务
- **Fan_In**: 等待所有子任务完成后触发汇总 Turn

## 需求

### 需求 1：Task/SubTask 协调模型

**用户故事：** 作为 Orchestrator Agent，我希望通过 create_task 工具将复杂任务分解为多个子任务并委派给 Worker Agent，以便实现 fan-out/fan-in 的任务协调。

#### 验收标准

1. WHEN Orchestrator 调用 create_task 工具时，THE Task_Manager SHALL 创建一个 Task 对象，包含全局唯一的 task_id、owner、origin（thread_id、event_id、reply_target）、status 和 subtasks 列表
2. WHEN create_task 指定 wait_all=true 时，THE Task_Manager SHALL 将 Task status 设为 waiting，并在所有 SubTask 终结后触发汇总 Turn
3. WHEN create_task 指定 wait_all=false 时，THE Task_Manager SHALL 将 Task status 设为 sent，不等待 SubTask 结果
4. WHEN Task 创建完成后，THE Task_Manager SHALL 向每个 SubTask 的 Worker 发送委派消息，消息携带 reply_to 字段指向 owner Agent，并使用 Internal_Conversation ID 格式 `internal:<orchestrator_id>:<task_id>`
5. WHEN SubTask 创建时，THE Task_Manager SHALL 将 SubTask status 设为 pending，发送委派消息后更新为 sent
6. WHEN Worker announce 回来时，THE Task_Manager SHALL 通过 Internal_Conversation ID 反查对应 Task，更新 SubTask status 为 done 或 failed，并填充 result
7. WHEN 所有 SubTask 终结（done 或 failed）且 Task 的 wait_all=true 时，THE Task_Manager SHALL 触发汇总 Turn，将所有 SubTask 结果注入 LLM context
8. THE Task_Manager SHALL 将 Task 对象持久化为 JSON 文件，路径为 `~/.theclaw/agents/<id>/tasks/<task_id>.json`
9. WHEN 构建 Communication_Context 时，THE Context_Builder SHALL 自动注入当前 Agent 的 pending Task 状态信息，无需单独的查询工具

### 需求 2：Task 取消机制

**用户故事：** 作为 Orchestrator Agent，我希望能够取消正在进行的 Task，以便在用户修改需求时及时停止旧任务并重新委派。

#### 验收标准

1. WHEN Orchestrator 调用 cancel_task(task_id) 工具时，THE Task_Manager SHALL 将 Task status 设为 cancelled
2. WHEN Task 被取消时，THE Task_Manager SHALL 向所有 status=sent 的 SubTask Worker 发送取消通知（internal 消息，不携带 reply_to，subtype=cancellation）
3. WHEN 已 cancelled 的 Task 收到 Worker announce 时，THE Task_Manager SHALL 丢弃该 announce，不触发汇总 Turn
4. WHEN Worker 收到取消通知且自身也是 Orchestrator 时，THE Worker SHALL 通过 LLM 判断是否调用 cancel_task 取消自己的下游 Task（级联取消）
5. WHEN cancel_task 执行完成后，THE Task_Manager SHALL 返回 `{ cancelled: true }`，Orchestrator 可在同一 Turn 内用新参数重新调用 create_task

### 需求 3：Reactive/Autonomous 模式

**用户故事：** 作为系统管理员，我希望为每个 Agent 配置 Reactive 或 Autonomous 模式，以便控制 Agent 对消息的响应策略。

#### 验收标准

1. THE AgentConfig SHALL 包含 `routing.mode` 字段，值为 `'reactive'` 或 `'autonomous'`
2. THE AgentConfig SHALL 包含 `routing.trigger` 字段，值为 `'mention'` 或 `'all'`，仅在 Reactive 模式的群聊场景下有意义
3. WHILE Agent 处于 Reactive 模式且 trigger=mention 时，THE Run_Loop SHALL 将群聊中未触发 mention 的消息标记为 `type=record`（仅上下文，不触发 LLM），触发 mention 的消息标记为 `type=message`
4. WHILE Agent 处于 Reactive 模式且 trigger=all 时，THE Run_Loop SHALL 将群聊中所有消息标记为 `type=message`
5. WHILE Agent 处于 Autonomous 模式时，THE Run_Loop SHALL 将所有消息标记为 `type=message`，由 LLM 自主决定是否回复（空 response 即为沉默）
6. THE AgentConfig SHALL 支持 `routing.override` 字段，允许自定义 Thread 分配规则覆盖默认策略

### 需求 4：动态 Thread 分配

**用户故事：** 作为 Agent 运行时，我希望根据 Agent 模式和消息来源自动确定 Thread 分配策略，以便正确隔离不同场景的上下文。

#### 验收标准

1. WHILE Agent 处于 Reactive 模式且收到单聊消息时，THE Router SHALL 将消息路由到 per-peer Thread，路径为 `threads/peers/<peer_id>/`
2. WHILE Agent 处于 Reactive 模式且收到群聊消息时，THE Router SHALL 将消息路由到 per-conversation-peer Thread，路径为 `threads/conversations/<conv_id>/peers/<peer_id>/`
3. WHILE Agent 处于 Autonomous 模式时，THE Router SHALL 将消息路由到 per-conversation Thread，路径为 `threads/conversations/<conv_id>/`
4. WHEN 收到 Internal 消息时，THE Router SHALL 将消息路由到 per-internal-conv Thread，路径为 `threads/internal/<task_id>/`
5. WHEN AgentConfig 包含 routing.override 时，THE Router SHALL 优先使用 override 规则

### 需求 5：动态角色检测

**用户故事：** 作为 Agent 运行时，我希望在每个 Turn 开始时根据入站消息动态确定 Agent 的角色，以便注入正确的 Communication_Context。

#### 验收标准

1. WHEN 入站消息来自 External 时，THE Context_Builder SHALL 将当前 Turn 角色判定为 Front
2. WHEN 入站消息来自 Internal 且消息携带 reply_to 时，THE Context_Builder SHALL 将当前 Turn 角色判定为 Worker
3. WHEN 入站消息来自 Internal 且消息不携带 reply_to 且非 Task 汇总触发时，THE Context_Builder SHALL 将当前 Turn 角色判定为 Participant
4. WHEN 入站为 Task 汇总触发时，THE Context_Builder SHALL 将当前 Turn 角色判定为 Orchestrator
5. WHEN Worker 在 Turn 中调用 create_task 时，THE Worker SHALL 同时持有 Worker 和 Orchestrator 角色，但 Communication_Context 中身份锚点保持为 Worker

### 需求 6：Communication Context 重构

**用户故事：** 作为 LLM，我希望在每次调用时获得清晰的通信环境描述，以便正确理解当前角色、出站义务和可用工具。

#### 验收标准

1. WHEN 角色为 Front（Reactive 模式）时，THE Context_Builder SHALL 注入场景 A 模板：身份、会话信息、当前消息来源、text response 流向、可用 Agent 列表
2. WHEN 角色为 Front（Autonomous 模式）时，THE Context_Builder SHALL 注入场景 B 模板：身份、会话信息、参与者列表、明确告知 LLM 自主决定是否回复
3. WHEN 角色为 Worker（尚未 fan-out）时，THE Context_Builder SHALL 注入场景 C 模板：身份、委派来源、任务描述、明确 "DO NOT use send_message to reply" 指令
4. WHEN 角色为 Worker（汇总子任务结果）时，THE Context_Builder SHALL 注入场景 D 模板：身份、委派来源、任务描述、所有 SubTask 结果、"Do NOT delegate further" 指令
5. WHEN 角色为 Orchestrator（汇总回复 Human）时，THE Context_Builder SHALL 注入场景 E 模板：Task ID、origin 信息、所有 SubTask 结果、text response 流向
6. WHEN 角色为 Orchestrator（等待中，部分 SubTask 完成）时，THE Context_Builder SHALL 注入场景 F 模板：Task ID、各 SubTask 状态、提示可选择性发送进度更新
7. THE Context_Builder SHALL 遵循统一组织原则：身份锚点在最前，出站义务明确单一，可用工具列在最后

### 需求 7：Mid-Turn 用户注入

**用户故事：** 作为用户，我希望在 Agent 执行长时间 Turn 期间发送补充指令，以便及时影响 LLM 后续的 tool call 规划。

#### 验收标准

1. WHEN Turn 执行期间（tool call 序列进行中），THE Run_Loop SHALL 在每次 tool 执行完后检查 Thread 是否有新的 Human 消息
2. WHEN 检测到新的 Human 消息时，THE Run_Loop SHALL 自动构造 `receive_user_update` 虚拟 tool call + result 插入当前 messages
3. WHEN 注入 receive_user_update 时，THE Run_Loop SHALL 同时将注入的消息写入 Thread 事件流，标记为 `type=record, subtype=mid_turn_injection`
4. THE System_Prompt SHALL 包含对 receive_user_update 机制的说明，告知 LLM 将其内容视为当前任务的补充而非新请求
5. WHEN Turn 已结束（如 Task status=waiting 等待 Worker 期间）时，THE Run_Loop SHALL 通过正常的新 Turn 流程处理新消息，不使用 Mid_Turn_Injection 机制

### 需求 8：send_message 工具变更

**用户故事：** 作为开发者，我希望 send_message 工具成为纯粹的消息发送工具，不再自动注入 reply_to 和 task_context，以便与 create_task 工具的职责清晰分离。

#### 验收标准

1. WHEN LLM 调用 send_message 时，THE Send_Message_Tool SHALL 仅执行消息发送，不自动注入 reply_to 或 task_context 到目标消息
2. THE Create_Task_Tool SHALL 独占 "等待结果" 语义，send_message 仅用于异步消息发送（如进度更新）
3. WHEN send_message 发送给 peer 时，THE Send_Message_Tool SHALL 通过 IPC 投递消息到 xgw
4. WHEN send_message 发送给 agent 时，THE Send_Message_Tool SHALL 通过 daemon 内部 sendToAgent 投递消息，不携带 reply_to

### 需求 9：Mention Gating 迁移

**用户故事：** 作为系统架构师，我希望将 mention gating 决策从 xgw 迁移到 xar，以便 xar 能根据 Agent 配置（mode + trigger）做出更精确的触达判断。

#### 验收标准

1. WHEN xgw 收到群聊消息时，THE xgw SHALL 透明传递 `mentioned` 字段到 IPC 入站消息，不再自行决定 event_type
2. WHEN xar 收到携带 mentioned 字段的入站消息时，THE Run_Loop SHALL 根据 Agent 的 routing.mode 和 routing.trigger 配置决定 event_type（message 或 record）
3. THE InboundMessage 接口 SHALL 新增可选的 `mentioned` 布尔字段

### 需求 10：Agent Loop 状态机

**用户故事：** 作为 Agent 运行时，我希望 Run_Loop 能正确处理所有入站消息类型（External、Worker announce、Worker 委派、取消通知），以便实现完整的 Task 协调流程。

#### 验收标准

1. WHEN 收到 External（Human）消息时，THE Run_Loop SHALL 执行正常 Turn，LLM 可能通过 create_task 创建 Task
2. WHEN 收到 Internal Worker announce 时，THE Run_Loop SHALL 在代码层更新 SubTask 状态，检查 fan-in 完成条件，完成时触发汇总 Turn
3. WHEN 收到 Internal 委派消息（携带 reply_to）时，THE Run_Loop SHALL 执行 Worker Turn，Turn 结束后框架自动 announce 结果给 reply_to 目标
4. WHEN 收到已 cancelled Task 的 announce 时，THE Run_Loop SHALL 丢弃该消息，不触发任何处理
5. WHEN Task 创建且 wait_all=true 时，THE Run_Loop SHALL 在 Turn 结束后不产出隐式出站，等待 Worker 结果

### 需求 11：Internal Conversation ID

**用户故事：** 作为系统运行时，我希望 Internal Conversation ID 与 task_id 绑定，以便保证同一 Task 下多次交互的上下文连续性。

#### 验收标准

1. THE Internal_Conversation ID SHALL 使用格式 `internal:<orchestrator_id>:<task_id>`
2. WHEN Orchestrator 创建 Task 时，THE Task_Manager SHALL 使用 task_id 生成 Internal_Conversation ID，同一 Task 下对所有 Worker 的通信共享此 ID
3. WHEN Worker 收到委派消息时，THE Router SHALL 使用 Internal_Conversation ID 中的 task_id 部分作为 Thread 路径的 key
