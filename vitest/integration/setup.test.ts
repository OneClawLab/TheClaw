/**
 * Integration tests for TheClaw setup primitives.
 * Uses real file I/O (tmpdir) for config read/write and profile loading.
 * Mocks only external shell commands (execShell/execCommand).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { path } from '../../src/repo-utils/path.js'
import { tmpdir } from 'os'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/repo-utils/os.js', () => ({
  execShell: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  commandExists: vi.fn().mockResolvedValue(false),
}))

import { execShell, commandExists } from '../../src/repo-utils/os.js'
const mockExecShell = vi.mocked(execShell)
const mockCommandExists = vi.mocked(commandExists)

// ── Imports under test ────────────────────────────────────────────────────────

import { readConfig, writeConfig } from '../../src/config.js'
import {
  loadProfile,
  extractPlaceholders,
  fillPlaceholders,
  CliError,
} from '../../src/profile-loader.js'
import {
  shouldSkipStep,
  markStepComplete,
  smokeTest,
  initAgents,
} from '../../src/commands/setup.js'
import type { TheClawConfig } from '../../src/types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'theclaw-integration-'))
  vi.clearAllMocks()
  mockExecShell.mockResolvedValue({ stdout: '', stderr: '' })
  mockCommandExists.mockResolvedValue(false)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function configPath() {
  return path.join(tmpDir, 'config.json')
}

function profilePath(name: string) {
  return path.join(tmpDir, `${name}.yaml`)
}

// ── readConfig / writeConfig: real file I/O ───────────────────────────────────

describe('readConfig / writeConfig: real file I/O', () => {
  it('returns default config when file does not exist', async () => {
    const cfg = await readConfig(path.join(tmpDir, 'nonexistent.json'))
    expect(cfg.schema_version).toBe('1')
    expect(cfg.profile).toBe('standard')
    expect(cfg.completed_steps).toEqual([])
  })

  it('round-trips config through write then read', async () => {
    const cfg: TheClawConfig = {
      schema_version: '1',
      profile: 'minimal',
      completed_steps: ['install-components', 'load-profile'],
      setup_completed_at: '2026-01-01T00:00:00.000Z',
    }
    await writeConfig(cfg, configPath())
    const loaded = await readConfig(configPath())
    expect(loaded).toEqual(cfg)
  })

  it('creates parent directories when writing config', async () => {
    const nested = path.join(tmpDir, 'deep', 'nested', 'config.json')
    const cfg: TheClawConfig = { schema_version: '1', profile: 'standard', completed_steps: [] }
    await writeConfig(cfg, nested)
    expect(existsSync(nested)).toBe(true)
  })

  it('persists completed_steps across write/read cycle', async () => {
    let cfg = await readConfig(configPath())
    cfg = markStepComplete('install-components', cfg)
    cfg = markStepComplete('load-profile', cfg)
    await writeConfig(cfg, configPath())

    const reloaded = await readConfig(configPath())
    expect(reloaded.completed_steps).toContain('install-components')
    expect(reloaded.completed_steps).toContain('load-profile')
  })

  it('overwrites existing config on write', async () => {
    const cfg1: TheClawConfig = { schema_version: '1', profile: 'standard', completed_steps: ['step-a'] }
    await writeConfig(cfg1, configPath())

    const cfg2: TheClawConfig = { schema_version: '1', profile: 'minimal', completed_steps: [] }
    await writeConfig(cfg2, configPath())

    const loaded = await readConfig(configPath())
    expect(loaded.profile).toBe('minimal')
    expect(loaded.completed_steps).toEqual([])
  })
})

// ── loadProfile: real YAML parsing ───────────────────────────────────────────

describe('loadProfile: real YAML parsing', () => {
  it('loads a valid profile from a .yaml file', async () => {
    const yaml = `
name: test-profile
steps:
  - type: install-components
  - type: init-agents
    agents: [alpha, beta]
`
    await writeFile(profilePath('test'), yaml)
    const profile = await loadProfile(profilePath('test'), tmpDir)
    expect(profile.name).toBe('test-profile')
    expect(profile.steps).toHaveLength(2)
    expect(profile.steps[0]?.type).toBe('install-components')
  })

  it('throws CliError(exitCode=2) when profile file not found', async () => {
    await expect(loadProfile('nonexistent', tmpDir)).rejects.toThrow(CliError)
    await expect(loadProfile('nonexistent', tmpDir)).rejects.toMatchObject({ exitCode: 2 })
  })

  it('throws CliError(exitCode=1) on invalid YAML', async () => {
    await writeFile(profilePath('bad'), '{ invalid: yaml: [}')
    await expect(loadProfile(profilePath('bad'), tmpDir)).rejects.toThrow(CliError)
    await expect(loadProfile(profilePath('bad'), tmpDir)).rejects.toMatchObject({ exitCode: 1 })
  })

  it('throws CliError(exitCode=1) when profile missing name or steps', async () => {
    await writeFile(profilePath('incomplete'), 'just_a_key: value\n')
    await expect(loadProfile(profilePath('incomplete'), tmpDir)).rejects.toThrow(CliError)
    await expect(loadProfile(profilePath('incomplete'), tmpDir)).rejects.toMatchObject({ exitCode: 1 })
  })

  it('loads profile by absolute path (not just name)', async () => {
    const absPath = path.join(tmpDir, 'my-profile.yaml')
    await writeFile(absPath, 'name: abs\nsteps:\n  - type: smoke-test\n')
    const profile = await loadProfile(absPath, '/nonexistent-dir')
    expect(profile.name).toBe('abs')
  })

  it('extracts agents list from init-agents step', async () => {
    const yaml = `
name: with-agents
steps:
  - type: init-agents
    agents: [admin, warden, maintainer]
`
    await writeFile(profilePath('with-agents'), yaml)
    const profile = await loadProfile(profilePath('with-agents'), tmpDir)
    const initStep = profile.steps.find(s => s.type === 'init-agents')
    expect(initStep?.['agents']).toEqual(['admin', 'warden', 'maintainer'])
  })
})

// ── extractPlaceholders / fillPlaceholders: pure functions ───────────────────

describe('extractPlaceholders', () => {
  it('extracts unique placeholder names', () => {
    const result = extractPlaceholders('Hello ${NAME}, your key is ${API_KEY} and ${NAME} again')
    expect(result).toEqual(['NAME', 'API_KEY'])
  })

  it('returns empty array when no placeholders', () => {
    expect(extractPlaceholders('no placeholders here')).toEqual([])
  })

  it('only matches uppercase with underscores', () => {
    const result = extractPlaceholders('${VALID} ${invalid} ${ALSO_VALID}')
    expect(result).toContain('VALID')
    expect(result).toContain('ALSO_VALID')
    expect(result).not.toContain('invalid')
  })
})

describe('fillPlaceholders', () => {
  it('replaces known placeholders with values', () => {
    const result = fillPlaceholders('Hello ${NAME}!', { NAME: 'World' })
    expect(result).toBe('Hello World!')
  })

  it('leaves unknown placeholders intact', () => {
    const result = fillPlaceholders('${KNOWN} and ${UNKNOWN}', { KNOWN: 'yes' })
    expect(result).toBe('yes and ${UNKNOWN}')
  })

  it('replaces multiple occurrences', () => {
    const result = fillPlaceholders('${X} + ${X} = two', { X: '1' })
    expect(result).toBe('1 + 1 = two')
  })
})

// ── shouldSkipStep / markStepComplete: with real config persistence ───────────

describe('shouldSkipStep / markStepComplete: with real config persistence', () => {
  it('shouldSkipStep returns false for fresh config', async () => {
    const cfg = await readConfig(configPath())
    expect(shouldSkipStep('install-components', cfg)).toBe(false)
  })

  it('shouldSkipStep returns true after step is written and reloaded', async () => {
    let cfg = await readConfig(configPath())
    cfg = markStepComplete('install-components', cfg)
    await writeConfig(cfg, configPath())

    const reloaded = await readConfig(configPath())
    expect(shouldSkipStep('install-components', reloaded)).toBe(true)
  })

  it('markStepComplete is idempotent across multiple writes', async () => {
    let cfg = await readConfig(configPath())
    cfg = markStepComplete('load-profile', cfg)
    cfg = markStepComplete('load-profile', cfg)
    await writeConfig(cfg, configPath())

    const reloaded = await readConfig(configPath())
    const count = (reloaded.completed_steps ?? []).filter(s => s === 'load-profile').length
    expect(count).toBe(1)
  })

  it('accumulates multiple steps correctly', async () => {
    let cfg = await readConfig(configPath())
    for (const step of ['install-components', 'load-profile', 'configure-pai']) {
      cfg = markStepComplete(step, cfg)
    }
    await writeConfig(cfg, configPath())

    const reloaded = await readConfig(configPath())
    expect(reloaded.completed_steps).toHaveLength(3)
    expect(shouldSkipStep('install-components', reloaded)).toBe(true)
    expect(shouldSkipStep('configure-pai', reloaded)).toBe(true)
    expect(shouldSkipStep('init-agents', reloaded)).toBe(false)
  })
})

// ── smokeTest: verifies execShell calls ──────────────────────────────────────

describe('smokeTest', () => {
  it('calls notifier status check', async () => {
    await smokeTest({})
    expect(mockExecShell).toHaveBeenCalledWith('notifier status')
  })

  it('calls agent status for each profile agent', async () => {
    await smokeTest({ profileAgents: ['alpha', 'beta'] })
    expect(mockExecShell).toHaveBeenCalledWith('agent status alpha')
    expect(mockExecShell).toHaveBeenCalledWith('agent status beta')
  })

  it('throws when a smoke test check fails', async () => {
    mockExecShell.mockRejectedValueOnce(new Error('notifier not running'))
    await expect(smokeTest({})).rejects.toThrow(/smoke test failed/i)
  })

  it('includes failing service name in error message', async () => {
    mockExecShell.mockResolvedValueOnce({ stdout: '', stderr: '' }) // notifier ok
    mockExecShell.mockRejectedValueOnce(new Error('not running'))   // agent alpha fails
    await expect(smokeTest({ profileAgents: ['alpha'] })).rejects.toThrow(/alpha/)
  })
})

// ── initAgents: verifies execShell calls ─────────────────────────────────────

describe('initAgents', () => {
  it('initializes default agents when no profileAgents set', async () => {
    // agent status throws for each agent → triggers agent init for each
    // Use mockRejectedValueOnce per status call, then resolve for init calls
    mockExecShell
      .mockRejectedValueOnce(new Error('not found')) // status admin
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // init admin
      .mockRejectedValueOnce(new Error('not found')) // status warden
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // init warden
      .mockRejectedValueOnce(new Error('not found')) // status maintainer
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // init maintainer
      .mockRejectedValueOnce(new Error('not found')) // status evolver
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // init evolver
    await initAgents({})
    const initCalls = mockExecShell.mock.calls.filter(([cmd]) => (cmd as string).startsWith('agent init'))
    expect(initCalls.length).toBeGreaterThan(0)
  })

  it('skips agents that already exist (status succeeds)', async () => {
    mockExecShell.mockResolvedValue({ stdout: '', stderr: '' }) // all agents exist
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await initAgents({ profileAgents: ['alpha', 'beta'] })
    const initCalls = mockExecShell.mock.calls.filter(([cmd]) => (cmd as string).startsWith('agent init'))
    expect(initCalls).toHaveLength(0)
    consoleSpy.mockRestore()
  })

  it('initializes only missing agents', async () => {
    // alpha exists, beta does not
    mockExecShell
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // agent status alpha → ok
      .mockRejectedValueOnce(new Error('not found'))     // agent status beta → fail
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // agent init beta → ok

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await initAgents({ profileAgents: ['alpha', 'beta'] })

    const initCalls = mockExecShell.mock.calls.filter(([cmd]) => (cmd as string).startsWith('agent init'))
    expect(initCalls).toHaveLength(1)
    expect(initCalls[0]![0]).toBe('agent init beta')
    consoleSpy.mockRestore()
  })
})
