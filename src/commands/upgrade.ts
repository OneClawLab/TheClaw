import type { ComponentDef, ComponentsConfig } from '../types.js'
import { loadComponents, getInstalledVersion, needsUpgrade, installComponent } from '../component-manager.js'
import { readConfig } from '../config.js'
import { execShell } from '../repo-utils/os.js'
import { CliError } from '../profile-loader.js'

export interface UpgradeOptions {
  component?: string
  dryRun?: boolean
  configPath?: string
}

/**
 * Filter components from config by optional name.
 * Throws CliError (exit 2) if the named component doesn't exist.
 */
export function filterComponents(
  config: ComponentsConfig,
  name?: string
): Array<{ name: string; def: ComponentDef }> {
  const entries = Object.entries(config.components).map(([n, def]) => ({ name: n, def }))
  if (!name) return entries
  const filtered = entries.filter(e => e.name === name)
  if (filtered.length === 0) {
    throw new CliError(`Component '${name}' not found in components.yaml`, 2)
  }
  return filtered
}

/**
 * Run the upgrade command: read components.yaml, compare versions,
 * execute upgrades, and gracefully restart affected services.
 */
export async function runUpgrade(options: UpgradeOptions): Promise<void> {
  const config = await readConfig(options.configPath)
  const componentsConfig = await loadComponents(config.components_yaml_path)

  const components = filterComponents(componentsConfig, options.component)

  const upgraded: string[] = []

  for (const { name, def } of components) {
    const current = await getInstalledVersion(def)
    const upgrade = needsUpgrade(current, def.version)

    if (!upgrade) {
      console.log(`  ✓ ${name}: already at ${def.version}`)
      continue
    }

    console.log(`  ${name}: ${current ?? 'not installed'} → ${def.version}`)

    if (options.dryRun) {
      console.log(`  [dry-run] Would run: ${def.install}`)
    } else {
      console.log(`  Installing ${name}...`)
      await installComponent(def)
      console.log(`  ✓ ${name} upgraded to ${def.version}`)
      upgraded.push(name)
    }
  }

  if (!options.dryRun && upgraded.length > 0) {
    // Graceful restart (stop → start) for xgw and notifier if they were upgraded
    const restartServices = ['xgw', 'notifier'].filter(svc => upgraded.includes(svc))

    for (const svc of restartServices) {
      console.log(`  Restarting ${svc}...`)
      try {
        await execShell(`${svc} stop`)
      } catch {
        // Ignore stop errors — service might not be running
      }
      await execShell(`${svc} start`)
      console.log(`  ✓ ${svc} restarted`)
    }
  }

  if (options.dryRun) {
    console.log('[dry-run] No changes made')
  } else {
    console.log('Upgrade complete!')
  }
}
