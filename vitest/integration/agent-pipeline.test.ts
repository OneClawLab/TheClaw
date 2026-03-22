/**
 * Cross-repo integration tests: agent ↔ thread ↔ pai
 *
 * Focuses on the cross-repo interface contracts:
 * - agent run consumes inbox messages via thread pop (consumeMessages)
 * - agent run invokes LLM via pai chat (invokeLlm)
 * - agent run writes reply to peer thread
 * - agent run cleans up run.lock
 * - agent deliver calls xgw send
 *
 * NOTE: agent/vitest/integration/integration.test.ts already covers the full
 * init→start→run→deliver flow. This file focuses on the cross-repo parameter
 * contracts (what args are passed to thread, pai, xgw).
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { path } from '../../../agent/src/repo-utils/path.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../../agent/src/repo-utils/os.js', () => ({
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('../../../agent/src/runner/inbox.js', () => ({
  consumeMessages: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../../agent/src/runner/router.js', () => ({
  routeMessage: vi.fn().mockResolvedValue({ threadPath: '/tmp/thread', isNew: false }),
}))

vi.mock('../../../agent/src/runner/llm.js', () => ({
  invokeLlm: vi.fn().mockResolvedValue({ reply: 'Test reply from LLM' }),
  buildSessionFilePath: vi.fn((agentDir: string, threadId: string) =>
    `${agentDir}/sessions/${threadId}.jsonl`
  ),
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

import { execCommand } from '../../../agent/src/repo-utils/os.js'
import { consumeMessages } from '../../../agent/src/runner/inbox.js'
import { invokeLlm } from '../../../agent/src/runner/llm.js'
import { pushMessage, pushReply } from '../../../agent/src/runner/recorder.js'

const mockExecCommand = vi.mocked(execCommand)
const mockConsumeMessages = vi.mocked(consumeMessages)
const mockInvokeLlm = vi.mocked(invokeLlm)
const mockPushMessage = vi.mocked(pushMessage)
const mockPushReply = vi.mocked(pushReply)

// Import commands AFTER mocks
const { initCmd } = await import('../../../agent/src/commands/init.js')
const { startCmd } = await import('../../../agent/src/commands/start.js')
const { runCmd } = await import('../../../agent/src/commands/run.js')
const { deliverCmd } = await import('../../../agent/src/commands/deliver.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

function agentDir(id: string) {
  return path.join(tmpBase, '.theclaw', 'agents', id)
}

function makeInboxMessage(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-inbox-1',
    type: 'message' as const,
    source: 'external:telegram:tg-123:dm:sess-1:user42',
    content: {
      text: 'Hello agent',
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
  tmpBase = path.resolve(await mkdtemp(path.join(path.resolve(tmpdir()), 'agent-pipeline-test-')))
  vi.clearAllMocks()
  mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' })
  mockConsumeMessages.mockResolvedValue([])
  mockInvokeLlm.mockResolvedValue({ reply: 'Test reply from LLM' })
  mockPushMessage.mockResolvedValue('evt-msg-1')
  mockPushReply.mockResolvedValue('evt-reply-1')
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  stdoutSpy.mockRestore()
  consoleSpy.mockRestore()
  await rm(tmpBase, { recursive: true, force: true })
})

// ── Requirement 7.1: agent run calls consumeMessages to read inbox ────────────

describe('Requirement 7.1 — agent run calls consumeMessages to read inbox', () => {
  it('consumeMessages is called when agent run executes', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')
    mockConsumeMessages.mockClear()

    await runCmd('bot')

    expect(mockConsumeMessages).toHaveBeenCalledOnce()
  })

  it('consumeMessages is called with the agent inbox path', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')
    mockConsumeMessages.mockClear()

    await runCmd('bot')

    const [inboxPath] = mockConsumeMessages.mock.calls[0]!
    expect(inboxPath).toContain('bot')
    expect(inboxPath).toContain('inbox')
  })

  it('consumeMessages is called with consumer id "inbox"', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')
    mockConsumeMessages.mockClear()

    await runCmd('bot')

    const [, consumerId] = mockConsumeMessages.mock.calls[0]!
    expect(consumerId).toBe('inbox')
  })
})

// ── Requirement 7.2: agent run calls invokeLlm with correct agent config ──────

describe('Requirement 7.2 — agent run calls invokeLlm with correct agent config', () => {
  it('invokeLlm is called when there are inbox messages', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')
    mockConsumeMessages.mockResolvedValue([makeInboxMessage()])

    await runCmd('bot')

    expect(mockInvokeLlm).toHaveBeenCalledOnce()
  })

  it('invokeLlm is NOT called when inbox is empty', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')
    mockConsumeMessages.mockResolvedValue([])

    await runCmd('bot')

    expect(mockInvokeLlm).not.toHaveBeenCalled()
  })

  it('invokeLlm receives provider and model from agent config', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')
    mockConsumeMessages.mockResolvedValue([makeInboxMessage()])

    await runCmd('bot')

    const params = mockInvokeLlm.mock.calls[0]![0]
    expect(params.provider).toBeTruthy()
    expect(params.model).toBeTruthy()
  })

  it('invokeLlm receives a session file path ending in .jsonl', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')
    mockConsumeMessages.mockResolvedValue([makeInboxMessage()])

    await runCmd('bot')

    const params = mockInvokeLlm.mock.calls[0]![0]
    expect(params.sessionFile).toBeTruthy()
    expect(params.sessionFile).toContain('.jsonl')
  })
})

// ── Requirement 7.3: agent run writes reply to peer thread ────────────────────

describe('Requirement 7.3 — agent run writes reply to peer thread', () => {
  it('pushReply is called after invokeLlm returns a reply', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')
    mockConsumeMessages.mockResolvedValue([makeInboxMessage()])
    mockInvokeLlm.mockResolvedValue({ reply: 'Hello from bot!' })

    await runCmd('bot')

    expect(mockPushReply).toHaveBeenCalledOnce()
  })

  it('pushReply is called with the LLM reply text', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')
    mockConsumeMessages.mockResolvedValue([makeInboxMessage()])
    mockInvokeLlm.mockResolvedValue({ reply: 'Specific reply text' })

    await runCmd('bot')

    const [, replyText] = mockPushReply.mock.calls[0]!
    expect(replyText).toBe('Specific reply text')
  })

  it('pushReply is called with reply_context containing channel_id and peer_id', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')
    mockConsumeMessages.mockResolvedValue([makeInboxMessage()])

    await runCmd('bot')

    const [, , replyContext] = mockPushReply.mock.calls[0]!
    expect(replyContext).toMatchObject({
      channel_id: 'telegram',
      peer_id: 'user42',
    })
  })

  it('pushMessage is called before pushReply', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')
    mockConsumeMessages.mockResolvedValue([makeInboxMessage()])

    await runCmd('bot')

    expect(mockPushMessage).toHaveBeenCalledOnce()
    const pushMessageOrder = mockPushMessage.mock.invocationCallOrder[0]!
    const pushReplyOrder = mockPushReply.mock.invocationCallOrder[0]!
    expect(pushMessageOrder).toBeLessThan(pushReplyOrder)
  })
})

// ── Requirement 7.4: agent run cleans up run.lock ─────────────────────────────

describe('Requirement 7.4 — agent run cleans up run.lock after processing', () => {
  it('run.lock does not exist after run completes with messages', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')
    mockConsumeMessages.mockResolvedValue([makeInboxMessage()])

    await runCmd('bot')

    expect(existsSync(path.join(agentDir('bot'), 'run.lock'))).toBe(false)
  })

  it('run.lock does not exist after run with empty inbox', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')
    mockConsumeMessages.mockResolvedValue([])

    await runCmd('bot')

    expect(existsSync(path.join(agentDir('bot'), 'run.lock'))).toBe(false)
  })
})

// ── Requirement 7.5: agent deliver calls xgw send ────────────────────────────

describe('Requirement 7.5 — agent deliver calls xgw send', () => {
  it('deliver calls execCommand with "xgw" for external channel events', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')

    const threadPath = path.join(agentDir('bot'), 'threads', 'peers', 'telegram-user42')
    const events = [{
      eventId: 'out-1',
      content: {
        text: 'Hello from bot!',
        reply_context: { channel_type: 'external', channel_id: 'telegram', peer_id: 'user42' },
      },
    }]

    mockExecCommand
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' }) // thread pop
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                      // xgw send
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                      // thread ack

    await deliverCmd({ thread: threadPath, consumer: 'outbound' })

    const xgwCall = mockExecCommand.mock.calls.find(([cmd]) => cmd === 'xgw')
    expect(xgwCall).toBeDefined()
    expect(xgwCall![1]).toContain('send')
  })

  it('deliver passes --channel and --peer to xgw send', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')

    const threadPath = path.join(agentDir('bot'), 'threads', 'peers', 'telegram-user42')
    const events = [{
      eventId: 'out-1',
      content: {
        text: 'Reply text',
        reply_context: { channel_type: 'external', channel_id: 'telegram', peer_id: 'user42' },
      },
    }]

    mockExecCommand
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await deliverCmd({ thread: threadPath, consumer: 'outbound' })

    const xgwCall = mockExecCommand.mock.calls.find(([cmd]) => cmd === 'xgw')!
    const args = xgwCall[1] as string[]
    const channelIdx = args.indexOf('--channel')
    const peerIdx = args.indexOf('--peer')

    expect(channelIdx).toBeGreaterThanOrEqual(0)
    expect(args[channelIdx + 1]).toBe('telegram')
    expect(peerIdx).toBeGreaterThanOrEqual(0)
    expect(args[peerIdx + 1]).toBe('user42')
  })

  it('deliver passes --text with the reply content to xgw send', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')

    const threadPath = path.join(agentDir('bot'), 'threads', 'peers', 'telegram-user42')
    const events = [{
      eventId: 'out-1',
      content: {
        text: 'Specific reply content',
        reply_context: { channel_type: 'external', channel_id: 'telegram', peer_id: 'user42' },
      },
    }]

    mockExecCommand
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await deliverCmd({ thread: threadPath, consumer: 'outbound' })

    const xgwCall = mockExecCommand.mock.calls.find(([cmd]) => cmd === 'xgw')!
    const args = xgwCall[1] as string[]
    const textIdx = args.indexOf('--text')

    expect(textIdx).toBeGreaterThanOrEqual(0)
    expect(args[textIdx + 1]).toBe('Specific reply content')
  })
})
