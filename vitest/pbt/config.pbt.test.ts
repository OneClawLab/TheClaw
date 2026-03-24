import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, rm } from '../../src/repo-utils/fs.js'
import { tmpdir } from 'node:os'
import { path } from '../../src/repo-utils/path.js'
import { readConfig, writeConfig } from '../../src/config.js'
import type { TheClawConfig } from '../../src/types.js'

// Arbitrary for TheClawConfig
const theClawConfigArb: fc.Arbitrary<TheClawConfig> = fc.record({
  schema_version: fc.constantFrom('1'),
  profile: fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-z0-9-]+$/.test(s)),
  setup_completed_at: fc.option(fc.date().map(d => d.toISOString()), { nil: undefined }),
  completed_steps: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 50 })), { nil: undefined }),
})

describe('config', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(path.toPosixPath(tmpdir()), 'theclaw-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  // Feature: theclaw-cli, Property 8: 配置文件读写往返一致性
  test('Property 8: readConfig after writeConfig returns equivalent object', async () => {
    let i = 0
    await fc.assert(
      fc.asyncProperty(theClawConfigArb, async (config) => {
        const tmpPath = path.join(tmpDir, `config-${i++}.json`)
        await writeConfig(config, tmpPath)
        const result = await readConfig(tmpPath)
        // Verify all fields match
        expect(result.schema_version).toBe(config.schema_version)
        expect(result.profile).toBe(config.profile)
        if (config.setup_completed_at !== undefined) {
          expect(result.setup_completed_at).toBe(config.setup_completed_at)
        }
        if (config.completed_steps !== undefined) {
          expect(result.completed_steps).toEqual(config.completed_steps)
        }
      }),
      { numRuns: 100 }
    )
  })
})
