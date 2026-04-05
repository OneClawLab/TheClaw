本文探讨 Agentic 系统中 Actor(Human/Agent) 之间的通信模式。
注: 这是 prime 文件，完整设计已转移至 CommunicationDesign.md

# 基本概念模型

Actor: 交互者。
  Human: 人类。
  Agent: 智能体。
Message: 交互消息。
Conversation: 交互会话。

Actor 通过参与 Conversation，发送消息 进行交互。
消息可分为 广播和定向。
  广播消息：发送给 Conversation 中的其他 Actors。
  定向消息：发送给 Conversation 中的指定 Actor。

# 一个基本的示例场景

一个 Conversation，Actors 包括: 两个 Human，一个 Front Agent。
还有一个 Worker Agent 不参与 Conversation，但可被 Front Agent 调用以完成任务。

### 会话过程

群聊中 Human1 请求 Front Agent 帮助, Front Agent 私下借助 Worker Agent 完成任务。

```
Human1: @Front Hello.
Front Agent: @Human1 Hello, how can I do for you?
Human1: @Front Please help me ...
Front Agent: @Human1 Ok, I will call a worker agent to help you.
  Front Agent: [Call Worker Agent]
  Worker Agent: Done.
Front Agent: @Human1 Here is the result.
Human2: @Front Thanks.
```

# 分析与设计

## 分析1
- Front Agent 需要知道 Conversation 里有多个 Actors
- Front Agent 需要能识别哪些消息是发给自己的
- Front Agent 需要能发起定向消息给 指定的 Actor
- Front Agent 需要知道 有 Worker Agent 的存在
- Front Agent 需要能给 Worker Agent 发送消息
- Front Agent 需要能识别 Worker Agent 的响应消息 和 哪个 Actor 的原始消息相关联

## 分析2
- Front Agent 需要同时服务 当前 Conversation 的多个 Actors，因此必须把不同 Actors 发出的请求区分开
- Front Agent 使用 Worker Agent 时，也必须能区分 每个使用 对应 哪个 Actor 的原始诉求。

## 设计1
A. Front Agent 只服务 @自己 的 Actors，并不关心其他消息。
  Front Agent 只是群聊里的一个服务者而已。和单聊没什么本质区别。
  此时用所谓 Mention Gate机制，只过滤 @Front 的消息即可。Front Agent 看到的会话，其实是 Conversation Id + Peer Id 形成的 独立会话。
B. Front Agent 会收到所有 会话消息，并酌情处理（或主动发言）。
  @自己的也不一定需要响应，不@自己的也可能会响应，甚至并非为了响应而主动发消息。
  此时 Front Agent 需要收到所有消息，但并不一定会触发处理，触发了处理也不一定产生回复。Front Agent 看到的会话 就是 其他 Actors 看到的会话。

## 设计2
- Front Agent 和 Worker Agent 的交互，需要分 Thread。
- 每个 Thread 和 Front 与 Conversation 里其他 Actor 的交互的关系，并非简单对应，可以是任何关系。
- Front Agent 需要自己记录并管理 Front-Worker Threads vs Front-Human Threads 的对应关系。

## 真实场景的抽象

多个 Front Agents，多个 Conversation，多个 Human Actors, 多个 Worker Agents。

1. 每个 Front Agent 必须确定 自己在 某个 Conversation 里的角色是哪一种: 群体会话无关的服务者(靠Mention Gate触发服务) vs 群体会话的参与者(和其他Actors无本质区别)。前者可以处理为单聊会话，后者是真正的群聊会话。两种角色下 Front Agent 的反应模式差异很大。
  我们可以把前者模式叫 Mention Mode，后者称为 Active Mode。
  一个 单聊会话 就是一个特殊的 群聊: 其他Actors 只有一个Human, 且 Front Agent 工作在 Mention Mode（但不需要显式 @，所有消息都是自动 @对方 的）。
2. Mention Mode下，Front Agent 和 其他 Actor 的交互，需要独立的 per-peer Thread 管理。
3. Active Mode下，Front Agent 和 其他 Actor 的交互，就是普通的群聊交互，不需要额外的Thread管理。或者说 Thread 就是 Conversation。
4. Front Agent 和 其他 Worker Agents 的交互，需要Front Agent主动独立的做 Thread 管理，同时需要 和 Mention Mode 下的 per-peer Thread 关联起来。
   主动独立的意思是: 并非由某个特定的 Human 消息触发，而是由 Front Agent 自己决定何时调用 Worker Agent；而且也并非调用一次Worker Agent就是一个 Thread，而是多个相关的调用在一个 Thread 下。
5. Worker Agent 并不一定只是 Worker的角色，它只是被 Front Agent 调用时扮演 Worker (Front Agent 扮演 Orchestrator)。Worker Agent 也完全可以是一个 自己下游 Sub Worker Agents 的 Orchestrator。
