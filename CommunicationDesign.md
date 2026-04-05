本文探讨 Agentic 系统中 Actor(Human/Agent) 之间的通信模式。

## 1. 问题空间

### 1.1 基本元素

Agentic 系统中的通信涉及三类基本元素：

**Actor**：系统中的参与者，拥有身份标识，可以发送和接收消息。Actor 分为两种：Human（自然人）和 Agent（自治智能体）。Agent 与 Human 的本质区别在于：Agent 的行为由代码和 LLM 驱动，可以在无人干预的情况下持续运行；Human 的行为不可预测，只能被动等待。

**Conversation**：一组 Actor 共同参与的消息空间。Conversation 有类型之分：单聊（两个 Actor）、群聊（多个 Actor）。消息在 Conversation 中可以是广播（所有参与者可见）或定向（指定接收者）。

**Thread**：持久化的事件流容器，是 Agent 处理消息的上下文单元。Thread 与 Conversation 不是一一对应的关系——这是整个设计的核心复杂性来源。

**Turn**：Agent 对一条入站消息的完整处理过程。Turn 从消息写入 Thread 开始，经历一次或多次 LLM 调用（含 tool call 序列），到 LLM 不再产出新的 tool call、最终 text response 生成完毕为止。Turn 是持有 Thread lock 的最小单元——同一 Thread 内的 Turn 严格串行，Turn 结束即释放 lock。一个 Turn 内可能包含多轮 LLM 调用（每次 tool call 后重新调用 LLM），但对外表现为一个原子处理单元。

### 1.2 问题的五个维度

真实场景的复杂性来自五个正交维度的组合：

1. **Agent 角色**：同一个 Agent 在不同场景下可以是面向 Human 的服务者（Front）、被上游委派的执行者（Worker）、向下游委派任务的协调者（Orchestrator），或者同时是后两者。
2. **响应自主权**：Agent 对收到的消息，是有问必答（Reactive），还是自主决定是否回复（Autonomous）。这与 Conversation 是单聊还是群聊正交——单聊下 Agent 也可以选择不回复，群聊下 Agent 也可以被配置为有问必答。
3. **触发来源**：Human 消息、Agent 消息、定时任务、Agent 主动发起。
4. **任务复杂度**：单步完成、单跳委派、多跳串行、多路并行（fan-out）后汇总（fan-in）。
5. **时间模型**：同步（委派后等待结果再回复）、异步（委派后立即回复，结果另行通知）。

这五个维度的任意组合都必须被系统正确处理。

### 1.3 核心矛盾

系统面临两个根本性的矛盾：

**矛盾一：Thread 的归属问题。** Reactive 模式下 Agent 需要为每个 Human peer 维护独立的上下文（per-peer Thread），但 Agent 向 Worker 委派任务时，这个委派关系可能跨越多个 peer 的请求，也可能与任何 peer 请求无关（Agent 主动发起）。Thread 的边界如何划定，直接决定了 Agent 能否正确理解"当前任务是为谁服务的"。

**矛盾二：Turn 的结束时机问题。** Agent 的一次处理（Turn）在所有 tool call 执行完毕、LLM 产出最终 text response 后即完成，但任务可能尚未完成（等待 Worker 返回结果）。如果 Turn 不结束，Thread 的 lock 持续占用，后续消息无法进入；如果 Turn 结束，Agent 如何在 Worker 返回后重新被唤醒并关联到原始任务上下文？

---

## 2. 抽象模型

### 2.1 Conversation Identity 的两个层次

系统中存在两种性质不同的 Conversation，必须分开建模：

**External Conversation**：Agent 与 Human 之间，由外部渠道（IM 平台等）决定 ID，Agent 无法控制其生命周期。标识格式：`external:<channel>:<type>:<conv_id>`。

**Internal Conversation**：Agent 与 Agent 之间，由系统内部创建和管理，生命周期由 Orchestrator 控制。标识格式：`internal:<orchestrator_id>:<task_id>`。

Internal Conversation 的 ID 不能随每次消息随机生成，也不能全局共享。正确的模型是：Orchestrator 在决定开启一次协作时生成 `task_id`，同一个 task 下对所有 Worker 的通信共享这个 `task_id` 作为 conv_id。这保证了多次交互的上下文连续性，也使 fan-in 的等待逻辑有了明确的锚点。

