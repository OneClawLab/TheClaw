import { describe, test, vi, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { installComponent } from '../../src/component-manager.js'
import { filterComponents } from '../../src/commands/upgrade.js'
import type { ComponentDef, ComponentsConfig } from '../../src/types.js'

// Mock os-utils to track shell command calls
vi.mock('../../src/os-utils.js', () => ({
  commandExists: vi.fn().mockResolvedValue(false),
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execShell: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  spawnCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

import { execShell } from '../../src/os-utils.js'

// Realistic install command: e.g. "npm install -g foo", "brew install foo"
const installArb = fc.oneof(
  fc.stringMatching(/^npm install -g [a-z][a-z0-9-]{0,19}$/),
  fc.stringMatching(/^brew install [a-z][a-z0-9-]{0,19}$/),
  fc.stringMatching(/^pip install [a-z][a-z0-9-]{0,19}$/),
  fc.stringMatching(/^apt-get install -y [a-z][a-z0-9-]{0,19}$/),
)

const componentDefArb = fc.record({
  version: fc
    .tuple(
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 0, max: 99 }),
    )
    .map(([a, b, c]) => `${a}.${b}.${c}`),
  command: fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/),
  install: installArb,
})

// Arbitrary for a record of component names to ComponentDef
const componentNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/)

const componentsConfigArb = fc
  .uniqueArray(componentNameArb, { minLength: 1, maxLength: 10 })
  .chain((names) =>
    fc
      .tuple(...names.map(() => componentDefArb))
      .map((defs) => {
        const components: Record<string, ComponentDef> = {}
        names.forEach((name, i) => {
          components[name] = defs[i]
        })
        return { schema_version: '1', components } as ComponentsConfig
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
      fc.asyncProperty(componentDefArb, async (component) => {
        vi.clearAllMocks()
        await installComponent(component, true)
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
        componentsConfigArb.chain((config) => {
          const names = Object.keys(config.components)
          return fc.record({
            config: fc.constant(config),
            targetName: fc.constantFrom(...names),
          })
        }),
        ({ config, targetName }) => {
          const result = filterComponents(config, targetName)
          // Has exactly 1 entry
          if (result.length !== 1) return false
          // That entry matches the target name
          if (result[0].name !== targetName) return false
          return true
        },
      ),
      { numRuns: 100 },
    )
  })

  test('Property 11: filterComponents without a name returns all components', () => {
    fc.assert(
      fc.property(componentsConfigArb, (config) => {
        const result = filterComponents(config)
        const expectedNames = Object.keys(config.components).sort()
        const resultNames = result.map((e) => e.name).sort()
        return JSON.stringify(expectedNames) === JSON.stringify(resultNames)
      }),
      { numRuns: 100 },
    )
  })

  test('Property 11: filterComponents with non-existent name throws CliError with exit code 2', () => {
    fc.assert(
      fc.property(
        componentsConfigArb,
        // Generate a name guaranteed not to be in the config
        fc.stringMatching(/^z[a-z0-9]{5,10}$/),
        (config, nonExistentName) => {
          // Skip if the generated name happens to exist
          if (nonExistentName in config.components) return true
          try {
            filterComponents(config, nonExistentName)
            return false // Should have thrown
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
