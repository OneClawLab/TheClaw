import type { ComponentDef, ComponentProvider, ComponentStatus } from './types.js'
import { commandExists, execCommand } from './repo-utils/os.js'

export function extractVersion(output: string): string | null {
  const match = /v?(\d+\.\d+\.\d+)/.exec(output)
  return match ? match[1]! : null
}

export async function isInstalled(command: string): Promise<boolean> {
  return commandExists(command)
}

export async function getInstalledVersion(component: ComponentDef): Promise<string | null> {
  try {
    const { stdout, stderr } = await execCommand(component.command, ['--version'], 5000)
    return extractVersion(stdout + stderr)
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string }
    if (execErr.stdout || execErr.stderr) {
      return extractVersion((execErr.stdout ?? '') + (execErr.stderr ?? ''))
    }
    return null
  }
}

export async function installComponent(
  componentName: string,
  def: ComponentDef,
  provider: ComponentProvider,
  dryRun?: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] Would install '${componentName}' via ${provider.name} provider`)
    return
  }
  await provider.install(componentName, def)
}

export async function checkAll(provider: ComponentProvider): Promise<ComponentStatus[]> {
  const entries = Object.entries(provider.components)
  const results = await Promise.all(
    entries.map(async ([name, comp]) => {
      const installed = await isInstalled(comp.command)
      const currentVersion = installed ? await getInstalledVersion(comp) : null
      const upgrade = provider.needsAction(currentVersion, comp.version)
      return {
        name,
        installed,
        currentVersion,
        targetVersion: comp.version ?? '(local)',
        needsUpgrade: upgrade,
      } satisfies ComponentStatus
    })
  )
  return results
}