### 2.2 Thread 分配策略

Thread 是 Agent 处理消息的上下文单元，其分配策略决定了 Agent 的"记忆边界"：

| 场景 | 分配策略 | Thread 路径 |
|------|---------|------------|
| Reactive，单聊 | per-peer | `threads/peers/<peer_id>/` |
| Reactive，群聊（触达过滤后） | per-conversation-peer | `threads/conversations/<conv_id>/peers/<peer_id>/` |
| Autonomous，群聊或单聊 | per-conversation | `threads/conversations/<conv_id>/` |
| Agent 间通信（作为 Worker） | per-internal-conv | `threads/internal/<task_id>/` |

Reactive 模式下，单聊与群聊的 Thread 分配策略不同，原因是**隐私隔离**：群聊中 Agent 的回复对所有成员可见，如果 Agent 把单聊或其他群聊里积累的 per-peer 上下文带入当前群聊，就会在公开场合泄露该 peer 的私密信息。因此群聊下必须以 `conv_id` 为前缀，将同一个 peer 在不同 conversation 中的上下文严格隔离。单聊本身是私密的，per-peer 分配即可，无需 conv_id 前缀。

关键约束：**同一 Thread 内串行处理，不同 Thread 间并发**。这个约束保证了上下文的一致性，但也是矛盾二的来源——需要专门的机制来解决。

### 2.3 Task 对象：解决 fan-out/fan-in 的核心抽象

引入 Task 作为代码层的协调单元，独立于 Thread 存在：

```
Task {
  task_id        // 全局唯一，由 Orchestrator 生成
  owner          // Orchestrator agent_id
  origin {       // 触发这个 task 的原始来源
    thread_id    // 来自哪个 Thread（可能是 per-peer thread）
    event_id     // 来自哪条消息
    reply_target // 最终结果交给谁（peer_id 或 agent_id）
  }
  status         // pending | waiting | done | failed | cancelled
  subtasks []    // fan-out 的子任务列表
}

SubTask {
  subtask_id     // 在 task 内唯一
  worker         // worker agent_id
  instruction    // 委派给 worker 的任务描述
  status         // pending → sent → done | failed
  result         // worker 的 plain text 结果（done/failed 后填充）
}
```

**SubTask 状态转换**：
- `pending`：create_task 创建时的初始状态
- `sent`：框架已向 worker 发送委派消息
- `done`：worker announce 回来，结果正常
- `failed`：worker announce 回来，内容为失败报告

Task 的 `status` 由 subtask 状态驱动：所有 subtask 进入 `sent` 后 task 变为 `waiting`；所有 subtask 终结（`done` 或 `failed`）后 task 变为 `done`（至少一个 `failed` 时 task 也变为 `done`，由 LLM 在汇总 Turn 中决定如何处理失败）。

Task 对象持久化在 Orchestrator 的工作目录中，不进入 Thread 的事件流。Thread 只记录消息，Task 记录协调状态——两者职责分离。

#### create_task Tool Schema

```
create_task {
  parameters: {
    subtasks: Array<{
      worker: string        // "agent:<agent_id>"
      instruction: string   // 委派给 worker 的任务描述
    }>
    wait_all: boolean       // true: fan-in，等所有 subtask 完成后触发汇总 Turn
                            // false: fire-and-forget，不等待结果
  }
  returns: {
    task_id: string         // 创建的 task ID
    status: string          // "waiting" 或 "sent"
  }
}
```

框架在执行 `create_task` 时自动完成：
- 生成 task_id，创建 Task 对象
- 从当前 Turn 的上下文推断 `origin.reply_target`（来自 Human 消息时填 peer_id，来自 agent 委派时填上游 agent_id）
- 向每个 worker 发送委派消息（internal 消息，携带 `reply_to` 字段指向 owner agent）
- 更新 subtask status 从 `pending` 到 `sent`

### 2.4 Agent Loop 的状态机

Agent 的处理循环不是简单的"收消息 → LLM → 出站"，而是一个状态机：

