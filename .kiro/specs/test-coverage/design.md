# 设计文档：测试覆盖补全

## 概述

本设计文档描述如何系统性地为多 repo TypeScript ESM CLI 工具集补全测试覆盖。测试分三个阶段实施：

- **阶段一**：补齐稳定 repo 的 intra-repo 集成测试（thread、notifier、xdb、xweb）
- **阶段二**：补齐跨 repo 集成测试（thread↔notifier、xgw↔thread、agent↔thread↔pai）
- **阶段三**：系统级 E2E 测试（TheClaw setup、全链路）

所有测试遵循 repo-convention.md 和 testing-convention.md 的约定：使用 vitest + fast-check，测试文件放在各 repo 的 `vitest/integration/` 目录，跨 repo 集成测试放在 `TheClaw/vitest/integration/`。

## 架构

### 测试分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  阶段三：系统级 E2E（TheClaw/vitest/integration/）           │
│  full-pipeline.test.ts                                       │
├─────────────────────────────────────────────────────────────┤
│  阶段二：跨 repo 集成测试（TheClaw/vitest/integration/）     │
│  thread-notifier.test.ts                                     │
│  xgw-thread.test.ts                                          │
│  agent-pipeline.test.ts                                      │
├──────────────┬──────────────┬──────────────┬────────────────┤
│  阶段一：intra-repo 集成测试（各 repo 内）                   │
│  thread/     │  notifier/   │  xdb/        │  xweb/         │
│  integration/│  integration/│  integration/│  integration/  │
│  thread.test │  daemon.test │  collection  │  cli.test.ts   │
│  .ts         │  .ts         │  .test.ts    │                │
└──────────────┴──────────────┴──────────────┴────────────────┘
```

### Mock 策略

| 测试层级 | Mock 内容 | 真实内容 |
|---------|-----------|---------|
| intra-repo 集成 | 无（或仅 mock execCommand 用于 notifier 调度） | 文件系统、SQLite、进程管理 |
| 跨 repo 集成 | execCommand（外部 CLI 调用）、LLM API | 文件系统、路由逻辑、消息格式 |
| E2E | execShell/execCommand（外部命令）、LLM API | 文件系统、配置读写、完整流程 |

## 组件与接口

### 阶段一：intra-repo 集成测试

#### 1. thread 集成测试（`thread/vitest/integration/thread.test.ts`）

直接调用 thread 的内部模块（`openDb`、`insertEvent`、`popEvents` 等），使用真实 SQLite，在 tmpdir 中运行。

关键测试场景：
- `initCmd` → 验证目录结构和 `events.db` 创建
- `pushCmd` → 验证事件写入 SQLite
- `subscribeCmd` + `popCmd` → 验证 round-trip 读写
- batch push → 验证批量写入和顺序
- filter pop → 验证过滤逻辑
- consumer_progress 更新验证
- 错误路径：未初始化目录

```typescript
// 测试辅助：创建临时 thread 目录
async function createTmpThread(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'thread-integration-'))
  await initCmd({ thread: dir })
  return dir
}
```

#### 2. notifier 集成测试（`notifier/vitest/integration/daemon.test.ts`）

通过 CLI 进程（`npx tsx src/index.ts`）测试 notifier 命令，使用真实文件系统，mock 掉实际的命令执行（executor）。

关键测试场景：
- `notifier start` → PID 文件创建
- `notifier stop` → PID 文件删除
- `notifier task add` → 任务文件出现在 pending 目录
- `notifier status`（daemon 未运行）→ running: false
- 重复 `notifier start` → exit 1
- `notifier timer add` → 定时器文件出现

```typescript
// 使用 NOTIFIER_HOME 环境变量隔离测试目录
const env = { ...process.env, NOTIFIER_HOME: tmpDir }
```

#### 3. xdb 集成测试（`xdb/vitest/integration/collection.test.ts`）

直接调用 `CollectionManager`、`DataWriter`、`DataFinder` 等类，使用真实 SQLite（relational 策略），mock 掉 embedder（避免真实 LLM 调用）。

关键测试场景：
- `CollectionManager.init` → 目录和 meta 文件创建
- 重复 init → PARAMETER_ERROR
- `DataWriter.write` → SQLite 持久化
- `DataFinder.find({ match: true })` → FTS 查询
- `CollectionManager.remove` → 目录删除
- `CollectionManager.list` → 返回所有 collection
- 无 id 字段 → 自动生成 UUID

```typescript
// mock embedder（不调用真实 LLM）
const mockEmbedder: Embedder = {
  embed: async (text: string) => new Array(384).fill(0).map(() => Math.random()),
  embedBatch: async (texts: string[]) => texts.map(() => new Array(384).fill(0).map(() => Math.random())),
}
```

#### 4. xweb CLI 集成测试（`xweb/vitest/integration/cli.test.ts`）

通过 `npx tsx src/index.ts` spawn 真实 CLI 进程，验证 exit code 和输出格式。

关键测试场景：
- `xweb --help` → exit 0，stdout 包含命令说明
- `xweb --version` → exit 0，版本号格式正确
- `xweb fetch`（缺参数）→ exit 2
- `xweb search`（缺参数）→ exit 2
- `xweb config --show` → exit 0
- `xweb unknown-cmd` → exit 非 0

### 阶段二：跨 repo 集成测试

所有跨 repo 集成测试放在 `TheClaw/vitest/integration/`。

#### 5. thread ↔ notifier（`TheClaw/vitest/integration/thread-notifier.test.ts`）

测试 thread push 触发 notifier 调度的链路。Mock `execCommand`（捕获 notifier 调用），使用真实 SQLite。

关键测试场景：
- push 后验证 `execCommand('notifier', ...)` 被调用
- 验证 task-id 包含 threadDir 路径编码
- notifier 不可用时 push 仍成功（错误容忍）
- scheduleDispatch 收到 exit 1 不抛出错误

```typescript
vi.mock('../../../thread/src/repo-utils/os.js', () => ({
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))
```

#### 6. xgw ↔ thread（`TheClaw/vitest/integration/xgw-thread.test.ts`）

测试 xgw InboxWriter 将消息写入 agent inbox thread 的链路，以及 Router 路由逻辑。Mock `execCommand`（捕获 thread push 调用）。

关键测试场景：
- `InboxWriter.push` → 验证 thread push 调用参数
- source 字段格式验证（`external:<channelType>:<channelId>:dm:<sessionId>:<peerId>`）
- `Router.resolve` 精确匹配优先于通配符
- `Router.resolve` 无匹配返回 null
- agent 不存在时 InboxWriter 报错

```typescript
vi.mock('../../../xgw/src/repo-utils/os.js', () => ({
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))
```

#### 7. agent ↔ thread ↔ pai（`TheClaw/vitest/integration/agent-pipeline.test.ts`）

测试 agent 消息处理完整链路。Mock `execCommand`、LLM 调用，使用真实文件系统。

注意：`agent/vitest/integration/integration.test.ts` 已有完整的 init→start→run→deliver 测试。本测试聚焦于**跨 repo 视角**：验证 agent 与 thread、xgw 之间的接口契约。

关键测试场景：
- agent run 消费 inbox 消息 → 验证 consumeMessages 调用
- agent run 处理消息 → 验证 invokeLlm 调用
- agent run 完成 → 验证回复写入 peer thread
- agent run 完成 → run.lock 清理
- agent deliver → xgw send 调用

### 阶段三：系统级 E2E 测试

#### 8. TheClaw setup E2E（扩展 `TheClaw/vitest/integration/setup.test.ts`）

注意：`TheClaw/vitest/integration/setup.test.ts` 已有完整的 setup 原语测试。本阶段在此基础上补充**完整 setup 命令流程**的 E2E 测试（`TheClaw/vitest/integration/setup-e2e.test.ts`）。

关键测试场景：
- 完整 setup 流程：config 创建 → profile 加载 → 步骤执行 → 完成标记
- 幂等性：重复执行 setup 跳过已完成步骤
- smoke-test 步骤：验证 notifier status 和 agent status 调用

#### 9. 全链路 E2E（`TheClaw/vitest/integration/full-pipeline.test.ts`）

测试从 xgw 收到外部消息到最终投递回复的完整链路。Mock 所有外部 CLI 调用（execCommand），使用真实文件系统。

关键测试场景：
- xgw InboxWriter 写入消息 → thread push 调用
- agent 消费消息 → LLM 调用 → 回复写入 peer thread
- agent deliver → xgw send 调用
- 全链路完成 → consumer_progress 更新

## 数据模型

### 测试辅助类型

```typescript
// 通用临时目录管理
interface TmpDirContext {
  dir: string
  cleanup: () => Promise<void>
}

// thread 测试辅助
interface ThreadTestContext {
  threadDir: string
  db: Database.Database
}

// xgw 消息构造辅助
function makeMessage(overrides?: Partial<Message>): Message {
  return {
    id: 'msg-1',
    channel_id: 'telegram',
    peer_id: 'user42',
    peer_name: 'Test User',
    session_id: 'sess-1',
    text: 'Hello',
    attachments: [],
    reply_to: null,
    created_at: new Date().toISOString(),
    raw: {},
    ...overrides,
  }
}
```

## 正确性属性

*属性（Property）是一种在所有有效输入上都应成立的系统特征或行为——本质上是对系统应该做什么的形式化陈述。属性作为人类可读规范与机器可验证正确性保证之间的桥梁。*

### 属性 1：thread push-pop round-trip

*对于任意* 有效的 push payload（source、type、content 均为非空字符串），执行 push 后再执行 pop，应能读回该事件，且事件内容与 push 时一致。

**Validates: Requirements 1.2, 1.3**

### 属性 2：thread batch push 顺序不变量

*对于任意* N 条事件的 batch push，push 后数据库中应恰好新增 N 条事件，且 id 单调递增（保持插入顺序）。

**Validates: Requirements 1.4**

### 属性 3：thread pop filter 过滤正确性

*对于任意* SQL WHERE 子句 filter，pop 返回的所有事件都应满足该 filter 条件，且不满足条件的事件不应出现在结果中。

**Validates: Requirements 1.5**

### 属性 4：thread consumer_progress 单调递增

*对于任意* consumer，每次 pop 调用后，consumer_progress 中记录的 last_acked_id 应等于本次传入的 last_event_id，且不小于上次的值。

**Validates: Requirements 1.6**

### 属性 5：xdb write-find round-trip

*对于任意* 有效的记录对象，写入 relational 策略的 collection 后，通过 --match 查询应能找到该记录（当查询词出现在 FTS 索引字段中时）。

**Validates: Requirements 3.3, 3.4**

### 属性 6：xdb collection list 计数不变量

*对于任意* N 个不同名称的 collection，依次 init 后，list 返回的 collection 数量应等于 N。

**Validates: Requirements 3.6**

### 属性 7：xdb 自动 UUID 生成

*对于任意* 不含 id 字段的记录，写入后查询应能找到该记录，且记录具有非空的 id 字段（UUID 格式）。

**Validates: Requirements 3.7**

### 属性 8：thread push 触发 notifier 调度

*对于任意* 有效的 push 操作，scheduleDispatch 应被调用，且生成的 task-id 是 threadDir 路径的确定性编码（相同路径总是生成相同 task-id）。

**Validates: Requirements 5.1, 5.2**

### 属性 9：notifier 调度失败不影响 push

*对于任意* push 操作，即使 execCommand('notifier', ...) 抛出错误，push 操作本身应成功完成（事件已写入 SQLite）。

**Validates: Requirements 5.3**

### 属性 10：InboxWriter source 格式正确性

*对于任意* 外部消息（任意 channelType、channelId、sessionId、peerId 组合），InboxWriter 生成的 thread push 调用中，--source 参数应符合格式 `external:<channelType>:<channelId>:dm:<sessionId>:<peerId>`。

**Validates: Requirements 6.1, 6.2**

### 属性 11：Router 路由优先级

*对于任意* 路由规则集合（包含精确匹配和通配符规则），当同一 channelId 同时存在精确匹配（peer=peerId）和通配符匹配（peer="*"）时，精确匹配应优先返回；当无任何匹配时，应返回 null。

**Validates: Requirements 6.3, 6.4**

## 错误处理

### 测试中的错误处理原则

1. **进程退出码验证**：通过 `vi.spyOn(process, 'exit')` 捕获 exit code，或通过 spawn 进程后检查 `exitCode`
2. **stderr 验证**：错误信息应写入 stderr，通过 `vi.spyOn(process.stderr, 'write')` 捕获
3. **异常类型验证**：对于库函数，验证抛出正确类型的错误（如 `XDBError` with `PARAMETER_ERROR`）
4. **错误容忍验证**：对于非关键路径的错误（如 notifier 调度失败），验证主流程不受影响

### 常见错误场景

| 场景 | 预期行为 | 验证方式 |
|------|---------|---------|
| thread push 到未初始化目录 | exit 1 + stderr 错误信息 | spyOn process.exit |
| xdb 重复 init collection | 抛出 XDBError(PARAMETER_ERROR) | expect().rejects.toThrow |
| notifier 重复 start | exit 1 + stderr 错误信息 | CLI 进程 exitCode |
| xweb 缺少必需参数 | exit 2 | CLI 进程 exitCode |
| InboxWriter agent 不存在 | 抛出 Error | expect().rejects.toThrow |

## 测试策略

### 双轨测试方法

本 spec 采用单元测试和属性测试互补的双轨方法：

- **单元/集成测试（example-based）**：验证具体场景、边界条件和错误路径
- **属性测试（property-based）**：验证对所有有效输入都成立的通用规则

### 属性测试配置

- 使用 `fast-check` 库
- 每个属性测试最少运行 **100 次**迭代
- 每个属性测试通过注释标注对应的设计属性编号
- 格式：`// Feature: test-coverage, Property N: <property_text>`

### 测试文件组织

```
thread/vitest/integration/
  thread.test.ts              # 需求 1：thread intra-repo 集成测试

notifier/vitest/integration/
  daemon.test.ts              # 需求 2：notifier intra-repo 集成测试

xdb/vitest/integration/
  collection.test.ts          # 需求 3：xdb intra-repo 集成测试（mock embedder）
  collection-real.test.ts     # 需求 3 扩展：真实 embed 手动测试（需 API key，默认跳过）

xweb/vitest/integration/
  cli.test.ts                 # 需求 4：xweb CLI 集成测试

TheClaw/vitest/integration/
  setup.test.ts               # 已有（需求 8 基础）
  setup-e2e.test.ts           # 需求 8：TheClaw setup E2E（新增）
  thread-notifier.test.ts     # 需求 5：thread↔notifier 跨 repo
  xgw-thread.test.ts          # 需求 6：xgw↔thread 跨 repo
  agent-pipeline.test.ts      # 需求 7：agent↔thread↔pai 跨 repo（mock LLM）
  agent-pipeline-real.test.ts # 需求 7 扩展：真实 LLM 手动测试（需 API key，默认跳过）
  full-pipeline.test.ts       # 需求 9：全链路 E2E（mock LLM）
  full-pipeline-real.test.ts  # 需求 9 扩展：真实 LLM 全链路手动测试（需 API key，默认跳过）
```

### PBT 文件组织

属性测试（PBT）放在各 repo 的 `vitest/pbt/` 目录：

```
thread/vitest/pbt/
  push-pop-roundtrip.pbt.test.ts    # 属性 1, 2, 3, 4
  
xdb/vitest/pbt/
  write-find-roundtrip.pbt.test.ts  # 属性 5, 6, 7

TheClaw/vitest/pbt/
  thread-notifier.pbt.test.ts       # 属性 8, 9
  xgw-router.pbt.test.ts            # 属性 10, 11
```

### 真实调用手动测试（Real-IO Tests）

部分测试场景需要真实的外部服务调用（LLM API、embedding API）才能验证语义正确性。这类测试：

1. **永远不纳入 `npm test`**：不被 vitest.config.ts 的 `include` 模式匹配，CI 中绝不自动运行
2. **独立 npm script 触发**：通过 `npm run test:real` 手动执行，开发者自行评估结果
3. **文件命名**：`*-real.test.ts`，放在 `vitest/integration/` 下，但通过独立 vitest 配置文件运行
4. **结果由人工评估**：LLM 回复的语义合理性无法自动断言，测试只验证结构性约束（非空、无错误标志），语义质量由开发者人工判断

#### 配置方式

各 repo 新增 `vitest.real.config.ts`，只包含 `*-real.test.ts` 文件：

```typescript
// vitest.real.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    watch: false,
    testTimeout: 60000,  // 真实 LLM 调用需要更长超时
    fileParallelism: false,
    include: ['vitest/**/*-real.test.ts'],
  },
})
```

`package.json` 新增 script：

```json
{
  "test:real": "vitest run --config vitest.real.config.ts"
}
```

#### `xdb/vitest/integration/collection-real.test.ts`

测试真实 embedding 的语义搜索：
- 写入若干文档，使用真实 embedding 模型（通过 xdb 配置的 embedding client）
- 执行 `--similar` 语义搜索，验证语义相关的文档排名靠前
- 验证 embedding dimension 被正确记录到 collection_meta.json
- **人工评估**：搜索结果的语义相关性

```typescript
// 结构性断言（可自动化）
expect(results.length).toBeGreaterThan(0)
expect(results[0]).toHaveProperty('id')
// 语义评估（人工）：console.log 输出结果供开发者查看
console.log('语义搜索结果（请人工评估相关性）:', results.map(r => r.text))
```

#### `TheClaw/vitest/integration/agent-pipeline-real.test.ts`

测试真实 LLM 调用的 agent 消息处理：
- 初始化真实 agent（使用 tmpdir，真实文件系统）
- 推送一条消息到 inbox thread（真实 SQLite）
- 执行 `agent run`（真实 LLM 调用）
- 结构性断言：回复非空、peer thread 中有新事件
- **人工评估**：回复内容是否语义合理

#### `TheClaw/vitest/integration/full-pipeline-real.test.ts`

测试真实 LLM 的全链路：
- xgw InboxWriter 写入消息到真实 thread（mock execCommand 仅用于捕获 xgw send 调用）
- agent run（真实 LLM）
- agent deliver（捕获 xgw send 的投递内容）
- 结构性断言：投递内容非空、格式正确
- **人工评估**：投递内容的语义质量

这类测试的核心价值在于：**mock 再完美也无法验证 LLM 回复的语义合理性**，只有真实调用才能发现 prompt 设计、上下文传递等语义层面的问题。

### Mock 隔离原则

1. **只 mock 真正的外部依赖**：网络请求、LLM API、外部 CLI 进程调用
2. **使用真实文件系统**：通过 tmpdir 隔离，afterEach 清理
3. **使用真实 SQLite**：不 mock 数据库层，验证真实持久化行为
4. **通过 vi.mock 拦截 execCommand**：捕获跨 repo CLI 调用的参数，而不是真正执行

### 测试超时配置

- 集成测试：10000ms（vitest.config.ts 默认值）
- PBT 测试：10000ms（fast-check 100 次迭代）
- CLI 进程测试：15000ms（spawn 进程需要更长时间）

### 跨 repo 测试的路径约定

跨 repo 集成测试（在 TheClaw 中）通过相对路径引用其他 repo 的源码：

```typescript
// TheClaw/vitest/integration/thread-notifier.test.ts
import { scheduleDispatch } from '../../../thread/src/notifier-client.js'
import { openDb } from '../../../thread/src/db/init.js'
```

TheClaw 的 `tsconfig.json` 需要包含其他 repo 的路径（或通过 `paths` 配置）。
