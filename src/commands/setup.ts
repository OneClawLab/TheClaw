import { input } from '@inquirer/prompts'
import type { TheClawConfig } from '../types.js'
import { readConfig, writeConfig } from '../config.js'
import { checkAll, installComponent } from '../component-manager.js'
import { getProvider } from '../components.js'
import type { ProviderName } from '../types.js'
import { loadProfile, extractPlaceholders, fillPlaceholders } from '../profile-loader.js'
import { execShell } from '../repo-utils/os.js'
import { path } from '../repo-utils/path.js'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(path.toPosixPath(fileURLToPath(import.meta.url)))
const PROFILES_DIR = path.join(__dirname, '..', '..', 'profiles')

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
  const apiKey = ctx.placeholderValues?.['PAI_API_KEY']

  if (!model) {
    console.log('  No PAI_MODEL found in profile, skipping pai model config')
    return
  }

  // Derive provider name from model (e.g. "gpt-4o" → "openai", "claude-3-5-sonnet" → "anthropic")
  // Fall back to a generic name if we can't detect
  const providerName = deriveProviderName(model)

  if (apiKey) {
    console.log(`  Configuring pai provider: ${providerName} (model: ${model})`)
    await execShell(`pai model config --add --name ${providerName} --provider ${providerName} --set apiKey=${apiKey} --default`)
  } else {
    console.log(`  Configuring pai default model: ${model} (no API key provided)`)
    await execShell(`pai model default --name ${providerName}`)
  }
}

function deriveProviderName(model: string): string {
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) return 'openai'
  if (model.startsWith('claude-')) return 'anthropic'
  if (model.startsWith('gemini-')) return 'google'
  if (model.startsWith('llama') || model.startsWith('mistral')) return 'ollama'
  // Default: use model name as provider name
  return model.split('-')[0] ?? model
}

export async function initAgents(ctx: SetupContext): Promise<void> {
  const agents = ctx.profileAgents ?? ['admin', 'warden', 'maintainer', 'evolver']
  for (const id of agents) {
    try {
      await execShell(`xar status ${id}`)
      console.log(`  Skipping agent: ${id} (already exists)`)
    } catch {
      console.log(`  Initializing agent: ${id}`)
      await execShell(`xar init ${id}`)
    }
  }
}

export async function startNotifier(): Promise<void> {
  console.log('  Starting notifier...')
  await execShell('notifier start')
}

export async function configureXgw(ctx: SetupContext): Promise<void> {
  const port = ctx.placeholderValues?.['XGW_PORT']
  if (port) {
    console.log(`  Configuring xgw port: ${port}`)
    // Write xgw config with the specified port before starting
    await execShell(`xgw channel add --type tui --port ${port} --id tui-main || true`)
  }
  console.log('  Starting xgw...')
  await execShell('xgw start')
}

export async function startAgents(ctx: SetupContext): Promise<void> {
  const agents = ctx.profileAgents ?? ['admin', 'warden', 'maintainer', 'evolver']
  for (const id of agents) {
    console.log(`  Starting agent: ${id}`)
    await execShell(`xar start ${id}`)
  }
}

export async function smokeTest(ctx: SetupContext): Promise<void> {
  const checks: Array<{ name: string; cmd: string }> = [
    { name: 'notifier', cmd: 'notifier status' },
    { name: 'xgw', cmd: 'xgw status' },
  ]

  if (ctx.profileAgents && ctx.profileAgents.length > 0) {
    for (const id of ctx.profileAgents) {
      checks.push({ name: `agent ${id}`, cmd: `xar status ${id}` })
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
        await configureXgw(ctx)
        break
      case 'start-agents':
        await startAgents(ctx)
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
