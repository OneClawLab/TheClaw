// Shared type definitions for TheClaw CLI

// ── Component Management (Requirements 1.1) ──────────────────────────────────

export interface ComponentDef {
  version: string   // target version e.g. "0.5.0"
  command: string   // executable command name for which detection
  install: string   // full install command
}

export interface ComponentsConfig {
  schema_version: string
  components: Record<string, ComponentDef>
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

// ── TheClaw Config (Requirements 7.4) ─────────────────────────────────────────

export interface TheClawConfig {
  schema_version: string          // "1"
  profile: string
  setup_completed_at?: string     // ISO 8601
  components_yaml_path: string
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
