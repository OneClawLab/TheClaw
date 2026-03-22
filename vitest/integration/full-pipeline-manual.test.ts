/**
 * Real LLM full pipeline manual test — requires a configured LLM provider (API key).
 * Run via: npm run test:manual
 *
 * This file is intentionally excluded from the regular vitest.config.ts.
 * Tests the complete xgw → agent run → deliver chain with a real LLM.
 * Results are logged to stdout for human evaluation.
 *
 * Requirements: 9.1, 9.2, 9.3
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

// consumeMessages is mocked to inject a test message without needing a real thread
vi.mock('../../../agent/src/runner/inbox.js', () => ({
  consumeMessages: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../../agent/src/runner/router.js', () => ({
  routeMessage: vi.fn().mockResolvedValue({ threadPath: '/tmp/thread', isNew: false }),
}))

// recorder is mocked to capture what gets written without needing a real thread
vi.mock('../../../agent/src/runner/recorder.js', () => ({
  pushMessage: vi.fn().mockResolvedValue('evt-msg-1'),
  pushReply: vi.fn().mockResolvedValue('evt-reply-1'),
  pushRecord: vi.fn().mockResolvedValue('evt-rec-1'),
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
import { pushReply } from '../../../agent/src/runner/recorder.js'

const mockConsumeMessages = vi.mocked(consumeMessages)
const mockPushReply = vi.mocked(pushReply)

// Import commands AFTER mocks
const { InboxWriter } = await import('../../../xgw/src/inbox.js')
const { initCmd } = await import('../../../agent/src/commands/init.js')
const { startCmd } = await import('../../../agent/src/commands/start.js')
const { runCmd } = await import('../../../agent/src/commands/run.js')
const { deliverCmd } = await import('../../../agent/src/commands/deliver.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

function agentDir(id: string) {
  return path.join(tmpBase, '.theclaw', 'agents', id)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stdoutSpy: any

beforeEach(async () => {
  tmpBase = path.resolve(await mkdtemp(path.join(path.resolve(tmpdir()), 'full-pipeline-manual-')))
  vi.clearAllMocks()
  mockXgwExecCommand.mockResolvedValue({ stdout: '', stderr: '' })
  mockAgentExecCommand.mockResolvedValue({ stdout: '', stderr: '' })
  mockConsumeMessages.mockResolvedValue([])
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  stdoutSpy.mockRestore()
  await rm(tmpBase, { recursive: true, force: true })
})

describe('full pipeline real LLM tests', () => {
  // Req 9.1, 9.2: xgw InboxWriter writes to agent inbox, agent run processes with real LLM
  it('xgw InboxWriter writes message and agent run produces a non-empty reply', async () => {
    // Step 1: Verify InboxWriter calls thread push (Req 9.1)
    const writer = new InboxWriter()
    const msg = {
      id: 'msg-real-1',
      channel_id: 'tg-channel-real',
      peer_id: 'user-real',
      peer_name: 'Real User',
      session_id: 'sess-real-1',
      text: 'Say hello in one sentence.',
      attachments: [],
      reply_to: null,
      created_at: new Date().toISOString(),
      raw: {},
    }
    const agentsConfig = { 'real-bot': { inbox: '/tmp/real-bot-inbox' } }

    await writer.push('real-bot', msg, 'telegram', agentsConfig)

    // Structural assertion: thread push was called (Req 9.1)
    expect(mockXgwExecCommand).toHaveBeenCalledOnce()
    const [xgwCmd, xgwArgs] = mockXgwExecCommand.mock.calls[0] as [string, string[]]
    expect(xgwCmd).toBe('thread')
    expect(xgwArgs[0]).toBe('push')

    console.log('\n=== Req 9.1: xgw InboxWriter thread push args ===')
    console.log(`Command: ${xgwCmd} ${xgwArgs.join(' ')}`)
    console.log('=== Expected: thread push with --source, --type, --content ===\n')

    // Step 2: Agent run with real LLM (Req 9.2)
    await initCmd('real-bot', { kind: 'user' })
    await startCmd('real-bot')

    mockConsumeMessages.mockResolvedValue([{
      eventId: 'evt-real-pipeline-1',
      type: 'message' as const,
      source: 'external:telegram:tg-channel-real:dm:sess-real-1:user-real',
      content: {
        text: 'Say hello in one sentence.',
        reply_context: {
          channel_type: 'external' as const,
          channel_id: 'telegram',
          peer_id: 'user-real',
        },
      },
      timestamp: new Date().toISOString(),
    }])

    // Real LLM call — invokeLlm is NOT mocked
    await runCmd('real-bot')

    // Structural assertion: reply was written (Req 9.2)
    expect(mockPushReply).toHaveBeenCalledOnce()
    const [, replyText, replyContext] = mockPushReply.mock.calls[0]!
    expect(typeof replyText).toBe('string')
    expect((replyText as string).length).toBeGreaterThan(0)
    expect(replyContext).toMatchObject({ channel_id: 'telegram', peer_id: 'user-real' })

    // run.lock cleaned up
    expect(existsSync(path.join(agentDir('real-bot'), 'run.lock'))).toBe(false)

    console.log('\n=== Req 9.2: Real LLM reply (please evaluate quality) ===')
    console.log(`Reply: "${replyText}"`)
    console.log('=== Expected: a greeting sentence ===\n')
  })

  // Req 9.3: agent deliver calls xgw send with correct args
  it('agent deliver calls xgw send with non-empty text', async () => {
    await initCmd('real-bot', { kind: 'user' })
    await startCmd('real-bot')

    const threadPath = path.join(agentDir('real-bot'), 'threads', 'peers', 'telegram-user-real')
    const replyText = 'Hello from the real pipeline!'
    const events = [{
      eventId: 'out-real-1',
      content: {
        text: replyText,
        reply_context: { channel_type: 'external', channel_id: 'telegram', peer_id: 'user-real' },
      },
    }]

    mockAgentExecCommand
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' }) // thread pop
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                      // xgw send
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                      // thread ack

    await deliverCmd({ thread: threadPath, consumer: 'outbound' })

    // Structural assertion: xgw send was called (Req 9.3)
    const xgwSendCall = mockAgentExecCommand.mock.calls.find(([cmd]) => cmd === 'xgw')
    expect(xgwSendCall).toBeDefined()
    const sendArgs = xgwSendCall![1] as string[]
    expect(sendArgs).toContain('send')

    const textIdx = sendArgs.indexOf('--text')
    expect(textIdx).toBeGreaterThanOrEqual(0)
    const deliveredText = sendArgs[textIdx + 1] as string
    expect(deliveredText.length).toBeGreaterThan(0)

    console.log('\n=== Req 9.3: xgw send args ===')
    console.log(`xgw ${sendArgs.join(' ')}`)
    console.log(`Delivered text: "${deliveredText}"`)
    console.log('=== Expected: non-empty text delivered to correct channel/peer ===\n')
  })
})
