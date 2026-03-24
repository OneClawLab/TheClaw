import { describe, test } from 'vitest'
import fc from 'fast-check'
import { shouldSkipStep, markStepComplete, SETUP_STEPS } from '../../src/commands/setup.js'

function makeConfig(completedSteps: string[]) {
  return {
    schema_version: '1' as const,
    profile: 'standard',
    completed_steps: completedSteps,
  }
}

// Feature: theclaw-cli, Property 9: setup 幂等性
// Validates: Requirements 2.4
describe('Property 9: setup 幂等性', () => {
  test('shouldSkipStep returns true for all steps in completed_steps', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...SETUP_STEPS), { minLength: 1 }),
        (steps) => {
          const uniqueSteps = [...new Set(steps)]
          const config = makeConfig(uniqueSteps)
          return uniqueSteps.every(step => shouldSkipStep(step, config))
        }
      ),
      { numRuns: 100 }
    )
  })

  test('steps NOT in completed_steps are not skipped', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...SETUP_STEPS), { minLength: 0, maxLength: SETUP_STEPS.length - 1 }),
        (completedSteps) => {
          const uniqueCompleted = [...new Set(completedSteps)]
          const config = makeConfig(uniqueCompleted)
          const remaining = SETUP_STEPS.filter(s => !uniqueCompleted.includes(s))
          return remaining.every(step => !shouldSkipStep(step, config))
        }
      ),
      { numRuns: 100 }
    )
  })

  test('markStepComplete is idempotent', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SETUP_STEPS),
        fc.array(fc.constantFrom(...SETUP_STEPS), { minLength: 0 }),
        (step, existingSteps) => {
          const config = makeConfig(existingSteps)
          const once = markStepComplete(step, config)
          const twice = markStepComplete(step, once)
          return JSON.stringify(once.completed_steps) === JSON.stringify(twice.completed_steps)
        }
      ),
      { numRuns: 100 }
    )
  })
})
