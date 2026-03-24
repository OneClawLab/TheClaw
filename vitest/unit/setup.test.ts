import { describe, test, expect } from 'vitest'
import { shouldSkipStep, markStepComplete } from '../../src/commands/setup.js'
import type { TheClawConfig } from '../../src/types.js'

function makeConfig(completedSteps: string[]): TheClawConfig {
  return {
    schema_version: '1',
    profile: 'standard',
    completed_steps: completedSteps,
  }
}

describe('shouldSkipStep', () => {
  test('returns false when completed_steps is empty', () => {
    expect(shouldSkipStep('install-components', makeConfig([]))).toBe(false)
  })

  test('returns true when step is in completed_steps', () => {
    const config = makeConfig(['install-components', 'load-profile'])
    expect(shouldSkipStep('install-components', config)).toBe(true)
    expect(shouldSkipStep('load-profile', config)).toBe(true)
  })

  test('returns false when step is not in completed_steps', () => {
    expect(shouldSkipStep('load-profile', makeConfig(['install-components']))).toBe(false)
  })

  test('returns false when completed_steps is undefined', () => {
    const config: TheClawConfig = {
      schema_version: '1',
      profile: 'standard',
    }
    expect(shouldSkipStep('install-components', config)).toBe(false)
  })
})

describe('markStepComplete', () => {
  test('adds step to completed_steps', () => {
    const updated = markStepComplete('install-components', makeConfig([]))
    expect(updated.completed_steps).toContain('install-components')
  })

  test('does not duplicate if step already present', () => {
    const updated = markStepComplete('install-components', makeConfig(['install-components']))
    expect(updated.completed_steps?.filter(s => s === 'install-components').length).toBe(1)
  })

  test('does not mutate original config', () => {
    const config = makeConfig([])
    markStepComplete('install-components', config)
    expect(config.completed_steps).toEqual([])
  })
})