```
收到消息
  ├─ 来自 External（Human）
  │    → 正常 Turn
  │    → LLM 可能创建 Task（通过 create_task tool，框架自动填充 origin.reply_target）
  │    → 若 Task 创建且需等待所有 subtask：Turn 结束，不出站，Task status=waiting
  │    → 若无 Task 或无需等待：正常出站
  │
  ├─ 来自 Internal（Worker announce，框架通过 internal conv_id 反查到对应 Task）
  │    → 代码层更新对应 subtask 的 status 和 result
  │    → 若 task 已 cancelled：丢弃该 announce，不做任何处理
  │    → 检查是否所有 subtask 已终结（done 或 failed）
  │         → 否：继续等待，不触发 LLM
  │         → 是：触发"汇总 Turn"，注入所有 subtask 结果（含失败信息）
  │              → LLM 综合结果，出站给 origin.reply_target
  │
  └─ 来自 Internal（Orchestrator 委派，消息携带 reply_to 字段）
       → Worker Turn
       → LLM 处理，产出 plain text
       → Turn 结束后，框架读取消息的 reply_to 字段，自动 announce 结果给该目标
       → announce 消息本身不携带 reply_to（防止 ping-pong 循环）
```

**Turn 结束时机的解决方案**：Turn 的结束等于所有 tool call 执行完毕且 LLM 产出最终 text response，永远不跨 Turn 持有 Thread lock。等待 Worker 结果期间，Thread lock 已释放，Human 的后续消息可以正常进入（框架在新 Turn 的 Communication Context 中注入 pending task 状态，LLM 据此可以告知 Human"处理中"）。Worker 的 announce 进入 Orchestrator 的 internal Thread，触发新的 Turn，与原始 Human 消息的 Turn 完全解耦。

### 2.5 角色的动态性

Agent 没有静态的"Front"或"Worker"标签。角色是每个 Turn 开始时由入站消息决定的动态状态：

- 入站来自 External → 当前 Turn 角色为 Front
- 入站来自 Internal + 消息携带 reply_to → 当前 Turn 角色为 Worker
- 入站来自 Internal + 无 reply_to → 当前 Turn 角色为 Participant（被通知）
- 入站为 Task 汇总触发 → 当前 Turn 角色为 Orchestrator（综合结果）

同一个 Agent 在不同 Turn 里可以扮演不同角色，这是系统灵活性的来源。"Worker 也可以是 Orchestrator"不是特殊情况，而是这个模型的自然推论：一个 Agent 在某个 Turn 里是 Worker（响应上游委派），在同一个 Turn 里可以通过 create_task 向下游委派，此时它同时持有两个角色，但这两个角色的责任边界是清晰的。

### 2.6 Turn 内用户干预（Mid-Turn Injection）

对于执行时间较长、包含大量串行 tool call 的 Turn，Human 可能在 Turn 进行中发送补充指令。这类消息不应该排队等 Turn 结束，而应该及时影响 LLM 后续的 tool call 规划。

**实现方式：通过虚拟 tool 通道注入，而非插入裸 user 消息。**

直接在 messages 数组中间插入 `user` role 消息会破坏 assistant/tool 的交替结构，导致部分 LLM 行为不稳定。正确的做法是引入一个虚拟 tool `receive_user_update`，由框架在 tool call 执行间隙自动注入：

```
assistant: [tool_call_1]
tool:       [tool_result_1]
assistant: [tool_call: receive_user_update]   ← 框架检测到新消息，自动插入
tool:       { content: "用户补充：只需要分析第一章" }
assistant: [tool_call_2，已考虑用户补充]
tool:       [tool_result_2]
...
```

`receive_user_update` 不需要 LLM 主动调用，完全由框架驱动：在每次 tool 执行完、下一次 LLM 调用前，检查 Thread 是否有新的 Human 消息；如有，自动构造一次 `receive_user_update` tool call + result 插入 messages。

System prompt 中需要说明这个机制：

```
A special tool `receive_user_update` may appear in your tool call history.
It carries real-time updates from the user during task execution.
Treat its content as refinements to your current task, not a new request.
```

**适用范围**：仅适用于 Turn 内部（LLM 正在执行 tool call 序列期间）。Turn 结束后（Task status=waiting 等待 Worker 期间）的新消息走正常的新 Turn 流程，不需要此机制。

**与 Thread 的关系**：注入的消息同时写入 Thread 事件流（`type=record`，标记为 `mid_turn_injection`），保证历史可追溯，也使后续 Turn 的 context 构建能感知到这条消息曾经发生过。

