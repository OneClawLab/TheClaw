import { describe, test, vi, beforeEach } from 'vitest'
import fc from 'fast-check'
import { formatStatusJson, fetchComponentStatus } from '../../src/commands/status.js'
import type { StatusResult } from '../../src/types.js'

// Mock execShell so Property 10 never actually runs shell commands
vi.mock('../../src/os-utils.js', () => ({
  execShell: vi.fn(),
}))

import { execShell } from '../../src/os-utils.js'
const mockExecShell = vi.mocked(execShell)

const agentStatusArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 20 }),
  kind: fc.string({ minLength: 1, maxLength: 20 }),
  started: fc.boolean(),
  inbox_pending: fc.integer({ min: 0, max: 1000 }),
  last_activity: fc.option(fc.string(), { nil: undefined }),
})

const notifierStatusArb = fc.record({
  running: fc.boolean(),
  pid: fc.option(fc.integer({ min: 1, max: 99999 }), { nil: undefined }),
})

const xgwChannelArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 20 }),
  type: fc.string({ minLength: 1, maxLength: 20 }),
  healthy: fc.boolean(),
})

const xgwStatusArb = fc.record({
  running: fc.boolean(),
  pid: fc.option(fc.integer({ min: 1, max: 99999 }), { nil: undefined }),
  channels: fc.option(fc.array(xgwChannelArb, { maxLength: 5 }), { nil: undefined }),
})

const statusResultArb: fc.Arbitrary<StatusResult> = fc.record({
  notifier: notifierStatusArb,
  xgw: xgwStatusArb,
  agents: fc.array(agentStatusArb, { maxLength: 10 }),
})

describe('status', () => {
  beforeEach(() => {
    // Default: simulate command failure (most random strings won't be valid commands)
    mockExecShell.mockRejectedValue(new Error('command not found'))
  })
  // Feature: theclaw-cli, Property 7: status JSON 输出结构完整性
  // Validates: Requirements 4.3, 4.6
  test('Property 7: formatStatusJson outputs valid JSON with required top-level fields', () => {
    fc.assert(
      fc.property(statusResultArb, (result) => {
        const json = formatStatusJson(result)

        // Must be valid JSON
        let parsed: unknown
        try {
          parsed = JSON.parse(json)
        } catch {
          return false
        }

        if (!parsed || typeof parsed !== 'object') return false
        const obj = parsed as Record<string, unknown>

        // Must have three top-level fields
        if (!('notifier' in obj)) return false
        if (!('xgw' in obj)) return false
        if (!('agents' in obj)) return false

        // agents must be an array
        if (!Array.isArray(obj['agents'])) return false

        return true
      }),
      { numRuns: 100 }
    )
  })

  // Feature: theclaw-cli, Property 10: 错误状态不中断 status 聚合
  // Validates: Requirements 4.5
  test('Property 10: fetchComponentStatus never throws, always returns an object', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        async (name, cmd) => {
          // fetchComponentStatus should never throw, even for invalid commands
          let result: unknown
          try {
            result = await fetchComponentStatus(name, cmd)
          } catch {
            return false // should not throw
          }
          // Result should always be a non-null object
          return typeof result === 'object' && result !== null
        }
      ),
      { numRuns: 100 }
    )
  })
})
