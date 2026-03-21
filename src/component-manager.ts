import { readFile } from 'fs/promises'
import yaml from 'js-yaml'
import type { ComponentDef, ComponentsConfig, ComponentStatus } from './types.js'
import { CliError } from './profile-loader.js'
import { commandExists, execCommand, execShell } from './repo-utils/os.js'

export function extractVersion(output: string): string | null {
  const match = /v?(\d+\.\d+\.\d+)/.exec(output)
  return match ? match[1]! : null
}

export async function loadComponents(yamlPath: string): Promise<ComponentsConfig> {
  let content: string
  try {
    content = await readFile(yamlPath, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(`components.yaml not found: ${yamlPath}`, 1)
    }
    throw err
  }

  let parsed: unknown
  try {
    parsed = yaml.load(content)
  } catch (err: unknown) {
    throw new CliError(`Failed to parse components.yaml: ${(err as Error).message}`, 1)
  }

  if (!parsed || typeof parsed !== 'object' || !('schema_version' in parsed) || !('components' in parsed)) {
    throw new CliError(`Invalid components.yaml: missing required fields 'schema_version' and 'components'`, 1)
  }

  const config = parsed as ComponentsConfig

  for (const [name, comp] of Object.entries(config.components)) {
    if (!comp.version || !comp.command || !comp.install) {
      throw new CliError(`Invalid component '${name}': missing required fields version, command, or install`, 1)
    }
  }

  return config
}

export async function isInstalled(command: string): Promise<boolean> {
  return commandExists(command)
}

export async function getInstalledVersion(component: ComponentDef): Promise<string | null> {
  try {
    const { stdout, stderr } = await execCommand(component.command, ['--version'], 5000)
    return extractVersion(stdout + stderr)
  } catch (err: unknown) {
    // Command might output to stderr and exit non-zero — try to extract from error message
    const execErr = err as { stdout?: string; stderr?: string }
    if (execErr.stdout || execErr.stderr) {
      return extractVersion((execErr.stdout ?? '') + (execErr.stderr ?? ''))
    }
    return null
  }
}

export function needsUpgrade(current: string | null, target: string): boolean {
  return current !== target
}

export async function installComponent(component: ComponentDef, dryRun?: boolean): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] Would install: ${component.install}`)
    return
  }
  await execShell(component.install)
}

export async function checkAll(config: ComponentsConfig): Promise<ComponentStatus[]> {
  const entries = Object.entries(config.components)
  const results = await Promise.all(
    entries.map(async ([name, comp]) => {
      const installed = await isInstalled(comp.command)
      const currentVersion = installed ? await getInstalledVersion(comp) : null
      const upgrade = needsUpgrade(currentVersion, comp.version)
      return {
        name,
        installed,
        currentVersion,
        targetVersion: comp.version,
        needsUpgrade: upgrade,
      } satisfies ComponentStatus
    })
  )
  return results
}
