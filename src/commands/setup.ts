import { input } from '@inquirer/prompts'
import type { TheClawConfig } from '../types.js'
import { readConfig, writeConfig } from '../config.js'
import { checkAll, installComponent } from '../component-manager.js'
import { getProvider } from '../components.js'
import type { ProviderName } from '../types.js'
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
  provider?: ProviderName
  configPath?: string
}

// Context passed between steps to share profile data
export interface SetupContext {
  filledProfileContent?: string
  placeholderValues?: Record<string, string>
  profileAgents?: string[]
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

export async function installComponents(_config: TheClawConfig, provider = getProvider('registry')): Promise<void> {
  const statuses = await checkAll(provider)
  for (const status of statuses) {
    if (!status.installed || status.needsUpgrade) {
      console.log(`Installing ${status.name}...`)
      const comp = provider.components[status.name]!
      await installComponent(status.name, comp, provider)
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
  const profileStr = JSON.stringify(profile)
  const placeholders = extractPlaceholders(profileStr)

  const values: Record<string, string> = {}
  for (const placeholder of placeholders) {
    const answer = await input({ message: `Enter value for ${placeholder}:` })
    values[placeholder] = answer
  }

  ctx.filledProfileContent = fillPlaceholders(profileStr, values)
  ctx.placeholderValues = values

  // Extract agents list from profile steps
  const initStep = profile.steps.find(s => s.type === 'init-agents')
  if (initStep && Array.isArray(initStep['agents'])) {
    ctx.profileAgents = initStep['agents'] as string[]
  }
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

export async function initAgents(ctx: SetupContext): Promise<void> {
  const agents = ctx.profileAgents ?? ['admin', 'warden', 'maintainer', 'evolver']
  for (const id of agents) {
    try {
      await execShell(`agent status ${id}`)
      console.log(`  Skipping agent: ${id} (already exists)`)
    } catch {
      console.log(`  Initializing agent: ${id}`)
      await execShell(`agent init ${id}`)
    }
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

export async function smokeTest(ctx: SetupContext): Promise<void> {
  const checks: Array<{ name: string; cmd: string }> = [
    { name: 'notifier', cmd: 'notifier status' },
  ]

  if (ctx.profileAgents && ctx.profileAgents.length > 0) {
    for (const id of ctx.profileAgents) {
      checks.push({ name: `agent ${id}`, cmd: `agent status ${id}` })
    }
  }

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
  const provider = getProvider(options.provider ?? 'registry')

  if (options.reset) {
    config = { ...config, completed_steps: [] }
    await writeConfig(config, options.configPath)
    console.log('Reset: cleared completed steps')
  }

  // Load profile upfront to determine which steps to run
  const profile = await loadProfile(options.profile, PROFILES_DIR)
  const profileStepTypes = new Set(profile.steps.map(s => s.type))

  // Extract agents list from profile upfront (not dependent on load-profile step)
  const initStep = profile.steps.find(s => s.type === 'init-agents')
  const ctx: SetupContext = {
    profileAgents: (Array.isArray(initStep?.['agents']) ? initStep['agents'] : undefined) as string[] | undefined,
  }

  for (const step of SETUP_STEPS) {
    // Skip steps not in this profile
    if (!profileStepTypes.has(step) && step !== 'load-profile') {
      continue
    }

    if (shouldSkipStep(step, config)) {
      console.log(`Skipping step: ${step} (already completed)`)
      continue
    }

    console.log(`Running step: ${step}`)

    switch (step) {
      case 'install-components':
        await installComponents(config, provider)
        break
      case 'load-profile':
        await loadAndFillProfile(options.profile, ctx)
        break
      case 'configure-pai':
        await configurePai(ctx)
        break
      case 'init-agents':
        await initAgents(ctx)
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
        await smokeTest(ctx)
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
