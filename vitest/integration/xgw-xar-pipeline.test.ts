/**
 * Cross-repo integration tests: xgw → xar pipeline
 *
 * Tests the message flow from xgw InboxWriter to xar RunLoopImpl:
 *   1. xgw InboxWriter writes message to agent inbox via `thread push`
 *   2. xar RunLoopImpl receives message, routes to thread, calls LLM, streams reply via IPC
 *
 * Mock strategy:
 *   - xgw/src/repo-utils/os.js execCommand → captured for assertion
 *   - xar/src/agent/thread-lib.js openOrCreateThread → mock ThreadStore
 *   - xar/src/agent/config.js loadAgentConfig → returns fixture config
 *   - xar/src/agent/context.js buildContext → returns fixture ChatInput
 *   - xar/src/agent/memory.js compactSession → no-op
 *   - pai chat() → yields fixture events
 *   - xar/src/logging.js createAgentLogger → silent logger
 *   - Real filesystem (tmpdir) for xar config files
 *
 * Validates: xgw→xar IPC contract, InboxWriter thread push format,
 *            RunLoop streaming delivery, reply_context propagation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from '../../src/repo-utils/fs.js'
import { path } from '../../src/repo-utils/path.js'
import { tmpdir } from 'node:os'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockXgwExecCommand, mockThreadStore } = vi.hoisted(() => {
  const mockThreadStore = {
    push: vi.fn().mockResolvedValue({ id: 1, source: 'peer:user42', type: 'message', content: 'Hello', timestamp: Date.now() }),
    pushBatch: vi.fn().mockResolvedValue([]),
    peek: vi.fn().mockResolvedValue([]),
  }
  return {
    mockXgwExecCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    mockThreadStore,
  }
})

vi.mock('../../../xgw/src/repo-utils/os.js', () => ({
  execCommand: mockXgwExecCommand,
}))

vi.mock('../../../xar/src/agent/thread-lib.js', () => ({
  openOrCreateThread: vi.fn().mockResolvedValue(mockThreadStore),
  openInboxThread: vi.fn().mockResolvedValue(mockThreadStore),
  getAgentInboxPath: vi.fn().mockResolvedValue('/tmp/inbox'),
  getThreadPath: vi.fn().mockResolvedValue('/tmp/thread'),
  getThreadLib: vi.fn(),
  initThread: vi.fn().mockResolvedValue(mockThreadStore),
  threadExists: vi.fn().mockResolvedValue(false),
}))

// xar agent config
vi.mock('../../../xar/src/agent/config.js', () => ({
  loadAgentConfig: vi.fn().mockResolvedValue({
    agent_id: 'pipeline-bot',
    kind: 'user',
    pai: { provider: 'openai', model: 'gpt-4' },
    routing: { default: 'per-peer' },
    memory: { compact_threshold_tokens: 8000, session_compact_threshold_tokens: 4000 },
    retry: { max_attempts: 3 },
  }),
}))

// xar context builder
vi.mock('../../../xar/src/agent/context.js', () => ({
  buildContext: vi.fn().mockResolvedValue({
    system: 'You are pipeline-bot.',
    userMessage: 'Hello from xgw',
    history: [],
  }),
}))

// xar memory compact — no-op
vi.mock('../../../xar/src/agent/memory.js', () => ({
  compactSession: vi.fn().mockResolvedValue(undefined),
}))

// pai library
vi.mock('pai', () => ({
  initPai: vi.fn().mockResolvedValue({
    chat: vi.fn(async function* (_input: unknown, _opts: unknown, chunkWriter: any) {
      if (chunkWriter && typeof chunkWriter.write === 'function') {
        await new Promise<void>((resolve) => chunkWriter.write('Hello ', 'utf8', resolve))
        await new Promise<void>((resolve) => chunkWriter.write('world', 'utf8', resolve))
      }
      yield { type: 'chat_end', newMessages: [{ role: 'assistant', content: 'Hello world' }] }
    }),
    getProviderInfo: vi.fn().mockResolvedValue({ name: 'openai', defaultModel: 'gpt-4', contextWindow: 128000, maxTokens: 4096 }),
  }),
  createBashExecTool: vi.fn().mockReturnValue({ name: 'bash_exec', description: 'Run bash', parameters: {}, handler: vi.fn() }),
}))

// xar logging — silent
vi.mock('../../../xar/src/logging.js', () => ({
  createAgentLogger: vi.fn(() => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  createDaemonLogger: vi.fn().mockResolvedValue({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}))

// xar daemon config — use tmpBase
let tmpBase = ''
vi.mock('../../../xar/src/config.js', () => ({
  getDaemonConfig: vi.fn(() => ({ theClawHome: tmpBase, ipcPort: 18792, logLevel: 'info' })),
  getSocketPath: vi.fn(() => path.join(tmpBase, 'xar.sock')),
  getTheClawHome: vi.fn(() => tmpBase),
  getIpcPort: vi.fn(() => 18792),
  getLogLevel: vi.fn(() => 'info'),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { InboxWriter } from '../../../xgw/src/inbox.js'
import { RunLoopImpl } from '../../../xar/src/agent/run-loop.js'
import { AsyncQueueImpl } from '../../../xar/src/agent/queue.js'
import type { InboundMessage } from '../../../xar/src/types.js'
import type { IpcMessage } from '../../../xar/src/types.js'
import type { Pai } from 'pai'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeXgwMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    channel_id: 'tg-channel-1',
    peer_id: 'user42',
    peer_name: 'Test User',
    conversation_id: 'sess-1',
    text: 'Hello from xgw',
    attachments: [],
    reply_to: null,
    created_at: new Date().toISOString(),
    raw: {},
    ...overrides,
  }
}

function makeInboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    source: 'external:telegram:main:dm:user42:user42',
    content: 'Hello from xgw',
    ...overrides,
  }
}

function makeMockIpcConnection() {
  const sent: IpcMessage[] = []
  return {
    conn: {
      id: 'conn-1',
      send: vi.fn((msg: IpcMessage) => { sent.push(msg); return Promise.resolve() }),
      close: vi.fn(),
    },
    sent,
  }
}

function makeMockPai(chatOverride?: (...args: unknown[]) => AsyncGenerator<unknown>): Pai {
  const defaultChat = async function* (_input: unknown, _opts: unknown, chunkWriter: any) {
    if (chunkWriter && typeof chunkWriter.write === 'function') {
      await new Promise<void>((resolve) => chunkWriter.write('Hello ', 'utf8', resolve))
      await new Promise<void>((resolve) => chunkWriter.write('world', 'utf8', resolve))
    }
    yield { type: 'chat_end', newMessages: [{ role: 'assistant', content: 'Hello world' }] }
  }
  return {
    chat: (chatOverride ?? defaultChat) as Pai['chat'],
    getProviderInfo: vi.fn().mockResolvedValue({ name: 'openai', defaultModel: 'gpt-4', contextWindow: 128000, maxTokens: 4096 }),
  }
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpBase = await mkdtemp(path.join(path.toPosixPath(tmpdir()), 'xgw-xar-pipeline-'))
  vi.clearAllMocks()
  mockXgwExecCommand.mockResolvedValue({ stdout: '', stderr: '' })
  mockThreadStore.push.mockResolvedValue({ id: 1, source: 'peer:user42', type: 'message', content: 'Hello', timestamp: Date.now() })
  mockThreadStore.pushBatch.mockResolvedValue([])
  mockThreadStore.peek.mockResolvedValue([])
})

afterEach(async () => {
  await rm(tmpBase, { recursive: true, force: true })
})

// ── xgw InboxWriter: thread push contract ─────────────────────────────────────

describe('xgw InboxWriter — thread push contract', () => {
  it('calls execCommand with "thread" command', async () => {
    const writer = new InboxWriter()
    const msg = makeXgwMessage()
    const agentsConfig = { 'agent-1': { inbox: '/tmp/agent-1-inbox' } }

    await writer.push('agent-1', msg, 'telegram', agentsConfig)

    expect(mockXgwExecCommand).toHaveBeenCalledOnce()
    const [cmd] = mockXgwExecCommand.mock.calls[0] as [string, string[]]
    expect(cmd).toBe('thread')
  })

  it('passes "push" as first argument', async () => {
    const writer = new InboxWriter()
    await writer.push('agent-1', makeXgwMessage(), 'telegram', { 'agent-1': { inbox: '/tmp/inbox' } })

    const [, args] = mockXgwExecCommand.mock.calls[0] as [string, string[]]
    expect(args[0]).toBe('push')
  })

  it('passes --thread with the agent inbox path', async () => {
    const writer = new InboxWriter()
    await writer.push('agent-1', makeXgwMessage(), 'telegram', { 'agent-1': { inbox: '/tmp/my-inbox' } })

    const [, args] = mockXgwExecCommand.mock.calls[0] as [string, string[]]
    const idx = args.indexOf('--thread')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('/tmp/my-inbox')
  })

  it('passes --source with correct external format', async () => {
    const writer = new InboxWriter()
    const msg = makeXgwMessage({ channel_id: 'tg-ch', conversation_id: 'conv-99', peer_id: 'user42' })
    await writer.push('agent-1', msg, 'telegram', { 'agent-1': { inbox: '/tmp/inbox' } })

    const [, args] = mockXgwExecCommand.mock.calls[0] as [string, string[]]
    const idx = args.indexOf('--source')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('external:telegram:tg-ch:dm:conv-99:user42')
  })

  it('passes --type "message"', async () => {
    const writer = new InboxWriter()
    await writer.push('agent-1', makeXgwMessage(), 'telegram', { 'agent-1': { inbox: '/tmp/inbox' } })

    const [, args] = mockXgwExecCommand.mock.calls[0] as [string, string[]]
    const idx = args.indexOf('--type')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('message')
  })

  it('passes --content as JSON without the raw field', async () => {
    const writer = new InboxWriter()
    const msg = makeXgwMessage({ text: 'Hello!', raw: { internal: 'data' } })
    await writer.push('agent-1', msg, 'telegram', { 'agent-1': { inbox: '/tmp/inbox' } })

    const [, args] = mockXgwExecCommand.mock.calls[0] as [string, string[]]
    const idx = args.indexOf('--content')
    expect(idx).toBeGreaterThanOrEqual(0)
    const content = JSON.parse(args[idx + 1] as string)
    expect(content.text).toBe('Hello!')
    expect(content.raw).toBeUndefined()
  })

  it('throws when agent not found in config', async () => {
    const writer = new InboxWriter()
    await expect(
      writer.push('unknown-agent', makeXgwMessage(), 'telegram', {})
    ).rejects.toThrow('unknown-agent')
  })
})

// ── xar RunLoopImpl: message processing pipeline ──────────────────────────────

describe('xar RunLoopImpl — message processing pipeline', () => {
  it('routes message to thread via openOrCreateThread', async () => {
    const { openOrCreateThread } = await import('../../../xar/src/agent/thread-lib.js')
    const mockRoute = vi.mocked(openOrCreateThread)

    const { conn } = makeMockIpcConnection()
    const queue = new AsyncQueueImpl<InboundMessage>()
    const runLoop = new RunLoopImpl('pipeline-bot', queue, new Map([['conn-1', conn]]), makeMockPai())

    const runPromise = runLoop.start()
    queue.push(makeInboundMessage())
    queue.close()
    await runPromise

    expect(mockRoute).toHaveBeenCalledOnce()
  })

  it('pushes inbound message to thread store', async () => {
    const { conn } = makeMockIpcConnection()
    const queue = new AsyncQueueImpl<InboundMessage>()
    const runLoop = new RunLoopImpl('pipeline-bot', queue, new Map([['conn-1', conn]]), makeMockPai())

    const runPromise = runLoop.start()
    queue.push(makeInboundMessage({ content: 'Test message' }))
    queue.close()
    await runPromise

    expect(mockThreadStore.push).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', content: 'Test message' })
    )
  })

  it('sends stream_start IPC message before LLM call', async () => {
    const { conn, sent } = makeMockIpcConnection()
    const queue = new AsyncQueueImpl<InboundMessage>()
    const runLoop = new RunLoopImpl('pipeline-bot', queue, new Map([['conn-1', conn]]), makeMockPai())

    const runPromise = runLoop.start()
    queue.push(makeInboundMessage())
    queue.close()
    await runPromise

    const streamStart = sent.find(m => m.type === 'stream_start')
    expect(streamStart).toBeDefined()
  })

  it('sends stream_end IPC message after LLM call completes', async () => {
    const { conn, sent } = makeMockIpcConnection()
    const queue = new AsyncQueueImpl<InboundMessage>()
    const runLoop = new RunLoopImpl('pipeline-bot', queue, new Map([['conn-1', conn]]), makeMockPai())

    const runPromise = runLoop.start()
    queue.push(makeInboundMessage())
    queue.close()
    await runPromise

    const streamEnd = sent.find(m => m.type === 'stream_end')
    expect(streamEnd).toBeDefined()
  })

  it('stream_start includes target', async () => {
    const { conn, sent } = makeMockIpcConnection()
    const queue = new AsyncQueueImpl<InboundMessage>()
    const runLoop = new RunLoopImpl('pipeline-bot', queue, new Map([['conn-1', conn]]), makeMockPai())

    const runPromise = runLoop.start()
    queue.push(makeInboundMessage())
    queue.close()
    await runPromise

    const streamStart = sent.find(m => m.type === 'stream_start')
    expect(streamStart?.target).toMatchObject({
      channel_id: 'telegram:main',
      peer_id: 'user42',
    })
  })

  it('writes LLM response records to thread via pushBatch', async () => {
    const { conn } = makeMockIpcConnection()
    const queue = new AsyncQueueImpl<InboundMessage>()
    const runLoop = new RunLoopImpl('pipeline-bot', queue, new Map([['conn-1', conn]]), makeMockPai())

    const runPromise = runLoop.start()
    queue.push(makeInboundMessage())
    queue.close()
    await runPromise

    expect(mockThreadStore.pushBatch).toHaveBeenCalledOnce()
    const [events] = mockThreadStore.pushBatch.mock.calls[0] as [Array<{ source: string; type: string }>]
    expect(events.some(e => e.source === 'self')).toBe(true)
  })

  it('sends stream_token IPC messages for each LLM chunk', async () => {
    const { conn, sent } = makeMockIpcConnection()
    const queue = new AsyncQueueImpl<InboundMessage>()
    const runLoop = new RunLoopImpl('pipeline-bot', queue, new Map([['conn-1', conn]]), makeMockPai())

    const runPromise = runLoop.start()
    queue.push(makeInboundMessage())
    queue.close()
    await runPromise

    const tokens = sent.filter(m => m.type === 'stream_token')
    expect(tokens.length).toBeGreaterThan(0)
  })

  it('processes multiple messages sequentially', async () => {
    const { conn } = makeMockIpcConnection()
    const queue = new AsyncQueueImpl<InboundMessage>()
    const runLoop = new RunLoopImpl('pipeline-bot', queue, new Map([['conn-1', conn]]), makeMockPai())

    const runPromise = runLoop.start()
    queue.push(makeInboundMessage({ content: 'msg-1' }))
    queue.push(makeInboundMessage({ content: 'msg-2' }))
    queue.close()
    await runPromise

    // pushBatch called once per message
    expect(mockThreadStore.pushBatch).toHaveBeenCalledTimes(2)
  })

  it('sends stream_error when LLM call fails non-retryably', async () => {
    const failPai = makeMockPai(async function* () {
      throw new Error('auth failed')
    })

    const { conn, sent } = makeMockIpcConnection()
    const queue = new AsyncQueueImpl<InboundMessage>()
    const runLoop = new RunLoopImpl('pipeline-bot', queue, new Map([['conn-1', conn]]), failPai)

    const runPromise = runLoop.start()
    queue.push(makeInboundMessage())
    queue.close()
    await runPromise

    const streamError = sent.find(m => m.type === 'stream_error')
    expect(streamError).toBeDefined()
    expect(streamError?.error).toContain('auth failed')
  })
})
