import { describe, test } from 'vitest'
import fc from 'fast-check'
import { extractPlaceholders, fillPlaceholders } from '../../src/profile-loader.js'

// Arbitrary for valid placeholder names: [A-Z_][A-Z0-9_]*
const placeholderNameArb = fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,19}$/)

describe('profile-loader', () => {
  // Feature: theclaw-cli, Property 2: 占位符提取完整性与唯一性
  // Validates: Requirements 3.2, 3.3
  test('Property 2: extractPlaceholders returns complete and unique results', () => {
    fc.assert(
      fc.property(
        fc.array(placeholderNameArb, { minLength: 0, maxLength: 10 }),
        fc.string({ maxLength: 20 }),
        (names, noise) => {
          // Build a string with the placeholders (possibly repeated)
          const placeholderParts = names.map(n => `\${${n}}`)
          // Add some duplicates
          const allParts = [...placeholderParts, ...placeholderParts.slice(0, 2), noise]
          const content = allParts.join(' ')

          const result = extractPlaceholders(content)

          // Uniqueness: no duplicates
          const resultSet = new Set(result)
          if (result.length !== resultSet.size) return false

          // Completeness: every name in result appears in content
          for (const name of result) {
            if (!content.includes(`\${${name}}`)) return false
          }

          // Coverage: every placeholder in content appears in result
          const nameSet = new Set(names)
          for (const name of nameSet) {
            if (content.includes(`\${${name}}`) && !resultSet.has(name)) return false
          }

          return true
        }
      ),
      { numRuns: 100 }
    )
  })

  // Feature: theclaw-cli, Property 3: 占位符填充完整性
  // Validates: Requirements 3.4
  test('Property 3: fillPlaceholders leaves no unreplaced placeholders when all values provided', () => {
    // Values must not contain ${VAR} patterns to avoid introducing new placeholders
    const safeValueArb = fc.stringMatching(/^[a-zA-Z0-9_\-\.]{1,20}$/)

    fc.assert(
      fc.property(
        fc.array(placeholderNameArb, { minLength: 0, maxLength: 8 }),
        fc.string({ maxLength: 30 }),
        (names, noise) => {
          // Build a template with the placeholders
          const placeholderParts = names.map(n => `\${${n}}`)
          const template = [...placeholderParts, noise].join(' ')

          // Build a complete values map covering all placeholders
          const uniqueNames = [...new Set(names)]
          const values: Record<string, string> = {}
          for (const name of uniqueNames) {
            // Use a simple alphanumeric value that won't introduce new placeholders
            values[name] = `val_${name.toLowerCase().slice(0, 5)}`
          }

          const result = fillPlaceholders(template, values)

          // After filling, no ${VAR} patterns should remain
          return !/\$\{[A-Z_][A-Z0-9_]*\}/.test(result)
        }
      ),
      { numRuns: 100 }
    )
  })

  // Feature: theclaw-cli, Property 4: 占位符填充幂等性
  // Validates: Requirements 3.4
  test('Property 4: fillPlaceholders is idempotent - fill(fill(template, values), values) === fill(template, values)', () => {
    const safeValueArb = fc.stringMatching(/^[a-zA-Z0-9_\-\.]{1,20}$/)

    fc.assert(
      fc.property(
        fc.array(placeholderNameArb, { minLength: 0, maxLength: 8 }),
        fc.string({ maxLength: 30 }),
        fc.array(safeValueArb, { minLength: 0, maxLength: 8 }),
        (names, noise, rawValues) => {
          // Build a template with the placeholders
          const placeholderParts = names.map(n => `\${${n}}`)
          const template = [...placeholderParts, noise].join(' ')

          // Build a values map (may not cover all placeholders - that's fine for idempotency)
          const uniqueNames = [...new Set(names)]
          const values: Record<string, string> = {}
          for (let i = 0; i < uniqueNames.length; i++) {
            const v = rawValues[i] ?? `val${i}`
            values[uniqueNames[i]!] = v
          }

          const firstFill = fillPlaceholders(template, values)
          const secondFill = fillPlaceholders(firstFill, values)

          // Second fill must equal first fill
          return firstFill === secondFill
        }
      ),
      { numRuns: 100 }
    )
  })
})
