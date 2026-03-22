/**
 * Real LLM manual test — requires a configured LLM provider (API key).
 * Run via: npm run test:manual
 *
 * This file is intentionally excluded from the regular vitest.config.ts.
 * Results are logged to stdout for human evaluation of reply quality.
 *
 * Requirements: 7.2, 7.3
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { path } from '../../../agent/src/repo-utils/path.js'

// Mock only the cross-repo CLI calls (thread, xgw) — NOT the LLM
vi.mock('../../../agent/src/repo-utils/os.js', () => ({
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
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

import { execCommand } from '../../../agent/src/repo-utils/os.js'
import { consumeMessages } from '../../../agent/src/runner/inbox.js'
import { pushReply } from '../../../agent/src/runner/recorder.js'

const mockExecCommand = vi.mocked(execCommand)
const mockConsumeMessages = vi.mocked(consumeMessages)
const mockPushReply = vi.mocked(pushReply)

const { initCmd } = await import('../../../agent/src/commands/init.js')
const { startCmd } = await import('../../../agent/src/commands/start.js')
const { runCmd } = await import('../../../agent/src/commands/run.js')

function agentDir(id: string) {
  return path.join(tmpBase, '.theclaw', 'agents', id)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stdoutSpy: any

beforeEach(async () => {
  tmpBase = path.resolve(await mkdtemp(path.join(path.resolve(tmpdir()), 'agent-manual-test-')))
  vi.clearAllMocks()
  mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' })
  mockConsumeMessages.mockResolvedValue([])
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  stdoutSpy.mockRestore()
  await rm(tmpBase, { recursive: true, force: true })
})

describe('agent pipeline real LLM tests', () => {
  // Req 7.2, 7.3: real LLM agent processes a message and writes a reply
  it('agent run with real LLM produces a non-empty reply', async () => {
    await initCmd('bot', { kind: 'user' })
    await startCmd('bot')

    mockConsumeMessages.mockResolvedValue([{
      eventId: 'evt-real-1',
      type: 'message' as const,
      source: 'external:telegram:tg-123:dm:sess-1:user42',
      content: {
        text: 'Say hello in one sentence.',
        reply_context: {
          channel_type: 'external' as const,
          channel_id: 'telegram',
          peer_id: 'user42',
        },
      },
      timestamp: new Date().toISOString(),
    }])

    // Real LLM call — no mock on invokeLlm
    await runCmd('bot')

    // Structural assertion: pushReply was called with non-empty text
    expect(mockPushReply).toHaveBeenCalledOnce()
    const [, replyText] = mockPushReply.mock.calls[0]!
    expect(typeof replyText).toBe('string')
    expect((replyText as string).length).toBeGreaterThan(0)

    // run.lock cleaned up
    expect(existsSync(path.join(agentDir('bot'), 'run.lock'))).toBe(false)

    // Log for human evaluation
    console.log('\n=== Real LLM reply (please evaluate quality) ===')
    console.log(`Reply: "${replyText}"`)
    console.log('=== Expected: a greeting sentence ===\n')
  })
})
