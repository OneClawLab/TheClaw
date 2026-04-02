import { describe, it, expect, vi, afterEach } from 'vitest'
import { filterComponents, runUpgrade } from '../../src/commands/upgrade.js'
import { CliError } from '../../src/profile-loader.js'
import type { ComponentProvider } from '../../src/types.js'

vi.mock('../../src/repo-utils/os.js', () => ({
  execShell: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('../../src/component-manager.js', () => ({
  getInstalledVersion: vi.fn(),
  installComponent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/components.js', () => ({
  getProvider: vi.fn(),
}))

afterEach(() => {
  vi.clearAllMocks()
})

const mockProvider: ComponentProvider = {
  name: 'registry',
  components: {
    pai: { version: '0.5.0', command: 'pai' },
    xgw: { version: '0.1.0', command: 'xgw' },
  },
  install: vi.fn().mockResolvedValue(undefined),
  needsAction: (current, target) => current !== target,
}

describe('filterComponents', () => {
  it('returns all components when no name specified', () => {
    const result = filterComponents(mockProvider)
    expect(result.map(c => c.name)).toContain('pai')
    expect(result.map(c => c.name)).toContain('xgw')
  })

  it('returns single component when name matches', () => {
    const result = filterComponents(mockProvider, 'pai')
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('pai')
  })

  it('throws CliError with exitCode 2 when component does not exist', () => {
    expect(() => filterComponents(mockProvider, 'nonexistent')).toThrow(CliError)
    try {
      filterComponents(mockProvider, 'nonexistent')
    } catch (err) {
      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).exitCode).toBe(2)
    }
  })
})

describe('runUpgrade', () => {
  it('dry-run mode does not call installComponent', async () => {
    const { getProvider } = await import('../../src/components.js')
    const { getInstalledVersion } = await import('../../src/component-manager.js')
    vi.mocked(getProvider).mockReturnValue(mockProvider)
    vi.mocked(getInstalledVersion).mockResolvedValue('0.4.0')

    await runUpgrade({ dryRun: true, provider: 'registry' })

    const { installComponent } = await import('../../src/component-manager.js')
    expect(vi.mocked(installComponent)).not.toHaveBeenCalled()
  })

  it('outputs "already at" when component is up to date', async () => {
    const { getProvider } = await import('../../src/components.js')
    const { getInstalledVersion } = await import('../../src/component-manager.js')
    vi.mocked(getProvider).mockReturnValue(mockProvider)
    vi.mocked(getInstalledVersion).mockResolvedValue('0.5.0')

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s) => logs.push(String(s)))

    await runUpgrade({ component: 'pai', provider: 'registry' })

    expect(logs.some(l => l.includes('already at'))).toBe(true)
    vi.restoreAllMocks()
  })

  it('calls installComponent when upgrade is needed', async () => {
    const { getProvider } = await import('../../src/components.js')
    const { getInstalledVersion, installComponent } = await import('../../src/component-manager.js')
    vi.mocked(getProvider).mockReturnValue(mockProvider)
    vi.mocked(getInstalledVersion).mockResolvedValue('0.4.0')

    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runUpgrade({ component: 'pai', provider: 'registry' })

    expect(vi.mocked(installComponent)).toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
