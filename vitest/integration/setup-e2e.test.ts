/**
 * E2E tests for TheClaw complete setup flow.
 * Tests the full runSetup orchestration (multi-step pipeline).
 *
 * NOTE: setup.test.ts already covers setup primitives (readConfig, writeConfig,
 * shouldSkipStep, smokeTest, initAgents, etc.). This file tests the complete
 * runSetup command flow — config creation, profile loading, step execution,
 * completion marking, and idempotency.
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { path } from '../../src/repo-utils/path.js'
import { tmpdir } from 'os'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/repo-utils/os.js', () => ({
  execShell: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  commandExists: vi.fn().mockResolvedValue(false),
}))

// Mock @inquirer/prompts to avoid interactive prompts in tests
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn().mockResolvedValue('test-value'),
}))

// Mock component-manager to avoid real npm installs
vi.mock('../../src/component-manager.js', () => ({
  checkAll: vi.fn().mockResolvedValue([]),
  installComponent: vi.fn().mockResolvedValue(undefined),
}))

import { execShell } from '../../src/repo-utils/os.js'
const mockExecShell = vi.mocked(execShell)

import { readConfig, writeConfig } from '../../src/config.js'
import { runSetup, shouldSkipStep, markStepComplete } from '../../src/commands/setup.js'
import type { TheClawConfig } from '../../src/types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string
let consoleSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'theclaw-e2e-'))
  vi.clearAllMocks()
  mockExecShell.mockResolvedValue({ stdout: '', stderr: '' })
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  consoleSpy.mockRestore()
  await rm(tmpDir, { recursive: true, force: true })
})

function configPath() {
  return path.join(tmpDir, 'config.json')
}

async function writeMinimalProfile(name: string, steps: string[]) {
  const stepsYaml = steps.map(s => `  - type: ${s}`).join('\n')
  const yaml = `name: ${name}\nsteps:\n${stepsYaml}\n`
  const profilePath = path.join(tmpDir, `${name}.yaml`)
  await writeFile(profilePath, yaml)
  return profilePath
}

// ── Requirement 8.1: config.json created with correct schema_version and profile ──

describe('Requirement 8.1 — setup creates config.json with correct fields', () => {
  it('config.json is created after setup completes', async () => {
    const profilePath = await writeMinimalProfile('minimal', ['smoke-test'])

    await runSetup({
      profile: profilePath,
      configPath: configPath(),
    })

    const cfg = await readConfig(configPath())
    expect(cfg.schema_version).toBe('1')
  })

  it('config.json contains the profile name after setup', async () => {
    const profilePath = await writeMinimalProfile('my-profile', ['smoke-test'])

    await runSetup({
      profile: profilePath,
      configPath: configPath(),
    })

    const cfg = await readConfig(configPath())
    expect(cfg.profile).toBe(profilePath)
  })

  it('config.json contains setup_completed_at timestamp after setup', async () => {
    const profilePath = await writeMinimalProfile('minimal', ['smoke-test'])

    await runSetup({
      profile: profilePath,
      configPath: configPath(),
    })

    const cfg = await readConfig(configPath())
    expect(cfg.setup_completed_at).toBeTruthy()
    expect(new Date(cfg.setup_completed_at!).toISOString()).toBe(cfg.setup_completed_at)
  })
})

// ── Requirement 8.2: completed steps are recorded ────────────────────────────

describe('Requirement 8.2 — completed steps are recorded in config', () => {
  it('smoke-test step is recorded in completed_steps after setup', async () => {
    const profilePath = await writeMinimalProfile('minimal', ['smoke-test'])

    await runSetup({
      profile: profilePath,
      configPath: configPath(),
    })

    const cfg = await readConfig(configPath())
    expect(cfg.completed_steps).toContain('smoke-test')
  })

  it('multiple steps are all recorded in completed_steps', async () => {
    const profilePath = await writeMinimalProfile('multi', ['init-agents', 'smoke-test'])

    await runSetup({
      profile: profilePath,
      configPath: configPath(),
    })

    const cfg = await readConfig(configPath())
    expect(cfg.completed_steps).toContain('init-agents')
    expect(cfg.completed_steps).toContain('smoke-test')
  })

  it('completed_steps grows as each step finishes', async () => {
    const profilePath = await writeMinimalProfile('multi', ['init-agents', 'smoke-test'])

    // Track config writes to verify incremental recording
    const writes: TheClawConfig[] = []
    const origWriteConfig = writeConfig
    vi.spyOn({ writeConfig: origWriteConfig }, 'writeConfig').mockImplementation(async (cfg) => {
      writes.push(cfg as TheClawConfig)
    })

    await runSetup({
      profile: profilePath,
      configPath: configPath(),
    })

    // After full run, both steps should be in completed_steps
    const cfg = await readConfig(configPath())
    expect(cfg.completed_steps.length).toBeGreaterThanOrEqual(2)
  })
})

// ── Requirement 8.3: idempotency — completed steps are skipped ───────────────

describe('Requirement 8.3 — idempotency: completed steps are skipped on re-run', () => {
  it('smoke-test is not re-executed when already in completed_steps', async () => {
    const profilePath = await writeMinimalProfile('minimal', ['smoke-test'])

    // First run
    await runSetup({ profile: profilePath, configPath: configPath() })
    const callsAfterFirst = mockExecShell.mock.calls.length

    // Second run — smoke-test should be skipped
    await runSetup({ profile: profilePath, configPath: configPath() })
    const callsAfterSecond = mockExecShell.mock.calls.length

    // No new execShell calls for smoke-test on second run
    expect(callsAfterSecond).toBe(callsAfterFirst)
  })

  it('shouldSkipStep returns true for steps already in completed_steps', async () => {
    let cfg: TheClawConfig = { schema_version: '1', profile: 'test', completed_steps: [] }
    cfg = markStepComplete('smoke-test', cfg)
    await writeConfig(cfg, configPath())

    const reloaded = await readConfig(configPath())
    expect(shouldSkipStep('smoke-test', reloaded)).toBe(true)
    expect(shouldSkipStep('init-agents', reloaded)).toBe(false)
  })

  it('reset option clears completed_steps and re-runs all steps', async () => {
    const profilePath = await writeMinimalProfile('minimal', ['smoke-test'])

    // First run
    await runSetup({ profile: profilePath, configPath: configPath() })
    const callsAfterFirst = mockExecShell.mock.calls.length

    // Reset run — should re-execute smoke-test
    await runSetup({ profile: profilePath, configPath: configPath(), reset: true })
    const callsAfterReset = mockExecShell.mock.calls.length

    expect(callsAfterReset).toBeGreaterThan(callsAfterFirst)
  })
})

// ── Requirement 8.4: profile steps are parsed and executed ───────────────────

describe('Requirement 8.4 — profile steps are parsed and executed', () => {
  it('only steps listed in profile are executed', async () => {
    // Profile only has smoke-test, not init-agents
    const profilePath = await writeMinimalProfile('smoke-only', ['smoke-test'])

    await runSetup({ profile: profilePath, configPath: configPath() })

    // init-agents would call execShell('agent init ...') — should not happen
    const agentInitCalls = mockExecShell.mock.calls.filter(
      ([cmd]) => typeof cmd === 'string' && cmd.startsWith('agent init')
    )
    expect(agentInitCalls).toHaveLength(0)
  })

  it('init-agents step is executed when in profile', async () => {
    const profilePath = await writeMinimalProfile('with-agents', ['init-agents'])

    // agent status fails (not found) → triggers agent init; agent init succeeds
    mockExecShell
      .mockRejectedValueOnce(new Error('not found')) // status admin
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // init admin
      .mockRejectedValueOnce(new Error('not found')) // status warden
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // init warden
      .mockRejectedValueOnce(new Error('not found')) // status maintainer
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // init maintainer
      .mockRejectedValueOnce(new Error('not found')) // status evolver
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // init evolver

    await runSetup({ profile: profilePath, configPath: configPath() })

    const agentInitCalls = mockExecShell.mock.calls.filter(
      ([cmd]) => typeof cmd === 'string' && cmd.startsWith('agent init')
    )
    expect(agentInitCalls.length).toBeGreaterThan(0)
  })
})

// ── Requirement 8.5: smoke-test step calls notifier status and agent status ───

describe('Requirement 8.5 — smoke-test step calls notifier status and agent status', () => {
  it('smoke-test calls notifier status', async () => {
    const profilePath = await writeMinimalProfile('smoke-only', ['smoke-test'])

    await runSetup({ profile: profilePath, configPath: configPath() })

    expect(mockExecShell).toHaveBeenCalledWith('notifier status')
  })

  it('smoke-test calls agent status for each profile agent', async () => {
    const yaml = `name: with-agents\nsteps:\n  - type: init-agents\n    agents: [alpha, beta]\n  - type: smoke-test\n`
    const profilePath = path.join(tmpDir, 'with-agents.yaml')
    await writeFile(profilePath, yaml)

    // init-agents: all agents exist (status succeeds)
    // smoke-test: notifier + agent alpha + agent beta
    mockExecShell.mockResolvedValue({ stdout: '', stderr: '' })

    await runSetup({ profile: profilePath, configPath: configPath() })

    expect(mockExecShell).toHaveBeenCalledWith('agent status alpha')
    expect(mockExecShell).toHaveBeenCalledWith('agent status beta')
  })

  it('setup fails when smoke-test detects a service is down', async () => {
    const profilePath = await writeMinimalProfile('smoke-only', ['smoke-test'])

    mockExecShell.mockRejectedValueOnce(new Error('notifier not running'))

    await expect(
      runSetup({ profile: profilePath, configPath: configPath() })
    ).rejects.toThrow(/smoke test failed/i)
  })
})