**并发安全**：Thread lock 是 consumer 级别的锁（控制"谁在处理这个 Thread"），不是写入锁。外部消息写入 Thread（追加事件）不需要获取 consumer lock，只受 SQLite WAL 模式的写入并发控制。因此 Turn 持有 consumer lock 期间，Human 的新消息仍然可以正常写入 Thread。Mid-turn injection 只是在 tool call 间隙读取这些新写入的事件，不存在死锁。

### 2.7 Task 取消（Cancel Task）

Task 取消是系统提供的底层机制，具体何时取消、是否重新创建新 task 属于业务决策，由 LLM 判断。

#### 触发方式

Cancel 只能由 task 的 owner（Orchestrator）发起，通过 `cancel_task(task_id)` tool 调用触发。典型场景：Human 在 Task 等待期间发来修订或取消指令，LLM 在新 Turn 里判断需要取消当前 task。

#### 执行过程

```
LLM 调用 cancel_task(task_id)
  → 代码层将 task status 改为 cancelled
  → 遍历所有 status=sent/waiting 的 subtask
    → 向每个 subtask 的 worker 发送取消通知
       （internal 消息，不携带 reply_to，subtype=cancellation）
  → 返回 { cancelled: true }

Worker 收到取消通知（新 Turn）：
  → 若 worker 自身也是 Orchestrator（有下游 task）：
    → LLM 调用 cancel_task 取消自己的下游 task（级联向下传播）
  → 若 worker 没有下游 task：
    → LLM 产出 plain text 说明取消原因
    → 框架照常 announce 给上游
    → 代码层检测到上游 task 已 cancelled，丢弃该 announce，不触发汇总 Turn
```

#### 关键设计点

**级联是异步的**：Orchestrator 发出取消通知后立即返回，不等 Worker 确认。Worker 在自己的下一个 Turn 里处理取消。Cancel 的语义是"尽力取消"，不保证立即停止。

**正在执行中的 Turn 无法被强制中断**：若 Worker 的 Turn 正在运行（LLM 执行 tool call 序列中），取消通知排队等该 Turn 结束后才被处理。可通过 mid-turn injection 机制缓解——Worker 在 tool call 间隙检测到取消通知，提前终止当前 Turn。

**cancel 后可立即重新委派**：Orchestrator 取消旧 task 后，可在同一 Turn 内用修订后的参数重新调用 `create_task`。这是"修订"场景的完整流程：`cancel_task` → `create_task`（新参数）。

**Human 不感知内部过程**：Human 发来修订指令 → LLM 回复确认 → 后台 cancel 旧 task + 启动新 task。cancel 的级联传播对 Human 完全透明。

---

## 3. 分层解决方案

整个设计遵循一个核心原则：**代码层处理确定性的结构问题，LLM 层处理语义判断问题。** 凡是可以通过算法确定的，不进 Prompt；凡是需要理解语义才能判断的，不写死在代码里。

### 3.1 代码层职责

**Conversation Identity 管理**：维护 External 和 Internal Conversation 的 ID，Internal conv_id 由 Orchestrator 在创建 Task 时生成，与 task_id 绑定。

**Thread 分配**：根据消息来源和 Agent 配置，自动决定消息进入哪个 Thread。Reactive 单聊按 per-peer 分配；Reactive 群聊按 per-conversation-peer 分配（`conv_id` + `peer_id` 双重前缀，防止跨 conversation 的隐私泄露）；Autonomous 模式按 per-conversation 分配；Internal 消息按 task_id 分配到对应的 internal Thread。

**Task 生命周期管理**：创建、持久化、更新 Task 对象；检测 fan-in 完成条件；触发汇总 Turn；处理 cancel 请求（更新 status、向 subtask workers 发送取消通知、丢弃已 cancelled task 的 announce）。

**Fan-in 等待逻辑**：完全在代码层实现，LLM 不参与"是否所有 subtask 都完成了"的判断。

**Worker announce 路由**：Worker Turn 结束后，框架读取入站委派消息的 `reply_to` 字段，自动将 LLM 的 text response announce 给该目标，无需 Worker LLM 主动调用任何 tool。announce 消息本身不携带 `reply_to`，链条一跳即止。

