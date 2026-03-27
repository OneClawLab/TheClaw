import type { ComponentDef, ComponentProvider, ProviderName } from './types.js'
import { CliError } from './profile-loader.js'
import { execShell } from './repo-utils/os.js'

// ── registry: install from npm, version-pinned ────────────────────────────────

const registryComponents: Record<string, ComponentDef> = {
  pai:      { version: '0.5.0', command: 'pai' },
  cmds:     { version: '0.3.0', command: 'cmds' },
  xdb:      { version: '0.4.0', command: 'xdb' },
  xweb:     { version: '0.2.0', command: 'xweb' },
  notifier: { version: '0.3.0', command: 'notifier' },
  thread:   { version: '0.3.0', command: 'thread' },
  xar:      { version: '2.0.0', command: 'xar' },
  xgw:      { version: '0.1.0', command: 'xgw' },
}

// ── local: pre-installed manually, no version constraint ─────────────────────

const localComponents: Record<string, ComponentDef> = {
  pai:      { command: 'pai' },
  cmds:     { command: 'cmds' },
  xdb:      { command: 'xdb' },
  xweb:     { command: 'xweb' },
  notifier: { command: 'notifier' },
  thread:   { command: 'thread' },
  xar:      { command: 'xar' },
  xgw:      { command: 'xgw' },
}

// ── Providers ─────────────────────────────────────────────────────────────────

export const registryProvider: ComponentProvider = {
  name: 'registry',
  components: registryComponents,
  needsAction: (current, target) => current !== target,
  async install(componentName, def) {
    await execShell(`npm install -g ${componentName}@${def.version}`)
  },
}

export const localProvider: ComponentProvider = {
  name: 'local',
  components: localComponents,
  needsAction: (current) => current === null,
  async install(componentName) {
    throw new CliError(
      `Component '${componentName}' is not installed. With local provider, install it manually (e.g. npm run build && npm link).`,
      1,
    )
  },
}

const PROVIDERS: Record<ProviderName, ComponentProvider> = {
  registry: registryProvider,
  local: localProvider,
}

export function getProvider(name: ProviderName): ComponentProvider {
  return PROVIDERS[name]
}
