import { readFile, writeFile, mkdir } from './repo-utils/fs.js'
import { path } from './repo-utils/path.js'
import { homedir } from 'node:os'
import type { TheClawConfig } from './types.js'

function getConfigPath(configPath?: string): string {
  if (configPath) return configPath
  if (process.env.THECLAW_CONFIG) return process.env.THECLAW_CONFIG
  const home = path.toPosixPath(homedir())
  return path.join(home, '.config', 'theclaw', 'config.json')
}

export function getTheClawHome(): string {
  return process.env.THECLAW_HOME ?? path.join(path.toPosixPath(homedir()), '.theclaw')
}

export async function readConfig(configPath?: string): Promise<TheClawConfig> {
  const filePath = getConfigPath(configPath)
  try {
    const content = await readFile(filePath, 'utf-8')
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
  const filePath = getConfigPath(configPath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8')
}
