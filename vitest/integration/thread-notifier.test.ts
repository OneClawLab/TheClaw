/**
 * Cross-repo integration tests: thread ↔ notifier
 *
 * Tests the link between thread push and notifier scheduling.
 * Mocks execCommand from repo-utils/os to capture notifier CLI calls.
 * Uses real SQLite (tmpdir isolation).
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'

// ── Mock repo-utils/os before any imports that use it ────────────────────────
// notifier-client.ts uses execCommand from repo-utils/os.js
// Use vi.hoisted so mockExecCommand is available when the factory runs

const { mockExecCommand } = vi.hoisted(() => ({
  mockExecCommand: vi.fn(),
}))

vi.mock('../../../thread/src/repo-utils/os.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../thread/src/repo-utils/os.js')>()
  return {
    ...actual,
    execCommand: mockExecCommand,
  }
})

// ── Imports under test (after mock setup) ────────────────────────────────────

import { scheduleDispatch, buildTaskId } from '../../../thread/src/notifier-client.js'
import { openDb, initSchema } from '../../../thread/src/db/init.js'
import { insertEvent, getEventCount } from '../../../thread/src/db/queries.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

interface TestThread {
  dir: string
  cleanup: () => void
}

function createTestThread(): TestThread {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'thread-notifier-test-'))
  fs.mkdirSync(nodePath.join(dir, 'run'), { recursive: true })
  fs.mkdirSync(nodePath.join(dir, 'logs'), { recursive: true })
  fs.writeFileSync(nodePath.join(dir, 'events.jsonl'), '', 'utf8')

  const db = openDb(dir)
  initSchema(db)
  db.close()

  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let thread: TestThread

beforeEach(() => {
  thread = createTestThread()
  vi.clearAllMocks()

  // Default: execCommand succeeds (notifier available)
  mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' })
})

afterEach(() => {
  thread.cleanup()
})

// ── Requirement 5.1: push triggers notifier task add ─────────────────────────

describe('Requirement 5.1 — push triggers notifier task add', () => {
  it('scheduleDispatch calls execCommand with notifier and task add args', async () => {
    await scheduleDispatch(thread.dir, 'agent-1')

    expect(mockExecCommand).toHaveBeenCalledOnce()
    const [cmd, args] = mockExecCommand.mock.calls[0] as [string, string[], ...unknown[]]
    expect(cmd).toBe('notifier')
    expect(args).toContain('task')
    expect(args).toContain('add')
  })

  it('scheduleDispatch passes --author with the source value', async () => {
    await scheduleDispatch(thread.dir, 'my-source')

    const [, args] = mockExecCommand.mock.calls[0] as [string, string[], ...unknown[]]
    const authorIdx = args.indexOf('--author')
    expect(authorIdx).toBeGreaterThanOrEqual(0)
    expect(args[authorIdx + 1]).toBe('my-source')
  })

  it('scheduleDispatch passes --command containing thread dispatch', async () => {
    await scheduleDispatch(thread.dir, 'agent-1')

    const [, args] = mockExecCommand.mock.calls[0] as [string, string[], ...unknown[]]
    const cmdIdx = args.indexOf('--command')
    expect(cmdIdx).toBeGreaterThanOrEqual(0)
    expect(args[cmdIdx + 1]).toContain('thread dispatch')
    expect(args[cmdIdx + 1]).toContain(thread.dir)
  })
})

// ── Requirement 5.2: task-id contains threadDir path encoding ────────────────

describe('Requirement 5.2 — task-id encodes threadDir path', () => {
  it('buildTaskId produces deterministic id for same path', () => {
    const id1 = buildTaskId(thread.dir)
    const id2 = buildTaskId(thread.dir)
    expect(id1).toBe(id2)
  })

  it('buildTaskId produces different ids for different paths', () => {
    const thread2 = createTestThread()
    try {
      const id1 = buildTaskId(thread.dir)
      const id2 = buildTaskId(thread2.dir)
      expect(id1).not.toBe(id2)
    } finally {
      thread2.cleanup()
    }
  })

  it('scheduleDispatch passes --task-id containing path encoding', async () => {
    await scheduleDispatch(thread.dir, 'agent-1')

    const [, args] = mockExecCommand.mock.calls[0] as [string, string[], ...unknown[]]
    const taskIdIdx = args.indexOf('--task-id')
    expect(taskIdIdx).toBeGreaterThanOrEqual(0)

    const taskId = args[taskIdIdx + 1] as string
    expect(taskId).toBe(buildTaskId(thread.dir))
  })

  it('same threadDir always generates same task-id across multiple calls', async () => {
    await scheduleDispatch(thread.dir, 'src-a')
    await scheduleDispatch(thread.dir, 'src-b')

    const calls = mockExecCommand.mock.calls as [string, string[], ...unknown[]][]
    const taskId1 = (calls[0]![1] as string[])[((calls[0]![1] as string[]).indexOf('--task-id')) + 1]
    const taskId2 = (calls[1]![1] as string[])[((calls[1]![1] as string[]).indexOf('--task-id')) + 1]
    expect(taskId1).toBe(taskId2)
  })
})

// ── Requirement 5.3: notifier unavailable — push still succeeds ───────────────

describe('Requirement 5.3 — notifier unavailable does not fail push', () => {
  it('scheduleDispatch does not throw when execCommand throws (notifier not found)', async () => {
    mockExecCommand.mockRejectedValue(new Error('notifier: command not found'))

    // Must not throw
    await expect(scheduleDispatch(thread.dir, 'agent-1')).resolves.toBeUndefined()
  })

  it('event is written to SQLite even when notifier is unavailable', async () => {
    mockExecCommand.mockRejectedValue(new Error('notifier: command not found'))

    const db = openDb(thread.dir)
    try {
      insertEvent(db, { source: 'agent-1', type: 'message', content: 'hello' })
      await scheduleDispatch(thread.dir, 'agent-1')
      expect(getEventCount(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('multiple events persist to SQLite regardless of notifier availability', async () => {
    mockExecCommand.mockRejectedValue(new Error('notifier unavailable'))

    const db = openDb(thread.dir)
    try {
      insertEvent(db, { source: 'src', type: 'msg', content: 'c1' })
      insertEvent(db, { source: 'src', type: 'msg', content: 'c2' })
      await scheduleDispatch(thread.dir, 'src')
      expect(getEventCount(db)).toBe(2)
    } finally {
      db.close()
    }
  })
})

// ── Requirement 5.4: scheduleDispatch with exit code 1 does not throw ─────────

describe('Requirement 5.4 — exit code 1 (task already exists) does not throw', () => {
  it('scheduleDispatch resolves when execCommand returns exit code 1', async () => {
    mockExecCommand.mockRejectedValue(new Error('notifier exited with code 1: task already exists'))

    await expect(scheduleDispatch(thread.dir, 'agent-1')).resolves.toBeUndefined()
  })

  it('scheduleDispatch does not propagate exit code 1 error', async () => {
    let threw = false
    mockExecCommand.mockRejectedValue(new Error('notifier exited with code 1: task already exists'))

    try {
      await scheduleDispatch(thread.dir, 'agent-1')
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
  })
})
