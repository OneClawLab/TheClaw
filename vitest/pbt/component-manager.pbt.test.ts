import { describe, test, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { extractVersion } from '../../src/component-manager.js'

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
  // Feature: theclaw-cli, Property 5: 版本号提取鲁棒性
  // Validates: Requirements 1.5
  test('Property 5: extractVersion correctly extracts semver from various output formats', () => {
    fc.assert(
      fc.property(
        semverCoreArb,
        fc.boolean(), // whether to add 'v' prefix
        fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes('\n') && !/[\d.]$/.test(s)), // prefix text (must not end with digit or dot)
        fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes('\n') && !/^[\d.]/.test(s)), // suffix text (must not start with digit or dot)
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
})
