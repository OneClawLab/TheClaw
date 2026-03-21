import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { TheClawConfig } from './types.js'

function getConfigPath(configPath?: string): string {
  if (configPath) return configPath
  if (process.env.THECLAW_CONFIG) return process.env.THECLAW_CONFIG
  const home = homedir()
  return join(home, '.config', 'theclaw', 'config.json')
}

export function getTheClawHome(): string {
  return process.env.THECLAW_HOME ?? join(homedir(), '.theclaw')
}

export async function readConfig(configPath?: string): Promise<TheClawConfig> {
  const path = getConfigPath(configPath)
  try {
    const content = await readFile(path, 'utf-8')
    return JSON.parse(content) as TheClawConfig
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Return default config if file doesn't exist
      return {
        schema_version: '1',
        profile: 'standard',
        completed_steps: [],
      }
    }
    throw err
  }
}

export async function writeConfig(config: TheClawConfig, configPath?: string): Promise<void> {
  const path = getConfigPath(configPath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(config, null, 2), 'utf-8')
}
