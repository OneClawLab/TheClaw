import { describe, test, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import yaml from 'js-yaml'
import { loadComponents, extractVersion } from '../../src/component-manager.js'
import type { ComponentsConfig } from '../../src/types.js'

// Arbitrary for valid component names (lowercase alphanumeric + hyphens)
const componentNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/)

// Arbitrary for semver strings
const semverArb = fc
  .tuple(
    fc.integer({ min: 0, max: 9 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
  )
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`)

// Arbitrary for command names
const commandArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/)

// Realistic install command: e.g. "npm install -g foo", "brew install foo", "curl -fsSL https://example.com | sh"
const installArb = fc.oneof(
  fc.stringMatching(/^npm install -g [a-z][a-z0-9-]{0,19}$/),
  fc.stringMatching(/^brew install [a-z][a-z0-9-]{0,19}$/),
  fc.stringMatching(/^pip install [a-z][a-z0-9-]{0,19}$/),
  fc.stringMatching(/^apt-get install -y [a-z][a-z0-9-]{0,19}$/),
)

const componentDefArb = fc.record({
  version: semverArb,
  command: commandArb,
  install: installArb,
})

const componentsConfigArb: fc.Arbitrary<ComponentsConfig> = fc.record({
  schema_version: fc.constantFrom('1'),
  components: fc.dictionary(componentNameArb, componentDefArb, { minKeys: 1, maxKeys: 5 }),
})

// Arbitrary for semver strings without 'v' prefix (x.y.z)
const semverCoreArb = fc
  .tuple(
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
  )
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`)

// Arbitrary for strings that definitely do NOT contain semver (no digit.digit.digit pattern)
const noSemverArb = fc
  .string({ minLength: 0, maxLength: 50 })
  .filter((s) => !/\d+\.\d+\.\d+/.test(s))

describe('component-manager', () => {
  let tmpDir: string
  let fileIdx = 0

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'theclaw-cm-'))
    fileIdx = 0
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  // Feature: theclaw-cli, Property 5: 版本号提取鲁棒性
  // Validates: Requirements 1.5
  test('Property 5: extractVersion correctly extracts semver from various output formats', () => {
    fc.assert(
      fc.property(
        semverCoreArb,
        fc.boolean(), // whether to add 'v' prefix
        fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes('\n') && !/\d$/.test(s)), // prefix text (must not end with digit)
        fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes('\n') && !/^\d/.test(s)), // suffix text (must not start with digit)
        fc.array(fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes('\n')), { minLength: 0, maxLength: 3 }), // extra lines
        (semver, addV, prefix, suffix, extraLines) => {
          const versionStr = addV ? `v${semver}` : semver
          const versionLine = `${prefix}${versionStr}${suffix}`
          const allLines = [...extraLines, versionLine]
          const output = allLines.join('\n')

          const result = extractVersion(output)
          return result === semver
        },
      ),
      { numRuns: 100 },
    )
  })

  test('Property 5: extractVersion returns null for strings without semver', () => {
    fc.assert(
      fc.property(noSemverArb, (input) => {
        return extractVersion(input) === null
      }),
      { numRuns: 100 },
    )
  })

  // Feature: theclaw-cli, Property 12: 非法 YAML 输入错误处理
  // Validates: Requirements 1.3, 3.6
  test('Property 12: loadComponents throws descriptive error for objects missing top-level required fields', async () => {
    // Generate objects missing schema_version, components, or both
    const missingTopLevelArb = fc.oneof(
      // Missing schema_version
      fc.record({ components: fc.dictionary(componentNameArb, componentDefArb, { minKeys: 1, maxKeys: 3 }) }),
      // Missing components
      fc.record({ schema_version: fc.constantFrom('1') }),
      // Missing both (arbitrary object with other keys)
      fc.record({ foo: fc.string(), bar: fc.integer() }),
      // Empty object
      fc.constant({}),
    )

    await fc.assert(
      fc.asyncProperty(missingTopLevelArb, async (invalidConfig) => {
        const tmpPath = join(tmpDir, `invalid-${fileIdx++}.yaml`)
        await writeFile(tmpPath, yaml.dump(invalidConfig), 'utf-8')

        try {
          await loadComponents(tmpPath)
          return false // should have thrown
        } catch (err: unknown) {
          const message = (err as Error).message
          return message.length > 0
        }
      }),
      { numRuns: 100 },
    )
  })

  test('Property 12: loadComponents throws descriptive error for components missing required fields', async () => {
    // Generate configs where at least one component is missing version, command, or install
    const missingComponentFieldArb = fc.record({
      schema_version: fc.constantFrom('1'),
      components: fc.dictionary(
        componentNameArb,
        fc.oneof(
          // Missing version
          fc.record({ command: commandArb, install: installArb }),
          // Missing command
          fc.record({ version: semverArb, install: installArb }),
          // Missing install
          fc.record({ version: semverArb, command: commandArb }),
        ) as fc.Arbitrary<Record<string, unknown>>,
        { minKeys: 1, maxKeys: 3 },
      ),
    })

    await fc.assert(
      fc.asyncProperty(missingComponentFieldArb, async (invalidConfig) => {
        const tmpPath = join(tmpDir, `invalid-comp-${fileIdx++}.yaml`)
        await writeFile(tmpPath, yaml.dump(invalidConfig), 'utf-8')

        try {
          await loadComponents(tmpPath)
          return false // should have thrown
        } catch (err: unknown) {
          const message = (err as Error).message
          return message.length > 0
        }
      }),
      { numRuns: 100 },
    )
  })

  // Feature: theclaw-cli, Property 1: ComponentsYaml 解析往返一致性
  // Validates: Requirements 1.1, 1.2
  test('Property 1: loadComponents roundtrip preserves all component definitions', async () => {
    await fc.assert(
      fc.asyncProperty(componentsConfigArb, async (config) => {
        const tmpPath = join(tmpDir, `components-${fileIdx++}.yaml`)
        await writeFile(tmpPath, yaml.dump(config), 'utf-8')

        const result = await loadComponents(tmpPath)

        // Verify schema_version preserved
        if (result.schema_version !== config.schema_version) return false

        // Verify all component names preserved
        const origNames = Object.keys(config.components).sort()
        const resultNames = Object.keys(result.components).sort()
        if (JSON.stringify(origNames) !== JSON.stringify(resultNames)) return false

        // Verify each component's fields preserved
        for (const name of origNames) {
          const orig = config.components[name]!
          const res = result.components[name]!
          if (orig.version !== res.version) return false
          if (orig.command !== res.command) return false
          if (orig.install !== res.install) return false
        }

        return true
      }),
      { numRuns: 100 },
    )
  })
})
