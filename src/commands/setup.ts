import { input } from '@inquirer/prompts'
import type { TheClawConfig } from '../types.js'
import { readConfig, writeConfig } from '../config.js'
import { loadComponents, checkAll, installComponent } from '../component-manager.js'
import { loadProfile, extractPlaceholders, fillPlaceholders } from '../profile-loader.js'
import { execShell } from '../repo-utils/os.js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROFILES_DIR = join(__dirname, '..', '..', 'profiles')

export const SETUP_STEPS = [
  'install-components',
  'load-profile',
  'configure-pai',
  'init-agents',
  'start-notifier',
  'configure-xgw',
  'start-agents',
  'smoke-test',
] as const

export type SetupStep = typeof SETUP_STEPS[number]

export interface SetupOptions {
  profile: string
  reset?: boolean
  configPath?: string
}

// Context passed between steps to share profile data
export interface SetupContext {
  filledProfileContent?: string
  placeholderValues?: Record<string, string>
}

export function shouldSkipStep(step: string, config: TheClawConfig): boolean {
  return (config.completed_steps ?? []).includes(step)
}

export function markStepComplete(step: string, config: TheClawConfig): TheClawConfig {
  const completed = config.completed_steps ?? []
  if (completed.includes(step)) return config
  return {
    ...config,
    completed_steps: [...completed, step],
  }
}

// ── Step implementations ──────────────────────────────────────────────────────

export async function installComponents(config: TheClawConfig): Promise<void> {
  const componentsConfig = await loadComponents(config.components_yaml_path)
  const statuses = await checkAll(componentsConfig)
  for (const status of statuses) {
    if (!status.installed || status.needsUpgrade) {
      console.log(`Installing ${status.name}...`)
      const comp = componentsConfig.components[status.name]!
      await installComponent(comp)
      console.log(`  ✓ ${status.name} installed`)
    } else {
      console.log(`  ✓ ${status.name} already up to date (${status.currentVersion})`)
    }
  }
}

export async function loadAndFillProfile(
  profileNameOrPath: string,
  ctx: SetupContext,
): Promise<void> {
  const profile = await loadProfile(profileNameOrPath, PROFILES_DIR)
  // Serialize profile back to string for placeholder extraction
  const profileStr = JSON.stringify(profile)
  const placeholders = extractPlaceholders(profileStr)

  const values: Record<string, string> = {}
  for (const placeholder of placeholders) {
    const answer = await input({ message: `Enter value for ${placeholder}:` })
    values[placeholder] = answer
  }

  ctx.filledProfileContent = fillPlaceholders(profileStr, values)
  ctx.placeholderValues = values
}

export async function configurePai(ctx: SetupContext): Promise<void> {
  const model = ctx.placeholderValues?.['PAI_MODEL']
  if (!model) {
    console.log('  No PAI_MODEL found in profile, skipping pai model config')
    return
  }
  console.log(`  Configuring pai model: ${model}`)
  await execShell(`pai model config --model ${model}`)
}

export async function initAgents(): Promise<void> {
  const agents = ['admin', 'warden', 'maintainer', 'evolver']
  for (const id of agents) {
    console.log(`  Initializing agent: ${id}`)
    await execShell(`agent init ${id}`)
  }
}

export async function startNotifier(): Promise<void> {
  console.log('  Starting notifier...')
  await execShell('notifier start')
}

export async function configureXgw(): Promise<void> {
  console.log('  Starting xgw...')
  await execShell('xgw start')
}

export async function startAgents(): Promise<void> {
  const agents = ['admin', 'warden', 'maintainer', 'evolver']
  for (const id of agents) {
    console.log(`  Starting agent: ${id}`)
    await execShell(`agent start ${id}`)
  }
}

export async function smokeTest(): Promise<void> {
  const checks = [
    { name: 'notifier', cmd: 'notifier status' },
    { name: 'xgw', cmd: 'xgw status' },
    { name: 'agent admin', cmd: 'agent status admin' },
  ]
  for (const check of checks) {
    try {
      await execShell(check.cmd)
      console.log(`  ✓ ${check.name} is running`)
    } catch (err) {
      throw new Error(`Smoke test failed for ${check.name}: ${(err as Error).message}`)
    }
  }
}

// ── Main runSetup orchestrator ────────────────────────────────────────────────

export async function runSetup(options: SetupOptions): Promise<void> {
  let config = await readConfig(options.configPath)

  if (options.reset) {
    config = { ...config, completed_steps: [
] }
    await writeConfig(config, options.configPath)
    console.log('Reset: cleared completed steps')
  }

  const ctx: SetupContext = {}

  for (const step of SETUP_STEPS) {
    if (shouldSkipStep(step, config)) {
      console.log(`Skipping step: ${step} (already completed)`)
      continue
    }

    console.log(`Running step: ${step}`)

    switch (step) {
      case 'install-components':
        await installComponents(config)
        break
      case 'load-profile':
        await loadAndFillProfile(options.profile, ctx)
        break
      case 'configure-pai':
        await configurePai(ctx)
        break
      case 'init-agents':
        await initAgents()
        break
      case 'start-notifier':
        await startNotifier()
        break
      case 'configure-xgw':
        await configureXgw()
        break
      case 'start-agents':
        await startAgents()
        break
      case 'smoke-test':
        await smokeTest()
        break
    }

    config = markStepComplete(step, config)
    await writeConfig(config, options.configPath)
    console.log(`  ✓ Step complete: ${step}`)
  }

  // Record completion
  config = {
    ...config,
    profile: options.profile,
    setup_completed_at: new Date().toISOString(),
  }
  await writeConfig(config, options.configPath)

  console.log('Setup complete!')
}
