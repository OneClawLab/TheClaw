import { readFile } from 'fs/promises'
import { join } from 'path'
import yaml from 'js-yaml'
import type { Profile } from './types.js'

export class CliError extends Error {
  constructor(message: string, public readonly exitCode: number) {
    super(message)
    this.name = 'CliError'
  }
}

const PLACEHOLDER_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g

export function extractPlaceholders(content: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  let match: RegExpExecArray | null
  const re = new RegExp(PLACEHOLDER_RE.source, 'g')
  while ((match = re.exec(content)) !== null) {
    const name = match[1]!
    if (!seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }
  return result
}

export function fillPlaceholders(content: string, values: Record<string, string>): string {
  return content.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => {
    return values[name] ?? `\${${name}}`
  })
}

export async function loadProfile(nameOrPath: string, profilesDir: string): Promise<Profile> {
  const isPath = nameOrPath.includes('/') || nameOrPath.includes('\\') || nameOrPath.endsWith('.yaml')
  const filePath = isPath ? nameOrPath : join(profilesDir, `${nameOrPath}.yaml`)

  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(`Profile file not found: ${filePath}`, 2)
    }
    throw err
  }

  let parsed: unknown
  try {
    parsed = yaml.load(content)
  } catch (err: unknown) {
    throw new CliError(`Failed to parse profile YAML: ${(err as Error).message}`, 1)
  }

  if (!parsed || typeof parsed !== 'object' || !('name' in parsed) || !('steps' in parsed)) {
    throw new CliError(`Invalid profile format: missing required fields 'name' and 'steps'`, 1)
  }

  return parsed as Profile
}
