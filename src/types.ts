// Shared type definitions for TheClaw CLI

// ── Component Management ──────────────────────────────────────────────────────

export interface ComponentDef {
  version?: string  // required for registry, not needed for local
  command: string   // executable command name for which detection
}

// ── Components Provider ───────────────────────────────────────────────────────

export type ProviderName = 'registry' | 'local'

export interface ComponentProvider {
  name: ProviderName
  components: Record<string, ComponentDef>
  /** Install a single component. For local provider, throws if not installed. */
  install(componentName: string, def: ComponentDef): Promise<void>
  /** Determine if a component needs to be installed/upgraded given its current installed version. */
  needsAction(current: string | null, target?: string): boolean
}

// ── Profile (Requirements 3.1) ────────────────────────────────────────────────

export interface ProfileStep {
  type: string
  [key: string]: unknown
}

export interface Profile {
  name: string
  steps: ProfileStep[]
}

// ── TheClaw Config ────────────────────────────────────────────────────────────

export interface TheClawConfig {
  schema_version: string          // "1"
  profile: string
  setup_completed_at?: string     // ISO 8601
  completed_steps?: string[]
}

// ── Component Status ──────────────────────────────────────────────────────────

export interface ComponentStatus {
  name: string
  installed: boolean
  currentVersion: string | null
  targetVersion: string
  needsUpgrade: boolean
}

// ── Status Result (Requirements 4.6) ─────────────────────────────────────────

export interface NotifierStatus {
  running: boolean
  pid?: number
}

export interface XgwChannel {
  id: string
  type: string
  healthy: boolean
}

export interface XgwStatus {
  running: boolean
  pid?: number
  channels?: XgwChannel[]
}

export interface AgentStatus {
  id: string
  kind: string
  started: boolean
  inbox_pending: number
  last_activity?: string
}

export interface StatusResult {
  notifier: NotifierStatus
  xgw: XgwStatus
  agents: AgentStatus[]
}

// ── Health Check ──────────────────────────────────────────────────────────────

export interface HealthCheck {
  name: string
  status: 'ok' | 'warning' | 'error'
  detail?: string
}

export interface HealthCheckResult {
  healthy: boolean
  checks: HealthCheck[]
}
