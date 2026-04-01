/**
 * Cross-repo integration tests: xar RunLoopImpl internals
 *
 * Focuses on the xar agent run-loop contracts:
 *   - Message routing to correct thread based on routing config
 *   - LLM context building and pai.chat() invocation
 *   - IPC streaming delivery (stream_start/token/end/error)
 *   - Retry logic for retryable LLM errors
 *   - Session compaction is called
 *   - stop() cleanly terminates the loop
 *
 * Mock strategy:
 *   - xar/src/agent/thread-lib.js → mock ThreadStore
 *   - xar/src/agent/config.js → fixture AgentConfig
 *   - xar/src/agent/context.js → fixture ChatInput
 *   - xar/src/agent/memory.js → no-op
 *   - pai → mock chat/loadConfig/resolveProvider
 *   - xar/src/logging.js → silent logger
 *   - xar/src/config.js → tmpBase home
 *
 * Validates: Requirements 7.1–7.5 (adapted for xar architecture)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from '../../src/repo-utils/fs.js'
import { path } from '../../src/repo-utils/path.js'
import { tmpdir } from 'node:os'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockThreadStore, mockBuildContext, mockCompactSession, mockChat } = vi.hoisted(() => {
  const mockThreadStore = {
    push: vi.fn().mockResolvedValue({ id: 1, source: 'peer:user42', type: 'message', content: '', timestamp: Date.now() }),
    pushBatch: vi.fn().mockResolvedValue([]),
    peek: vi.fn().mockResolvedValue([]),
  }
  const mockBuildContext = vi.fn().mockResolvedValue({
    system: 'You are bot.',
    userMessage: 'Hello agent',
    history: [],
  })
  const mockCompactSession = vi.fn().mockResolvedValue(undefined)
  const mockChat = vi.fn(async function* () {
    yield { type: 'chunk', content: 'Hello world' }
    yield { type: 'chat_end', newMessages: [{ role: 'assistant', content: 'Hello world' }] }
  })
  return { mockThreadStore, mockBuildContext, mockCompactSession, mockChat }
})

vi.mock('../../../xar/src/agent/thread-lib.js', () => ({
  openOrCreateThread: vi.fn().mockResolvedValue(mockThreadStore),
  openInboxThread: vi.fn().mockResolvedValue(mockThreadStore),
  getAgentInboxPath: vi.fn().mockResolvedValue('/tmp/inbox'),
  getThreadPath: vi.fn().mockResolvedValue('/tmp/thread'),
  getThreadLib: vi.fn(),
  initThread: vi.fn().mockResolvedValue(mockThreadStore),
  threadExists: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../../xar/src/agent/config.js', () => ({
  loadAgentConfig: vi.fn().mockResolvedValue({
    agent_id: 'bot',
    kind: 'user',
    pai: { provider: 'openai', model: 'gpt-4' },
    routing: { default: 'per-peer' },
    memory: { compact_threshold_tokens: 8000, session_compact_threshold_tokens: 4000 },
    retry: { max_attempts: 3 },
  }),
}))

vi.mock('../../../xar/src/agent/context.js', () => ({
  buildContext: mockBuildContext,
}))

vi.mock('../../../xar/src/agent/memory.js', () => ({
  compactSession: mockCompactSession,
}))

vi.mock('pai', () => ({
  initPai: vi.fn().mockResolvedValue({
    chat: mockChat,
    getProviderInfo: vi.fn().mockResolvedValue({ name: 'openai', defaultModel: 'gpt-4', contextWindow: 128000, maxTokens: 4096 }),
  }),
  createBashExecTool: vi.fn().mockReturnValue({ name: 'bash_exec', description: 'Run bash', parameters: {}, handler: vi.fn() }),
}))

vi.mock('../../../xar/src/logging.js', () => ({
  createAgentLogger: vi.fn(() => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(),
    error: vi.fn((msg: string) => { process.stderr.write(`[AGENT-ERROR] ${msg}\n`) }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}))


let tmpBase = ''
vi.mock('../../../xar/src/config.js', () => ({
  getDaemonConfig: vi.fn(() => ({ theClawHome: tmpBase, ipcPort: 18792, logLevel: 'info' })),
  getSocketPath: vi.fn(() => path.join(tmpBase, 'xar.sock')),
  getTheClawHome: vi.fn(() => tmpBase),
  getIpcPort: vi.fn(() => 18792),
  getLogLevel: vi.fn(() => 'info'),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { RunLoopImpl } from '../../../xar/src/agent/run-loop.js'
import { AsyncQueueImpl } from '../../../xar/src/agent/queue.js'
import type { InboundMessage, IpcMessage } from '../../../xar/src/types.js'
import type { Pai } from 'pai'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    source: 'external:telegram:main:dm:user42:user42',
    content: 'Hello agent',
    ...overrides,
  }
}

function makeMockConn() {
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

function makeMockPai(): Pai {
  return {
    chat: mockChat as unknown as Pai['chat'],
    getProviderInfo: vi.fn().mockResolvedValue({ name: 'openai', defaultModel: 'gpt-4', contextWindow: 128000, maxTokens: 4096 }),
  }
}

async function runWithMessage(msg: InboundMessage, connOverride?: ReturnType<typeof makeMockConn>) {
  const { conn, sent } = connOverride ?? makeMockConn()
  const queue = new AsyncQueueImpl<InboundMessage>()
  const runLoop = new RunLoopImpl('bot', queue, new Map([['conn-1', conn]]), makeMockPai())
  const runPromise = runLoop.start()
  queue.push(msg)
  queue.close()
  await runPromise
  return { conn, sent }
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpBase = await mkdtemp(path.join(path.toPosixPath(tmpdir()), 'xar-run-loop-'))
  vi.clearAllMocks()
  mockChat.mockImplementation(async function* () {
    yield { type: 'chunk', content: 'Hello world' }
    yield { type: 'chat_end', newMessages: [{ role: 'assistant', content: 'Hello world' }] }
  })
  mockBuildContext.mockResolvedValue({ system: 'You are bot.', userMessage: 'Hello agent', history: [] })
  mockCompactSession.mockResolvedValue(undefined)
  mockThreadStore.push.mockResolvedValue({ id: 1, source: 'peer:user42', type: 'message', content: '', timestamp: Date.now() })
  mockThreadStore.pushBatch.mockResolvedValue([])
  mockThreadStore.peek.mockResolvedValue([])
})

afterEach(async () => {
  await rm(tmpBase, { recursive: true, force: true })
})

// ── Requirement 7.1: RunLoop routes message to thread ─────────────────────────

describe('Requirement 7.1 — RunLoop routes inbound message to thread', () => {
  it('calls openOrCreateThread when processing a message', async () => {
    const { openOrCreateThread } = await import('../../../xar/src/agent/thread-lib.js')
    await runWithMessage(makeMsg())
    expect(vi.mocked(openOrCreateThread)).toHaveBeenCalledOnce()
  })

  it('pushes inbound message to thread with correct type', async () => {
    await runWithMessage(makeMsg({ content: 'Test content' }))
    expect(mockThreadStore.push).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', content: 'Test content' })
    )
  })

  it('routes per-peer source to peers/<id> thread', async () => {
    const { openOrCreateThread } = await import('../../../xar/src/agent/thread-lib.js')
    await runWithMessage(makeMsg({ source: 'external:telegram:main:dm:alice:alice' }))
    // openOrCreateThread is called with agentId and threadId
    const [agentId, threadId] = vi.mocked(openOrCreateThread).mock.calls[0] as [string, string]
    expect(agentId).toBe('bot')
    expect(threadId).toBe('peers/alice')
  })

  it('does not process messages after stop()', async () => {
    const { conn } = makeMockConn()
    const queue = new AsyncQueueImpl<InboundMessage>()
    const runLoop = new RunLoopImpl('bot', queue, new Map([['conn-1', conn]]), makeMockPai())

    const runPromise = runLoop.start()
    await runLoop.stop()
    await runPromise

    expect(mockThreadStore.push).not.toHaveBeenCalled()
  })
})

// ── Requirement 7.2: RunLoop calls pai.chat() with correct config ─────────────

describe('Requirement 7.2 — RunLoop calls pai.chat() with correct config', () => {
  it('calls pai.chat() when processing a message', async () => {
    await runWithMessage(makeMsg())
    expect(mockChat).toHaveBeenCalledOnce()
  })

  it('does NOT call pai.chat() when queue is empty', async () => {
    const { conn } = makeMockConn()
    const queue = new AsyncQueueImpl<InboundMessage>()
    const runLoop = new RunLoopImpl('bot', queue, new Map([['conn-1', conn]]), makeMockPai())
    const runPromise = runLoop.start()
    queue.close()
    await runPromise
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('calls buildContext before pai.chat()', async () => {
    await runWithMessage(makeMsg())
    expect(mockBuildContext).toHaveBeenCalledOnce()
    expect(mockChat).toHaveBeenCalledOnce()
    expect(mockBuildContext.mock.invocationCallOrder[0]!).toBeLessThan(
      mockChat.mock.invocationCallOrder[0]!
    )
  })

  it('calls compactSession before pai.chat()', async () => {
    await runWithMessage(makeMsg())
    expect(mockCompactSession).toHaveBeenCalledOnce()
    expect(mockCompactSession.mock.invocationCallOrder[0]!).toBeLessThan(
      mockChat.mock.invocationCallOrder[0]!
    )
  })

  it('passes provider and model from agent config to chat', async () => {
    await runWithMessage(makeMsg())
    const [, chatConfig] = mockChat.mock.calls[0] as [unknown, { provider: string; model: string }]
    expect(chatConfig.provider).toBe('openai')
    expect(chatConfig.model).toBe('gpt-4')
  })
})

// ── Requirement 7.3: RunLoop streams reply via IPC ────────────────────────────

describe('Requirement 7.3 — RunLoop streams reply via IPC Deliver', () => {
  it('sends stream_start before any tokens', async () => {
    const mock = makeMockConn()
    await runWithMessage(makeMsg(), mock)

    const startIdx = mock.sent.findIndex(m => m.type === 'stream_start')
    const tokenIdx = mock.sent.findIndex(m => m.type === 'stream_token')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    if (tokenIdx >= 0) expect(startIdx).toBeLessThan(tokenIdx)
  })

  it('sends stream_end after all tokens', async () => {
    const mock = makeMockConn()
    await runWithMessage(makeMsg(), mock)

    const endIdx = mock.sent.findLastIndex(m => m.type === 'stream_end')
    const tokenIdx = mock.sent.findLastIndex(m => m.type === 'stream_token')
    expect(endIdx).toBeGreaterThanOrEqual(0)
    if (tokenIdx >= 0) expect(endIdx).toBeGreaterThan(tokenIdx)
  })

  it('stream_start carries target with channel_id and peer_id', async () => {
    const mock = makeMockConn()
    await runWithMessage(makeMsg(), mock)

    const streamStart = mock.sent.find(m => m.type === 'stream_start')
    expect(streamStart?.target).toMatchObject({
      channel_id: 'telegram:main',
      peer_id: 'user42',
    })
  })

  it('writes assistant records to thread after chat_end', async () => {
    await runWithMessage(makeMsg())
    expect(mockThreadStore.pushBatch).toHaveBeenCalledOnce()
    const [events] = mockThreadStore.pushBatch.mock.calls[0] as [Array<{ source: string; type: string }>]
    expect(events.some(e => e.source === 'self' && e.type === 'record')).toBe(true)
  })
})

// ── Requirement 7.4: RunLoop handles LLM errors gracefully ───────────────────

describe('Requirement 7.4 — RunLoop handles LLM errors gracefully', () => {
  it('sends stream_error when LLM throws non-retryable error', async () => {
    mockChat.mockImplementationOnce(async function* () {
      throw new Error('invalid api key')
    })

    const mock = makeMockConn()
    await runWithMessage(makeMsg(), mock)

    const streamError = mock.sent.find(m => m.type === 'stream_error')
    expect(streamError).toBeDefined()
    expect(streamError?.error).toContain('invalid api key')
  })

  it('writes error record to thread on LLM failure', async () => {
    mockChat.mockImplementationOnce(async function* () {
      throw new Error('api error')
    })

    await runWithMessage(makeMsg())

    const errorPush = mockThreadStore.push.mock.calls.find(
      ([e]) => (e as { subtype?: string }).subtype === 'error'
    )
    expect(errorPush).toBeDefined()
  })

  it('continues processing next message after error', async () => {
    mockChat
      .mockImplementationOnce(async function* () { throw new Error('first fails') })
      .mockImplementationOnce(async function* () {
        yield { type: 'chat_end', newMessages: [{ role: 'assistant', content: 'ok' }] }
      })

    const { conn } = makeMockConn()
    const queue = new AsyncQueueImpl<InboundMessage>()
    const runLoop = new RunLoopImpl('bot', queue, new Map([['conn-1', conn]]), makeMockPai())
    const runPromise = runLoop.start()
    queue.push(makeMsg({ content: 'msg-1' }))
    queue.push(makeMsg({ content: 'msg-2' }))
    queue.close()
    await runPromise

    // Both messages were attempted
    expect(mockChat).toHaveBeenCalledTimes(2)
  })
})

// ── Requirement 7.5: RunLoop retries on retryable errors ─────────────────────

describe('Requirement 7.5 — RunLoop retries on retryable LLM errors', () => {
  it('retries on timeout error', async () => {
    mockChat
      .mockImplementationOnce(async function* () { throw new Error('timeout') })
      .mockImplementationOnce(async function* () {
        yield { type: 'chat_end', newMessages: [{ role: 'assistant', content: 'ok' }] }
      })

    await runWithMessage(makeMsg())

    expect(mockChat).toHaveBeenCalledTimes(2)
  })

  it('retries on rate limit error', async () => {
    mockChat
      .mockImplementationOnce(async function* () { throw new Error('rate limit exceeded') })
      .mockImplementationOnce(async function* () {
        yield { type: 'chat_end', newMessages: [{ role: 'assistant', content: 'ok' }] }
      })

    await runWithMessage(makeMsg())

    expect(mockChat).toHaveBeenCalledTimes(2)
  })

  it('stops retrying after max_attempts', async () => {
    // max_attempts = 3 in fixture config
    mockChat.mockImplementation(async function* () { throw new Error('timeout') })

    const mock = makeMockConn()
    await runWithMessage(makeMsg(), mock)

    expect(mockChat).toHaveBeenCalledTimes(3)
    const streamError = mock.sent.find(m => m.type === 'stream_error')
    expect(streamError).toBeDefined()
  })
})
