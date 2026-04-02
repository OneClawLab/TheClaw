import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  aggregateStatus,
  formatStatusText,
  formatStatusJson,
  fetchComponentStatus,
} from '../../src/commands/status.js'
import type { StatusResult } from '../../src/types.js'

vi.mock('../../src/repo-utils/os.js', () => ({
  execShell: vi.fn(),
}))

afterEach(() => {
  vi.clearAllMocks()
})

const mockResult: StatusResult = {
  notifier: { running: true, pid: 1234 },
  xgw: { running: true, pid: 5678, channels: [{ id: 'tui:main', type: 'tui', healthy: true }] },
  agents: [
    { id: 'admin', kind: 'system', started: true, inbox_pending: 0 },
    { id: 'warden', kind: 'user', started: false, inbox_pending: 2 },
  ],
}

describe('formatStatusText', () => {
  it('contains notifier status', () => {
    const text = formatStatusText(mockResult)
    expect(text).toContain('notifier')
    expect(text).toContain('running')
  })

  it('contains xgw status', () => {
    const text = formatStatusText(mockResult)
    expect(text).toContain('xgw')
  })

  it('contains agents section', () => {
    const text = formatStatusText(mockResult)
    expect(text).toContain('agents')
    expect(text).toContain('admin')
    expect(text).toContain('warden')
  })

  it('shows stopped status for non-running components', () => {
    const result: StatusResult = {
      ...mockResult,
      notifier: { running: false },
      xgw: { running: false },
    }
    const text = formatStatusText(result)
    expect(text).toContain('stopped')
  })
})

describe('formatStatusJson', () => {
  it('outputs valid JSON', () => {
    const json = formatStatusJson(mockResult)
    expect(() => JSON.parse(json)).not.toThrow()
  })

  it('contains xgw field', () => {
    const parsed = JSON.parse(formatStatusJson(mockResult))
    expect(parsed).toHaveProperty('xgw')
  })

  it('contains agents field', () => {
    const parsed = JSON.parse(formatStatusJson(mockResult))
    expect(parsed).toHaveProperty('agents')
    expect(Array.isArray(parsed.agents)).toBe(true)
  })
})

describe('aggregateStatus', () => {
  it('gracefully degrades when a component returns an error', async () => {
    const { execShell } = await import('../../src/repo-utils/os.js')
    vi.mocked(execShell).mockRejectedValue(new Error('command not found'))

    const result = await aggregateStatus({})
    expect(result.notifier.running).toBe(false)
    expect(result.xgw.running).toBe(false)
    expect(Array.isArray(result.agents)).toBe(true)
  })

  it('does not throw even when all components fail', async () => {
    const { execShell } = await import('../../src/repo-utils/os.js')
    vi.mocked(execShell).mockRejectedValue(new Error('all down'))

    await expect(aggregateStatus({})).resolves.not.toThrow()
  })
})

describe('fetchComponentStatus', () => {
  it('returns parsed JSON on success', async () => {
    const { execShell } = await import('../../src/repo-utils/os.js')
    vi.mocked(execShell).mockResolvedValue({ stdout: '{"running":true}', stderr: '' })

    const result = await fetchComponentStatus('notifier', 'notifier status --json')
    expect(result).toEqual({ running: true })
  })

  it('returns error object on failure', async () => {
    const { execShell } = await import('../../src/repo-utils/os.js')
    vi.mocked(execShell).mockRejectedValue(new Error('not found'))

    const result = await fetchComponentStatus('notifier', 'notifier status --json') as Record<string, unknown>
    expect(result).toHaveProperty('error')
  })
})
