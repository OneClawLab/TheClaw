# CLI/LIB 双接口模块规范

## Node.js 工程类型分类

| 类型 | 说明 | TheClaw 示例 |
|------|------|-------------|
| **CLI/LIB** | CLI 是 LIB 的 wrapper 层，两种接口共享同一套核心逻辑 | pai、thread |
| **CLI/Daemon** | CLI 是 Daemon 的维护管理接口，调用接口一般是某种 IPC 机制 | xar、xgw、notifier |
| **CLI Only** | 纯命令行工具，无 lib 接口 | cmds、xdb、xweb |
| **LIB Only** | 纯库，无 CLI | （暂无） |
| **APP** | 含 GUI 的应用 | xgw-tui client、webchat |

---

## 概念

**CLI/LIB 双接口模块**是一种同时提供两种调用方式的 Node.js 模块：

- **CLI 接口**：作为可执行命令，供人类和 LLM 通过 `bash_exec` 调用
- **LIB 接口**：作为可 import 的库，供其他 Node.js 模块直接调用

两种接口共享同一套核心业务逻辑，通过分离入口文件实现职责隔离。

---

## 目录结构

```
src/
  lib/              ← 核心业务逻辑（无 CLI 依赖）
    core.ts         ← 主要功能实现
    types.ts        ← 共享类型定义
  commands/         ← CLI 子命令实现（调用 lib/，薄包装）
    <cmd>.ts
  index.ts          ← LIB 入口：只做 export，无副作用
  cli.ts            ← CLI 入口：argv 解析 + dispatch + 错误转 exit code
dist/
  index.js          ← 编译后的 lib 入口（无 shebang）
  index.d.ts        ← 类型声明
  cli.js            ← 编译后的 CLI 入口（带 shebang）
USAGE.md            ← CLI 使用说明（面向人类和 LLM）
```

---

## 入口文件约定

### `src/index.ts` — LIB 入口

- 只做 `export`，不执行任何副作用
- 不读取 argv、不读取环境变量、不建立连接
- 导出所有公开的函数、类、类型

```typescript
// src/index.ts
export { chat, type ChatOptions, type ChatResult } from './lib/core.js'
export { type Message, type Session } from './lib/types.js'
```

### `src/cli.ts` — CLI 入口

- 只做 argv 解析、config 加载、调用 lib、错误转 exit code
- 不包含业务逻辑
- 处理 EPIPE 等 CLI 特有的信号

```typescript
// src/cli.ts
import { program } from 'commander'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// EPIPE 处理
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); throw err })
process.stderr.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); throw err })

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))

program.exitOverride()
program.version(pkg.version)

// 注册子命令...

try {
  await program.parseAsync()
} catch (err) {
  // 错误转 exit code（见错误处理约定）
}
```

---

## `package.json` 约定

```json
{
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "<command-name>": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "release:local": "npm run build && npm link"
  }
}
```

---

## `tsup.config.ts` 约定

lib 和 CLI 分开构建，避免 shebang 污染 lib 入口：

```typescript
import { defineConfig } from 'tsup'

export default defineConfig([
  {
    // LIB 入口：无 shebang，生成类型声明
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node22',
    clean: true,
    sourcemap: true,
    dts: true,
  },
  {
    // CLI 入口：带 shebang，不生成类型声明
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node22',
    sourcemap: true,
    dts: false,
    banner: { js: '#!/usr/bin/env node' },
  },
])
```

---

## LIB 层设计约定

### 1. 错误处理：throw，不 exit

lib 函数通过 throw 传递错误，由调用者决定如何处理。CLI 层负责把 throw 转成 exit code。

```typescript
// lib/core.ts — 正确
export async function chat(options: ChatOptions): Promise<ChatResult> {
  if (!options.model) throw new Error('model is required')
  // ...
}

// commands/chat.ts — CLI 层转换
try {
  const result = await chat(options)
  process.stdout.write(result.text)
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`)
  process.exit(1)
}
```

### 2. Streaming：AsyncIterable，不写 stdout

lib 的 streaming 接口返回 `AsyncIterable<string>`，不直接写 `process.stdout`。CLI 层负责消费并写出。

```typescript
// lib/core.ts — 正确
export async function* chatStream(options: ChatOptions): AsyncIterable<string> {
  for await (const token of provider.stream(options)) {
    yield token
  }
}

// commands/chat.ts — CLI 层消费
for await (const token of chatStream(options)) {
  process.stdout.write(token)
}
```

### 3. 配置：可注入，不强制文件系统

lib 函数接受显式的 config 对象，不强制从文件系统加载。CLI 层负责从 argv/env/文件加载后注入。

```typescript
// lib/core.ts — 正确
export async function chat(options: ChatOptions, config: Config): Promise<ChatResult>

// commands/chat.ts — CLI 层加载配置
const config = loadConfig(opts.config ?? process.env.PAI_CONFIG)
const result = await chat(options, config)
```

### 4. 副作用：import 时无副作用

lib 模块在被 import 时不产生任何副作用（不读文件、不建连接、不注册全局状态）。所有副作用在显式调用时发生。

---

## CLI 层设计约定

### 错误码规范

| Code | 含义 |
|------|------|
| `0` | 成功 |
| `1` | 运行时错误（业务逻辑错误、外部 API 错误等） |
| `2` | 参数/用法错误（缺少必填参数、非法参数值等） |

commander 的 `exitOverride()` 会在参数错误时 throw，CLI 层需要将其 remap 到 exit 2。

### stdout / stderr 约定

- `stdout`：命令结果数据（供管道和脚本消费）
- `stderr`：进度、调试、错误、警告信息

---

## USAGE.md 约定

每个 CLI/LIB 双接口模块必须提供 `USAGE.md`，面向人类和 LLM，内容包括：

1. 一句话描述模块用途
2. 安装方式
3. CLI 命令列表及参数说明
4. 典型使用示例（CLI 和 LIB import 各若干条）
5. 环境变量列表

---

## 适用场景判断

| 场景 | 推荐接口 |
|------|---------|
| LLM 通过 bash_exec 调用 | CLI |
| 人类命令行探索 | CLI |
| 另一个 Node.js 模块调用 | LIB |
| 需要 streaming 透传 | LIB（CLI 的 stdout pipe 也可，但有进程开销） |
| 需要细粒度错误处理 | LIB |
| 需要在同一进程内复用连接/缓存 | LIB |
