import { describe, it, expect, vi, afterEach } from 'vitest'
import { extractVersion, isInstalled, getInstalledVersion, checkAll } from '../../src/component-manager.js'
import type { ComponentProvider } from '../../src/types.js'

vi.mock('../../src/repo-utils/os.js', () => ({
  commandExists: vi.fn(),
  execCommand: vi.fn(),
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe('extractVersion', () => {
  it('extracts version from v1.2.3 format', () => {
    expect(extractVersion('v1.2.3')).toBe('1.2.3')
  })

  it('extracts version from 1.2.3 format', () => {
    expect(extractVersion('1.2.3')).toBe('1.2.3')
  })

  it('extracts version from longer output string', () => {
    expect(extractVersion('pai version 0.5.0 (build 123)')).toBe('0.5.0')
  })

  it('returns null when no version found', () => {
    expect(extractVersion('no version here')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(extractVersion('')).toBeNull()
  })
})

describe('isInstalled', () => {
  it('returns true when commandExists returns true', async () => {
    const { commandExists } = await import('../../src/repo-utils/os.js')
    vi.mocked(commandExists).mockResolvedValue(true)
    expect(await isInstalled('pai')).toBe(true)
  })

  it('returns false when commandExists returns false', async () => {
    const { commandExists } = await import('../../src/repo-utils/os.js')
    vi.mocked(commandExists).mockResolvedValue(false)
    expect(await isInstalled('nonexistent')).toBe(false)
  })
})

describe('getInstalledVersion', () => {
  it('returns version string from command output', async () => {
    const { execCommand } = await import('../../src/repo-utils/os.js')
    vi.mocked(execCommand).mockResolvedValue({ stdout: 'v1.2.3', stderr: '' })
    const result = await getInstalledVersion({ command: 'pai' })
    expect(result).toBe('1.2.3')
  })

  it('returns null when command fails', async () => {
    const { execCommand } = await import('../../src/repo-utils/os.js')
    vi.mocked(execCommand).mockRejectedValue(new Error('not found'))
    const result = await getInstalledVersion({ command: 'missing' })
    expect(result).toBeNull()
  })
})

describe('checkAll', () => {
  it('calls isInstalled and getInstalledVersion for each component', async () => {
    const { commandExists, execCommand } = await import('../../src/repo-utils/os.js')
    vi.mocked(commandExists).mockResolvedValue(true)
    vi.mocked(execCommand).mockResolvedValue({ stdout: 'v0.5.0', stderr: '' })

    const provider: ComponentProvider = {
      name: 'registry',
      components: {
        pai: { version: '0.5.0', command: 'pai' },
        xgw: { version: '0.1.0', command: 'xgw' },
      },
      install: vi.fn(),
      needsAction: (current, target) => current !== target,
    }

    const results = await checkAll(provider)
    expect(results).toHaveLength(2)
    expect(results.every(r => r.installed)).toBe(true)
    expect(vi.mocked(commandExists)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(execCommand)).toHaveBeenCalledTimes(2)
  })
})