**触达过滤（Reactive 模式的群聊配置）**：Reactive 模式下，群聊中未触发 mention 的消息写入 Thread 但标记为 `type=record`（仅上下文，不触发 LLM）；触发 mention 的消息标记为 `type=message`（触发 LLM）。触达过滤是 Reactive 模式在群聊场景下的一个配置项（`trigger: mention | all`），不是独立的模式。Autonomous 模式下所有消息都进入处理流程，由 LLM 自主决定是否回复。

**Mid-Turn Injection**：Turn 执行期间（tool call 序列进行中），在每次 tool 执行完后检查 Thread 是否有新的 Human 消息。如有，自动构造 `receive_user_update` tool call + result 插入当前 messages，使 LLM 在下一次调用时能感知用户的补充指令。注入的消息同时写入 Thread 事件流（`type=record, subtype=mid_turn_injection`）。

**Thread lock 管理**：保证同一 Thread 内串行，Turn 结束即释放 lock，永不跨 Turn 持有。Mid-turn injection 期间 lock 不释放，只是在 tool call 间隙读取新消息并注入，不影响串行保证。

### 3.2 LLM 层职责（Communication Context 注入）

每次 LLM 调用前，框架注入 Communication Context，告知 LLM 当前的处境。Context 的结构因角色而异，但遵循统一的组织原则：**身份锚点在最前，出站义务明确单一，可用工具列在最后**。

**场景 A：Reactive 模式，来自 Human（单聊或群聊 mention 触达后）**
```
You are: agent:admin | Role: Front (Reactive)
Conversation: dm/group with peer:alice (via telegram:main)
Current message from: peer:alice
Your text response → streamed to peer:alice
Available agents: analyst, researcher
```

Reactive 模式下，框架保证触达即回复，LLM 不需要做"要不要回复"的决策，直接产出内容即可。

**场景 B：Autonomous 模式，来自 Conversation（单聊或群聊）**
```
You are: agent:admin | Role: Autonomous Participant
Conversation: group grp-123 (via telegram:main)
Recent participants: alice, bob, charlie
Current message from: peer:bob
You decide whether to respond.
  → If yes: produce your response (will be delivered to the conversation)
  → If no: return empty response (stay silent)
Available agents: analyst, researcher
```

Autonomous 模式的关键设计：**把"要不要发言"的决策显式交给 LLM**，代码层不做强制触发。LLM 返回空 response 即为沉默。单聊下的 Autonomous 模式与此相同，只是 participants 只有一个 Human——Agent 是对等的聊天者，不是服务者，有权选择不回复。

**场景 C：Worker，收到 Orchestrator 委派（尚未向下游 fan-out）**
```
You are: agent:analyst | Role: Worker
Delegated by: agent:admin (task-101)
Your mission: "对比分析 A 和 B 两份报告，给出结论"
Your output obligation: plain text result → automatically returned to agent:admin
                        DO NOT use send_message to reply to admin.

To complete your mission, you may delegate sub-tasks via create_task.
If you delegate, your turn ends. You will be re-invoked when sub-tasks complete.
Available agents: reader, summarizer
```

**场景 D：Worker 兼 Orchestrator，sub-tasks 全部完成，被唤醒汇总**
```
You are: agent:analyst | Role: Worker (synthesizing)
Delegated by: agent:admin (task-101)
Your mission: "对比分析 A 和 B 两份报告，给出结论"
Your output obligation: plain text result → automatically returned to agent:admin
                        DO NOT use send_message to reply to admin.

Sub-task results (all complete):
  [reader]     → "报告A的核心论点是..."
  [summarizer] → "报告B的核心论点是..."

Now synthesize the above and produce your final output.
Do NOT delegate further.
```

**场景 E：Orchestrator，收到所有 Worker 结果，汇总回复 Human**
```
You are: agent:admin | Role: Orchestrator (synthesizing)
Task ID: task-001
Origin: peer:alice asked "分析这份报告"
Sub-task results (all complete):
  [analyst]    → "..."
  [researcher] → "..."
Your text response → streamed to peer:alice
```

**场景 F：Orchestrator，fan-out 进行中（部分 subtask 完成）**
```
You are: agent:admin | Role: Orchestrator (waiting)
Task ID: task-001, origin: peer:alice
Subtask status:
  [analyst]    → done ✓
  [researcher] → pending...
No action required. Optionally send interim update to peer:alice.
```

### 3.3 防混乱的设计要点

当一个 Agent 同时是 Worker（响应上游）和 Orchestrator（委派下游）时，Context 的组织方式至关重要：

