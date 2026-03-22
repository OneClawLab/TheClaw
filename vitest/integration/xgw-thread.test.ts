/**
 * Cross-repo integration tests: xgw ↔ thread
 *
 * Tests InboxWriter (message routing into agent inbox thread) and Router
 * (channel/peer → agent resolution) from the xgw repo.
 *
 * Mock strategy: vi.mock xgw/src/repo-utils/os.js to capture execCommand calls
 * (thread push) without actually spawning processes.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Mock execCommand before importing modules that use it ────────────────────

const { mockExecCommand } = vi.hoisted(() => ({
  mockExecCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('../../../xgw/src/repo-utils/os.js', () => ({
  execCommand: mockExecCommand,
}))

// ── Imports under test (after mock setup) ────────────────────────────────────

import { InboxWriter } from '../../../xgw/src/inbox.js'
import { Router } from '../../../xgw/src/gateway/router.js'
import type { Message } from '../../../xgw/src/types.js'
import type { RoutingRule } from '../../../xgw/src/config.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function makeAgentsConfig(agentId: string, inbox: string): Record<string, { inbox: string }> {
  return { [agentId]: { inbox } }
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Requirement 6.1: InboxWriter.push calls thread push with correct args ────

describe('Requirement 6.1 — InboxWriter.push calls thread push with correct args', () => {
  it('calls execCommand with "thread" as the command', async () => {
    const writer = new InboxWriter()
    const msg = makeMessage()
    const agentsConfig = makeAgentsConfig('agent-1', '/tmp/agent-1-inbox')

    await writer.push('agent-1', msg, 'telegram', agentsConfig)

    expect(mockExecCommand).toHaveBeenCalledOnce()
    const [cmd] = mockExecCommand.mock.calls[0] as [string, string[]]
    expect(cmd).toBe('thread')
  })

  it('passes "push" as the first argument', async () => {
    const writer = new InboxWriter()
    const msg = makeMessage()
    const agentsConfig = makeAgentsConfig('agent-1', '/tmp/agent-1-inbox')

    await writer.push('agent-1', msg, 'telegram', agentsConfig)

    const [, args] = mockExecCommand.mock.calls[0] as [string, string[]]
    expect(args[0]).toBe('push')
  })

  it('passes --thread with the agent inbox path', async () => {
    const writer = new InboxWriter()
    const msg = makeMessage()
    const inboxPath = '/tmp/my-agent-inbox'
    const agentsConfig = makeAgentsConfig('agent-1', inboxPath)

    await writer.push('agent-1', msg, 'telegram', agentsConfig)

    const [, args] = mockExecCommand.mock.calls[0] as [string, string[]]
    const idx = args.indexOf('--thread')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe(inboxPath)
  })

  it('passes --source with the formatted source string', async () => {
    const writer = new InboxWriter()
    const msg = makeMessage({ channel_id: 'tg-123', session_id: 'sess-abc', peer_id: 'peer-99' })
    const agentsConfig = makeAgentsConfig('agent-1', '/tmp/inbox')

    await writer.push('agent-1', msg, 'telegram', agentsConfig)

    const [, args] = mockExecCommand.mock.calls[0] as [string, string[]]
    const idx = args.indexOf('--source')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('external:telegram:tg-123:dm:sess-abc:peer-99')
  })

  it('passes --type with value "message"', async () => {
    const writer = new InboxWriter()
    const msg = makeMessage()
    const agentsConfig = makeAgentsConfig('agent-1', '/tmp/inbox')

    await writer.push('agent-1', msg, 'telegram', agentsConfig)

    const [, args] = mockExecCommand.mock.calls[0] as [string, string[]]
    const idx = args.indexOf('--type')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('message')
  })

  it('passes --content with JSON-serialized message (excluding raw field)', async () => {
    const writer = new InboxWriter()
    const msg = makeMessage({ text: 'Hello world', raw: { internal: 'data' } })
    const agentsConfig = makeAgentsConfig('agent-1', '/tmp/inbox')

    await writer.push('agent-1', msg, 'telegram', agentsConfig)

    const [, args] = mockExecCommand.mock.calls[0] as [string, string[]]
    const idx = args.indexOf('--content')
    expect(idx).toBeGreaterThanOrEqual(0)

    const content = JSON.parse(args[idx + 1] as string) as Record<string, unknown>
    expect(content['text']).toBe('Hello world')
    expect(content).not.toHaveProperty('raw')
  })
})

// ── Requirement 6.2: source field format ─────────────────────────────────────

describe('Requirement 6.2 — source field format is external:<channelType>:<channelId>:dm:<sessionId>:<peerId>', () => {
  it('formats source correctly for telegram channel', async () => {
    const writer = new InboxWriter()
    const msg = makeMessage({
      channel_id: 'tg-channel-1',
      session_id: 'session-xyz',
      peer_id: 'peer-123',
    })
    const agentsConfig = makeAgentsConfig('agent-1', '/tmp/inbox')

    await writer.push('agent-1', msg, 'telegram', agentsConfig)

    const [, args] = mockExecCommand.mock.calls[0] as [string, string[]]
    const sourceIdx = args.indexOf('--source')
    const source = args[sourceIdx + 1] as string

    expect(source).toBe('external:telegram:tg-channel-1:dm:session-xyz:peer-123')
  })

  it('formats source correctly for a different channel type', async () => {
    const writer = new InboxWriter()
    const msg = makeMessage({
      channel_id: 'slack-C001',
      session_id: 'sess-001',
      peer_id: 'U001',
    })
    const agentsConfig = makeAgentsConfig('agent-1', '/tmp/inbox')

    await writer.push('agent-1', msg, 'slack', agentsConfig)

    const [, args] = mockExecCommand.mock.calls[0] as [string, string[]]
    const sourceIdx = args.indexOf('--source')
    const source = args[sourceIdx + 1] as string

    expect(source).toMatch(/^external:slack:slack-C001:dm:sess-001:U001$/)
  })

  it('source has exactly 6 colon-separated parts', async () => {
    const writer = new InboxWriter()
    const msg = makeMessage()
    const agentsConfig = makeAgentsConfig('agent-1', '/tmp/inbox')

    await writer.push('agent-1', msg, 'telegram', agentsConfig)

    const [, args] = mockExecCommand.mock.calls[0] as [string, string[]]
    const sourceIdx = args.indexOf('--source')
    const source = args[sourceIdx + 1] as string
    const parts = source.split(':')

    expect(parts).toHaveLength(6)
    expect(parts[0]).toBe('external')
    expect(parts[3]).toBe('dm')
  })
})

// ── Requirement 6.3: Router.resolve — exact match takes priority ──────────────

describe('Requirement 6.3 — Router.resolve: exact match takes priority over wildcard', () => {
  it('returns exact match agent when both exact and wildcard rules exist', () => {
    const rules: RoutingRule[] = [
      { channel: 'telegram', peer: '*', agent: 'wildcard-agent' },
      { channel: 'telegram', peer: 'user42', agent: 'exact-agent' },
    ]
    const router = new Router(rules)

    const result = router.resolve('telegram', 'user42')

    expect(result).toBe('exact-agent')
  })

  it('returns exact match even when wildcard rule appears first', () => {
    const rules: RoutingRule[] = [
      { channel: 'telegram', peer: '*', agent: 'wildcard-agent' },
      { channel: 'telegram', peer: 'user42', agent: 'exact-agent' },
    ]
    const router = new Router(rules)

    expect(router.resolve('telegram', 'user42')).toBe('exact-agent')
  })

  it('falls back to wildcard when no exact match exists', () => {
    const rules: RoutingRule[] = [
      { channel: 'telegram', peer: '*', agent: 'wildcard-agent' },
      { channel: 'telegram', peer: 'user42', agent: 'exact-agent' },
    ]
    const router = new Router(rules)

    expect(router.resolve('telegram', 'unknown-user')).toBe('wildcard-agent')
  })

  it('exact match on different channel does not interfere', () => {
    const rules: RoutingRule[] = [
      { channel: 'slack', peer: 'user42', agent: 'slack-agent' },
      { channel: 'telegram', peer: '*', agent: 'tg-wildcard' },
    ]
    const router = new Router(rules)

    expect(router.resolve('telegram', 'user42')).toBe('tg-wildcard')
  })
})

// ── Requirement 6.4: Router.resolve — no match returns null ──────────────────

describe('Requirement 6.4 — Router.resolve: no match returns null', () => {
  it('returns null when rules list is empty', () => {
    const router = new Router([])

    expect(router.resolve('telegram', 'user42')).toBeNull()
  })

  it('returns null when channel does not match any rule', () => {
    const rules: RoutingRule[] = [
      { channel: 'slack', peer: '*', agent: 'slack-agent' },
    ]
    const router = new Router(rules)

    expect(router.resolve('telegram', 'user42')).toBeNull()
  })

  it('returns null when peer does not match and no wildcard exists', () => {
    const rules: RoutingRule[] = [
      { channel: 'telegram', peer: 'user1', agent: 'agent-1' },
      { channel: 'telegram', peer: 'user2', agent: 'agent-2' },
    ]
    const router = new Router(rules)

    expect(router.resolve('telegram', 'user99')).toBeNull()
  })

  it('returns null after reload with empty rules', () => {
    const rules: RoutingRule[] = [
      { channel: 'telegram', peer: '*', agent: 'agent-1' },
    ]
    const router = new Router(rules)
    router.reload([])

    expect(router.resolve('telegram', 'user42')).toBeNull()
  })
})

// ── Requirement 6.5: InboxWriter.push throws when agent not in config ─────────

describe('Requirement 6.5 — InboxWriter.push throws error when agent not in config', () => {
  it('throws an error when agentId is not in agentsConfig', async () => {
    const writer = new InboxWriter()
    const msg = makeMessage()
    const agentsConfig = makeAgentsConfig('other-agent', '/tmp/inbox')

    await expect(
      writer.push('nonexistent-agent', msg, 'telegram', agentsConfig)
    ).rejects.toThrow('nonexistent-agent')
  })

  it('throws an error when agentsConfig is empty', async () => {
    const writer = new InboxWriter()
    const msg = makeMessage()

    await expect(
      writer.push('agent-1', msg, 'telegram', {})
    ).rejects.toThrow('agent-1')
  })

  it('does not call execCommand when agent is not found', async () => {
    const writer = new InboxWriter()
    const msg = makeMessage()

    try {
      await writer.push('missing-agent', msg, 'telegram', {})
    } catch {
      // expected
    }

    expect(mockExecCommand).not.toHaveBeenCalled()
  })

  it('error message contains the missing agent id', async () => {
    const writer = new InboxWriter()
    const msg = makeMessage()
    const agentId = 'my-special-agent'

    await expect(
      writer.push(agentId, msg, 'telegram', {})
    ).rejects.toThrow(agentId)
  })
})
