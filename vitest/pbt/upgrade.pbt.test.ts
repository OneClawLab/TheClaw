import { describe, test, vi, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { installComponent } from '../../src/component-manager.js'
import { filterComponents } from '../../src/commands/upgrade.js'
import type { ComponentDef, ComponentProvider } from '../../src/types.js'

// Mock repo-utils/os.js to track shell command calls
vi.mock('../../src/repo-utils/os.js', () => ({
  commandExists: vi.fn().mockResolvedValue(false),
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execShell: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  spawnCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

import { execShell } from '../../src/repo-utils/os.js'

// Arbitrary for component names
const componentNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/)

const componentDefArb = fc.record({
  version: fc
    .tuple(
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 0, max: 99 }),
    )
    .map(([a, b, c]) => `${a}.${b}.${c}`),
  command: fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/),
})

// Arbitrary for a ComponentProvider with random components
const componentProviderArb = fc
  .uniqueArray(componentNameArb, { minLength: 1, maxLength: 10 })
  .chain((names) =>
    fc
      .tuple(...names.map(() => componentDefArb))
      .map((defs): ComponentProvider => {
        const components: Record<string, ComponentDef> = {}
        names.forEach((name, i) => { components[name] = defs[i]! })
        return {
          name: 'registry',
          components,
          needsAction: (current, target) => current !== target,
          install: vi.fn().mockResolvedValue(undefined),
        }
      }),
  )

describe('upgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Feature: theclaw-cli, Property 6: dry-run 无副作用
  // Validates: Requirements 5.4
  test('Property 6: installComponent with dryRun=true never calls execShell', async () => {
    await fc.assert(
      fc.asyncProperty(componentNameArb, componentDefArb, async (name, def) => {
        vi.clearAllMocks()
        const mockProvider: ComponentProvider = {
          name: 'registry',
          components: { [name]: def },
          needsAction: () => true,
          install: vi.fn().mockResolvedValue(undefined),
        }
        await installComponent(name, def, mockProvider, true)
        // execShell should NOT have been called
        return (execShell as ReturnType<typeof vi.fn>).mock.calls.length === 0
      }),
      { numRuns: 100 },
    )
  })

  // Feature: theclaw-cli, Property 11: --component 过滤正确性
  // Validates: Requirements 5.3
  test('Property 11: filterComponents with a name returns exactly the matching component', () => {
    fc.assert(
      fc.property(
        componentProviderArb.chain((provider) => {
          const names = Object.keys(provider.components)
          return fc.record({
            provider: fc.constant(provider),
            targetName: fc.constantFrom(...names),
          })
        }),
        ({ provider, targetName }) => {
          const result = filterComponents(provider, targetName)
          if (result.length !== 1) return false
          if (result[0]!.name !== targetName) return false
          return true
        },
      ),
      { numRuns: 100 },
    )
  })

  test('Property 11: filterComponents without a name returns all components', () => {
    fc.assert(
      fc.property(componentProviderArb, (provider) => {
        const result = filterComponents(provider)
        const expectedNames = Object.keys(provider.components).sort()
        const resultNames = result.map((e) => e.name).sort()
        return JSON.stringify(expectedNames) === JSON.stringify(resultNames)
      }),
      { numRuns: 100 },
    )
  })

  test('Property 11: filterComponents with non-existent name throws CliError with exit code 2', () => {
    fc.assert(
      fc.property(
        componentProviderArb,
        fc.stringMatching(/^z[a-z0-9]{5,10}$/),
        (provider, nonExistentName) => {
          if (nonExistentName in provider.components) return true
          try {
            filterComponents(provider, nonExistentName)
            return false
          } catch (err: unknown) {
            if (err instanceof Error && 'exitCode' in err) {
              return (err as { exitCode: number }).exitCode === 2
            }
            return false
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