1. **身份锚点唯一**：`Role: Worker` 始终在第一行，不因"我也在向下游委派"而改变。向下游委派是完成任务的手段，不是身份的切换。

2. **出站义务单一且明确**：每个 Turn 只有一个出站目标，且明确写出。Worker 的出站义务是"结果交给上游 Orchestrator"，这个义务不因向下游委派而改变。

3. **禁止指令明确**：Worker 的 Context 中明确写 `DO NOT use send_message to reply`，防止 LLM 在框架已经自动 announce 的情况下又主动发送，导致重复回复。

4. **task_id 贯穿始终**：同一个 task 的所有 Turn（初次委派、等待、汇总）都携带相同的 task_id，LLM 在不同 Turn 里能感知到"我在同一个任务里"，不会把汇总 Turn 当成全新请求。

5. **递归透明**：每一层 Agent 只看到自己的直接上游和直接下游，不感知整个调用链的深度。analyst 不知道 admin 的存在，reader 不知道 analyst 的存在。这使得递归委派在心智模型上保持简单。

---

## 4. 完整场景验证

以"多个 Human 同时请求，Front Agent 对每个请求 fan-out 给多个 Worker，Worker 内部也有子委派"为例，验证上述模型的完备性：

```
Alice → admin: "帮我分析报告X"
Bob  → admin: "帮我搜索话题Y"

admin 处理 Alice 的请求（alice Thread）：
  → create_task(subtasks=[analyst, researcher], wait_all=true)
  → task-001 创建：{ owner: admin, origin.reply_target: peer:alice, status: waiting }
  → Turn 结束，alice Thread lock 释放

admin 处理 Bob 的请求（bob Thread）：
  → create_task(subtasks=[searcher], wait_all=true)
  → task-002 创建：{ owner: admin, origin.reply_target: peer:bob, status: waiting }
  → Turn 结束，bob Thread lock 释放

analyst 收到 task-001 的委派（internal Thread: admin/task-001）：
  → Role: Worker，mission: 分析报告X
  → create_task(subtasks=[reader, summarizer], wait_all=true)
  → task-001-a 创建：{ owner: analyst, origin.reply_target: agent:admin, status: waiting }
  → Turn 结束

reader 完成 → announce 给 analyst
summarizer 完成 → announce 给 analyst
  → 代码层检测 task-001-a 全部完成
  → 触发 analyst 的汇总 Turn
  → analyst 产出分析结论，框架 announce 给 agent:admin（来自 task-001-a 的 origin.reply_target）

researcher 完成 → announce 给 agent:admin（来自 task-001 的 origin.reply_target）
  → 代码层检测 task-001 的 analyst 和 researcher 都完成
  → 触发 admin 的汇总 Turn（注入两个结果）
  → admin 综合结论，text response → streamed to peer:alice

searcher 完成 → announce 给 agent:admin（来自 task-002 的 origin.reply_target）
  → 代码层检测 task-002 全部完成
  → 触发 admin 的汇总 Turn
  → admin text response → streamed to peer:bob
```

整个过程中：
- Alice 和 Bob 的请求完全隔离（不同 Thread，不同 Task）
- analyst 的子委派对 admin 透明（admin 只等 analyst 的最终结果）
- 所有 Turn 都在 LLM 调用结束后立即释放 lock，无死锁风险
- 每个 Agent 在每个 Turn 里的 Communication Context 都是清晰单一的

---

## 5. 设计边界

本模型有意不处理以下问题，将其留给具体实现决策：

- **Task 超时与失败恢复**：subtask 失败时 Orchestrator 如何决策（重试、降级、报错），属于业务逻辑，不属于通信模型。
- **Worker 的失败报告**：Worker 无法完成任务时，直接在 plain text response 中说明原因，框架照常 announce 给 Orchestrator。Orchestrator 的 LLM 收到后自行判断是否重试、降级或向 Human 报错，不需要额外的 tool。
- **跨系统的 Agent 通信**：本模型假设所有 Agent 在同一个运行时内，跨系统通信需要在 External Conversation 层面处理。
- **Human 在 Autonomous 模式下的定向消息**：Autonomous 模式中 Human 向特定 Agent 发定向消息的语义，由具体渠道的 mention 机制决定，不在本模型范围内。
