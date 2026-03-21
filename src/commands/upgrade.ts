import type { ComponentProvider, ProviderName } from '../types.js'
import { getProvider } from '../components.js'
import { getInstalledVersion, installComponent } from '../component-manager.js'
import { execShell } from '../repo-utils/os.js'
import { CliError } from '../profile-loader.js'

export interface UpgradeOptions {
  component?: string
  dryRun?: boolean
  provider?: ProviderName
}

export function filterComponents(provider: ComponentProvider, name?: string): Array<{ name: string }> {
  const keys = Object.keys(provider.components)
  if (!name) return keys.map(n => ({ name: n }))
  if (!keys.includes(name)) {
    throw new CliError(`Component '${name}' not found`, 2)
  }
  return [{ name }]
}

export async function runUpgrade(options: UpgradeOptions): Promise<void> {
  const provider: ComponentProvider = getProvider(options.provider ?? 'registry')
  const components = filterComponents(provider, options.component)
  const upgraded: string[] = []

  for (const { name } of components) {
    const def = provider.components[name]!
    const current = await getInstalledVersion(def)
    const upgrade = provider.needsAction(current, def.version)

    if (!upgrade) {
      console.log(`  ✓ ${name}: already at ${def.version}`)
      continue
    }

    console.log(`  ${name}: ${current ?? 'not installed'} → ${def.version}`)

    if (options.dryRun) {
      console.log(`  [dry-run] Would install '${name}' via ${provider.name} provider`)
    } else {
      console.log(`  Installing ${name}...`)
      await installComponent(name, def, provider)
      console.log(`  ✓ ${name} upgraded to ${def.version}`)
      upgraded.push(name)
    }
  }

  if (!options.dryRun && upgraded.length > 0) {
    const restartServices = ['xgw', 'notifier'].filter(svc => upgraded.includes(svc))
    for (const svc of restartServices) {
      console.log(`  Restarting ${svc}...`)
      try { await execShell(`${svc} stop`) } catch { /* not running, ignore */ }
      await execShell(`${svc} start`)
      console.log(`  ✓ ${svc} restarted`)
    }
  }

  console.log(options.dryRun ? '[dry-run] No changes made' : 'Upgrade complete!')
}
