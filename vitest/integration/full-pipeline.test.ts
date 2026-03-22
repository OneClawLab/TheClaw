/**
 * Full pipeline E2E tests: xgw → agent → deliver
 *
 * Tests the complete message flow:
 *   1. xgw InboxWriter writes message to agent inbox thread (mock execCommand)
 *   2. agent run consumes inbox, calls LLM (mock invokeLlm), writes reply to peer thread
 *   3. agent deliver reads peer thread and calls xgw send (mock execCommand)
 *   4. consumer_progress is updated after full pipeline
 *
 * Mock strategy:
 *   - xgw/src/repo-utils/os.js execCommand → captured for assertion
 *   - agent/src/repo-utils/os.js execCommand → captured for assertion
 *   - agent/src/runner/llm.js invokeLlm → returns fixed reply
 *   - agent/src/runner/inbox.js consumeMessages → real thread pop via mock execCommand
 *   - Real filesystem (tmpdir)
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { path } from '../../../agent/src/repo-utils/path.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

// xgw execCommand: captures thread push calls from InboxWriter
const { mockXgwExecCommand } = vi.hoisted(() => ({
  mockXgwExecCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))
vi.mock('../../../xgw/src/repo-utils/os.js', () => ({
  execCommand: mockXgwExecCommand,
}))

// agent execCommand: captures xgw send calls from deliverCmd
const { mockAgentExecCommand } = vi.hoisted(() => ({
  mockAgentExecCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))
vi.mock('../../../agent/src/repo-utils/os.js', () => ({
  execCommand: mockAgentExecCommand,
}))

// LLM mock
vi.mock('../../../agent/src/runner/llm.js', () => ({
  invokeLlm: vi.fn().mockResolvedValue({ reply: 'Full pipeline reply' }),
  buildSessionFilePath: vi.fn((agentDir: string, threadId: string) =>
    `${agentDir}/sessions/${threadId}.jsonl`
  ),
}))

// Supporting agent mocks
vi.mock('../../../agent/src/runner/inbox.js', () => ({
  consumeMessages: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../../agent/src/runner/router.js', () => ({
  routeMessage: vi.fn().mockResolvedValue({ threadPath: '/tmp/thread', isNew: false }),
}))

vi.mock('../../../agent/src/runner/recorder.js', () => ({
  pushMessage: vi.fn().mockResolvedValue('evt-msg-1'),
  pushReply: vi.fn().mockResolvedValue('evt-reply-1'),
  pushRecord: vi.fn().mockResolvedValue('evt-rec-1'),
}))

vi.mock('../../../agent/src/identity.js', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue('# Agent\nYou are a test agent.'),
}))

vi.mock('../../../agent/src/errors.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

vi.mock('../../../agent/src/repo-utils/logger.js', () => ({
  createFireAndForgetLogger: vi.fn(() => ({
    info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}))

let tmpBase: string
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>()
  return { ...orig, homedir: () => tmpBase }
})

// ── Import mocked modules ─────────────────────────────────────────────────────

import { consumeMessages } from '../../../agent/src/runner/inbox.js'
import { invokeLlm } from '../../../agent/src/runner/llm.js'
import { pushReply } from '../../../agent/src/runner/recorder.js'

const mockConsumeMessages = vi.mocked(consumeMessages)
const mockInvokeLlm = vi.mocked(invokeLlm)
const mockPushReply = vi.mocked(pushReply)

// Import xgw and agent commands AFTER mocks
const { InboxWriter } = await import('../../../xgw/src/inbox.js')
const { initCmd } = await import('../../../agent/src/commands/init.js')
const { startCmd } = await import('../../../agent/src/commands/start.js')
const { runCmd } = await import('../../../agent/src/commands/run.js')
const { deliverCmd } = await import('../../../agent/src/commands/deliver.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

function agentDir(id: string) {
  return path.join(tmpBase, '.theclaw', 'agents', id)
}

function makeXgwMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-pipeline-1',
    channel_id: 'tg-channel-1',
    peer_id: 'user42',
    peer_name: 'Test User',
    session_id: 'sess-pipeline-1',
    text: 'Hello from xgw',
    attachments: [],
    reply_to: null,
    created_at: new Date().toISOString(),
    raw: {},
    ...overrides,
  }
}

function makeInboxMessage(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-inbox-pipeline-1',
    type: 'message' as const,
    source: 'external:telegram:tg-channel-1:dm:sess-pipeline-1:user42',
    content: {
      text: 'Hello from xgw',
      reply_context: {
        channel_type: 'external' as const,
        channel_id: 'telegram',
        peer_id: 'user42',
      },
    },
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stdoutSpy: any
let consoleSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  tmpBase = path.resolve(await mkdtemp(path.join(path.resolve(tmpdir()), 'full-pipeline-test-')))
  vi.clearAllMocks()
  mockXgwExecCommand.mockResolvedValue({ stdout: '', stderr: '' })
  mockAgentExecCommand.mockResolvedValue({ stdout: '', stderr: '' })
  mockConsumeMessages.mockResolvedValue([])
  mockInvokeLlm.mockResolvedValue({ reply: 'Full pipeline reply' })
  mockPushReply.mockResolvedValue('evt-reply-1')
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  stdoutSpy.mockRestore()
  consoleSpy.mockRestore()
  await rm(tmpBase, { recursive: true, force: true })
})

// ── Requirement 9.1: xgw InboxWriter writes message to agent inbox thread ────

describe('Requirement 9.1 — xgw InboxWriter writes message to agent inbox thread', () => {
  it('InboxWriter.push calls execCommand with "thread" command', async () => {
    const writer = new InboxWriter()
    const msg = makeXgwMessage()
    const agentsConfig = { 'agent-1': { inbox: '/tmp/agent-1-inbox' } }

    await writer.push('agent-1', msg, 'telegram', agentsConfig)

    expect(mockXgwExecCommand).toHaveBeenCalledOnce()
    const [cmd] = mockXgwExecCommand.mock.calls[0] as [string, string[]]
    expect(cmd).toBe('thread')
  })

  it('InboxWriter.push passes "push" as first argument to thread', async () => {
    const writer = new InboxWriter()
    const msg = makeXgwMessage()
    const agentsConfig = { 'agent-1': { inbox: '/tmp/agent-1-inbox' } }

    await writer.push('agent-1', msg, 'telegram', agentsConfig)

    const [, args] = mockXgwExecCommand.mock.calls[0] as [string, string[]]
    expect(args[0]).toBe('push')
  })

  it('InboxWriter.push passes --source with correct external format', async () => {
    const writer = new InboxWriter()
    const msg = makeXgwMessage({
      channel_id: 'tg-channel-1',
      session_id: 'sess-pipeline-1',
      peer_id: 'user42',
    })
    const agentsConfig = { 'agent-1': { inbox: '/tmp/agent-1-inbox' } }

    await writer.push('agent-1', msg, 'telegram', agentsConfig)

    const [, args] = mockXgwExecCommand.mock.calls[0] as [string, string[]]
    const sourceIdx = args.indexOf('--source')
    expect(sourceIdx).toBeGreaterThanOrEqual(0)
    expect(args[sourceIdx + 1]).toBe('external:telegram:tg-channel-1:dm:sess-pipeline-1:user42')
  })

  it('InboxWriter.push passes --type "message"', async () => {
    const writer = new InboxWriter()
    const msg = makeXgwMessage()
    const agentsConfig = { 'agent-1': { inbox: '/tmp/agent-1-inbox' } }

    await writer.push('agent-1', msg, 'telegram', agentsConfig)

    const [, args] = mockXgwExecCommand.mock.calls[0] as [string, string[]]
    const typeIdx = args.indexOf('--type')
    expect(typeIdx).toBeGreaterThanOrEqual(0)
    expect(args[typeIdx + 1]).toBe('message')
  })
})

// ── Requirement 9.2: agent run consumes inbox and writes reply to peer thread ─

describe('Requirement 9.2 — agent run consumes inbox and writes reply to peer thread', () => {
  it('consumeMessages is called when agent run executes', async () => {
    await initCmd('pipeline-bot', { kind: 'user' })
    await startCmd('pipeline-bot')
    mockConsumeMessages.mockClear()

    await runCmd('pipeline-bot')

    expect(mockConsumeMessages).toHaveBeenCalledOnce()
  })

  it('invokeLlm is called when inbox has messages', async () => {
    await initCmd('pipeline-bot', { kind: 'user' })
    await startCmd('pipeline-bot')
    mockConsumeMessages.mockResolvedValue([makeInboxMessage()])

    await runCmd('pipeline-bot')

    expect(mockInvokeLlm).toHaveBeenCalledOnce()
  })

  it('pushReply is called with the LLM reply text', async () => {
    await initCmd('pipeline-bot', { kind: 'user' })
    await startCmd('pipeline-bot')
    mockConsumeMessages.mockResolvedValue([makeInboxMessage()])
    mockInvokeLlm.mockResolvedValue({ reply: 'Pipeline reply text' })

    await runCmd('pipeline-bot')

    expect(mockPushReply).toHaveBeenCalledOnce()
    const [, replyText] = mockPushReply.mock.calls[0]!
    expect(replyText).toBe('Pipeline reply text')
  })

  it('pushReply is called with reply_context containing channel_id and peer_id', async () => {
    await initCmd('pipeline-bot', { kind: 'user' })
    await startCmd('pipeline-bot')
    mockConsumeMessages.mockResolvedValue([makeInboxMessage()])

    await runCmd('pipeline-bot')

    const [, , replyContext] = mockPushReply.mock.calls[0]!
    expect(replyContext).toMatchObject({
      channel_id: 'telegram',
      peer_id: 'user42',
    })
  })
})

// ── Requirement 9.3: agent deliver calls xgw send ────────────────────────────

describe('Requirement 9.3 — agent deliver calls xgw send to deliver reply', () => {
  it('deliver calls execCommand with "xgw" command', async () => {
    await initCmd('pipeline-bot', { kind: 'user' })
    await startCmd('pipeline-bot')

    const threadPath = path.join(agentDir('pipeline-bot'), 'threads', 'peers', 'telegram-user42')
    const events = [{
      eventId: 'out-pipeline-1',
      content: {
        text: 'Pipeline reply',
        reply_context: { channel_type: 'external', channel_id: 'telegram', peer_id: 'user42' },
      },
    }]

    mockAgentExecCommand
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' }) // thread pop
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                      // xgw send
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                      // thread ack

    await deliverCmd({ thread: threadPath, consumer: 'outbound' })

    const xgwCall = mockAgentExecCommand.mock.calls.find(([cmd]) => cmd === 'xgw')
    expect(xgwCall).toBeDefined()
    expect(xgwCall![1]).toContain('send')
  })

  it('deliver passes --channel and --peer to xgw send', async () => {
    await initCmd('pipeline-bot', { kind: 'user' })
    await startCmd('pipeline-bot')

    const threadPath = path.join(agentDir('pipeline-bot'), 'threads', 'peers', 'telegram-user42')
    const events = [{
      eventId: 'out-pipeline-1',
      content: {
        text: 'Pipeline reply',
        reply_context: { channel_type: 'external', channel_id: 'telegram', peer_id: 'user42' },
      },
    }]

    mockAgentExecCommand
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await deliverCmd({ thread: threadPath, consumer: 'outbound' })

    const xgwCall = mockAgentExecCommand.mock.calls.find(([cmd]) => cmd === 'xgw')!
    const args = xgwCall[1] as string[]
    const channelIdx = args.indexOf('--channel')
    const peerIdx = args.indexOf('--peer')

    expect(channelIdx).toBeGreaterThanOrEqual(0)
    expect(args[channelIdx + 1]).toBe('telegram')
    expect(peerIdx).toBeGreaterThanOrEqual(0)
    expect(args[peerIdx + 1]).toBe('user42')
  })

  it('deliver passes --text with the reply content', async () => {
    await initCmd('pipeline-bot', { kind: 'user' })
    await startCmd('pipeline-bot')

    const threadPath = path.join(agentDir('pipeline-bot'), 'threads', 'peers', 'telegram-user42')
    const events = [{
      eventId: 'out-pipeline-1',
      content: {
        text: 'Specific pipeline reply',
        reply_context: { channel_type: 'external', channel_id: 'telegram', peer_id: 'user42' },
      },
    }]

    mockAgentExecCommand
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await deliverCmd({ thread: threadPath, consumer: 'outbound' })

    const xgwCall = mockAgentExecCommand.mock.calls.find(([cmd]) => cmd === 'xgw')!
    const args = xgwCall[1] as string[]
    const textIdx = args.indexOf('--text')

    expect(textIdx).toBeGreaterThanOrEqual(0)
    expect(args[textIdx + 1]).toBe('Specific pipeline reply')
  })
})

// ── Requirement 9.4: consumer_progress is updated after full pipeline ─────────

describe('Requirement 9.4 — consumer_progress is updated after full pipeline', () => {
  it('consumeMessages is called with consumer id "inbox" (tracks progress)', async () => {
    await initCmd('pipeline-bot', { kind: 'user' })
    await startCmd('pipeline-bot')
    mockConsumeMessages.mockClear()

    await runCmd('pipeline-bot')

    const [, consumerId] = mockConsumeMessages.mock.calls[0]!
    expect(consumerId).toBe('inbox')
  })

  it('deliver calls thread pop with consumer id to track outbound progress', async () => {
    await initCmd('pipeline-bot', { kind: 'user' })
    await startCmd('pipeline-bot')

    const threadPath = path.join(agentDir('pipeline-bot'), 'threads', 'peers', 'telegram-user42')
    const events = [{
      eventId: 'out-pipeline-1',
      content: {
        text: 'Reply',
        reply_context: { channel_type: 'external', channel_id: 'telegram', peer_id: 'user42' },
      },
    }]

    mockAgentExecCommand
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await deliverCmd({ thread: threadPath, consumer: 'outbound' })

    // thread pop call should include --consumer outbound
    const threadPopCall = mockAgentExecCommand.mock.calls.find(
      ([cmd, args]) => cmd === 'thread' && (args as string[]).includes('pop')
    )
    expect(threadPopCall).toBeDefined()
    const popArgs = threadPopCall![1] as string[]
    const consumerIdx = popArgs.indexOf('--consumer')
    expect(consumerIdx).toBeGreaterThanOrEqual(0)
    expect(popArgs[consumerIdx + 1]).toBe('outbound')
  })

  it('deliver calls thread ack after successful xgw send', async () => {
    await initCmd('pipeline-bot', { kind: 'user' })
    await startCmd('pipeline-bot')

    const threadPath = path.join(agentDir('pipeline-bot'), 'threads', 'peers', 'telegram-user42')
    const events = [{
      eventId: 'out-pipeline-1',
      content: {
        text: 'Reply',
        reply_context: { channel_type: 'external', channel_id: 'telegram', peer_id: 'user42' },
      },
    }]

    mockAgentExecCommand
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await deliverCmd({ thread: threadPath, consumer: 'outbound' })

    // Should have at least: thread pop, xgw send, thread ack
    const ackCall = mockAgentExecCommand.mock.calls.find(
      ([cmd, args]) => cmd === 'thread' && (args as string[]).includes('ack')
    )
    expect(ackCall).toBeDefined()
    expect(ackCall![0]).toBe('thread')
    expect(ackCall![1]).toContain('ack')
  })
})
