# TheClaw的整体架构设计

TheClaw is a agent runtime that inherits core principles from OpenClaw with several improvements:
- Loose-coupled system architecture with composition of CLI commands. Which means:
  - Every system capability is a CLI command.
  - LLM is equiped only one `bash_exec` tool, with progressive discovery of system capabilities via builtin `cmds` CLI command.
- Event-driven architecture with Thread (stream of events with artifacts) as first-class citizen. This will:
  - Basically support agent to have persistent memory and context.
  - Keep human/agent or agent/agent collaboration consistent and easily manageable.
  - Improve system observability/auditability/recoverability/etc.

## WHY

OpenClaw 开启了一种让LLM接管整个系统的 Agentic 范式。
而这种范式催生的可扩展性，需要一个更易于探索和扩展的架构:
- 不依赖的组件可以独自进化，包括不同的实现技术/分发形式。
- 系统的上层核心逻辑可以被人类方便的观察和理解。

Unix CLI 就是这种历久弥坚的沉淀: 
- 每个命令都是一个语义稳定的可分发单元。
- 同时系统靠Shell组合能实现极其复杂的上层逻辑。

## WHY - More

**安全**:
自治Agentic系统的安全保障会相当多维和复杂，需要智能体介入进行保障维护。
- 不是简单的 允许/决绝某些 tool 调用就可以满足的: 要么导致人类很累、要么导致风险频出。
**进化**:
自治Agentic系统的进化也会相当多维和复杂，包括自我进化/人类指导或引导的进化，也需要智能体介入。
- 简单的把进化逻辑交给LLM会导致失控。
- 简单的把进化逻辑交给人类会导致门槛非常高。
- 由Agentic系统的开发者提供也不可行，自治Agentic系统的高度个性化和动态性会使得开发者根本无从掌握人类用户的需求。

以上的解决方案都是:
- 让智能体介入协调的安全和进化，但系统在结构上需要对人类保持可观察性和可控制性。

## Low-level Concepts and Designs

Actors communicating through events (with artifacts) inside persistent threads.
Actors can execute tool calls and produce artifacts.

### Actor
Actor has identify and address.
Actor can send/receive events to/from threads.
Actor can execute tool calls and produce artifacts.

**Actor Kind**:
- Agent: autonomous proactive intelligent machine.
- Human: real people who can be an owner or a peer.
  - Owner: can manage agent's lifecycle, delegate their role to this agent. 
  - Peer: agent can provide (designated) service to these peers.

### Thread
Threads are persistent semantic conversation for events and artifacts.
Threads is synonym to  "context" or "conversation" or "project" or "subject" or "task".

Thread is implemented by a sequence of events (with artifacts), stored in one filesystem directory.
Directory structure: (/means thread root directory, such as ~/threads/<thread-id>/)
  /events/current.jsonl
  /events/**/* can be internal files
  /artifacts/**/*
  /state.json

### Event
Event is the unit of communication between Actors inside Thread.

**event structure**: / timestamp / type / actor / content
**event type**:
- message: records inter-actor communication
- record: subtype = toolcall | decision | ...
  - toolcall: records actor atomic behavior when process message
  - decision: records actor decision process for external visibility
  - ... (eg: artifact lifecycle events, thread state lifecycle events)

**事件类型的设计意图**：
- 语义分层：在同一个线程里区分“说话/做事/产物/决策/状态”，保证上下文清晰。
- 事件驱动执行：不同类型事件触发不同处理逻辑。
- 追踪因果：明确 action → result → plan → state 的因果链。
- 便于协作：区分 agent 内部推理（toolcall/artifact/private plan）和对外共享（decision/shared plan/artifact）。

普通agent只:
1. 必须的: send/receive messages
2. push 自己引发的 toolcall / artifact / decision 事件 到 thread event stream
   NOTE: 这一点可以由 runtime 来 enfore，而不是让agent自己写。
特殊agent会处理更多事件,如负责安全设计/升级维护/自我进化等职责的 agent。

### Artifact
  actor 执行 toolcall 时产生的构建物(文件)。
  被 event 引用。属于相应的 Thread。

## High-level Concepts and Designs

### Agents

**System Agents**:
admin: 系统管理员，面向用户。下面的其他三个不直接和用户打交道。
warden: 安全/审计/合规。
maintainer: 升级/维护。
evolver: 自我迭代/学习/优化。

**User Agents**:
由用户通过和admin交互创建。
默认在onboarding时只创建一个。

**Agent目录设计**:
agents/<agent_id>/
  IDENTIFY.md
  workdir/* → 私有 工作区，可存放plan等临时信息，仅自己可见。
  ...

### Threads

agents/<agent_id>/
  inbox/* → 私有 thread，只能自己读写
  memory/* → 私有 thread，只能自己读写
  tasks/<task_id>/  → 非共享 thread，仅自己可见
threads/
  tasks/<task_id>/  → 共享 thread，可被多个 agent 订阅  
  archive/<thread_id>/* → 历史 thread，可回溯
  global/<subject>/* → 系统 thread，默认订阅者是系统 agent

## Gateway & Routing

- peer: 一个和agent交互的实体(一个自然人或一个智能体)
- channel: 通信通道, 如一个单聊(包括本机CLI会话/远端IM会话)，一个群聊，一个频道 (IM app是一个channel type, channel指一个具体的会话)
- gateway: agent 和 外部peer 通信的网关

peer → channel → gateway → agent.inbox → thread → agent → thread → (dispatcher) → gateway → channel → peer

gateway的职责:
  1. 身份确认
  - peer identity
  - channel identity
  - session identity
  2. channel 统一
    把不同通道统一成同一种 message
  3. 路由到 agent
    (peer, channel) → agent
  gateway不负责路由到thread, 因为thread是语义概念，而gateway不知道语义。

原则: 
  gateway 只处理跨系统通信
  系统内部通信不经过 gateway
  thread 是内部通信的主要媒介
  agent inbox 只是一个特殊 thread

agent 设置一个 inbox (ingress queue)，供gateway投递消息。
agent 自己将 inbox里的 消息 路由到 thread (或创建新thread)。
agent 产生的消息，直接投递到 thread 里，然后由统一的 dispatcher 负责转发。
优化路径: 当 消息自带 thread_id 时，可以直接投递到 thread (但最好让inbox做一层转发，保证agent行为的一致性)
