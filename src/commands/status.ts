import type { StatusResult, NotifierStatus, XgwStatus, AgentStatus } from '../types.js'
import { execShell } from '../repo-utils/os.js'

export interface StatusOptions {
  json?: boolean
  deep?: boolean
}

export async function fetchComponentStatus(name: string, cmd: string): Promise<unknown> {
  try {
    const { stdout } = await execShell(cmd)
    return JSON.parse(stdout)
  } catch (err: unknown) {
    return { error: (err as Error).message, name }
  }
}

export async function aggregateStatus(options: StatusOptions): Promise<StatusResult> {
  const [notifierRaw, xgwRaw, ...agentRaws] = await Promise.all([
    fetchComponentStatus('notifier', 'notifier status --json'),
    fetchComponentStatus('xgw', 'xgw status --json'),
    fetchComponentStatus('agent-admin', 'xar status admin --json'),
    fetchComponentStatus('agent-warden', 'xar status warden --json'),
    fetchComponentStatus('agent-maintainer', 'xar status maintainer --json'),
    fetchComponentStatus('agent-evolver', 'xar status evolver --json'),
  ])

  // Parse notifier status
  const notifier: NotifierStatus = isErrorResult(notifierRaw)
    ? { running: false }
    : (notifierRaw as NotifierStatus)

  // Parse xgw status
  const xgw: XgwStatus = isErrorResult(xgwRaw)
    ? { running: false }
    : (xgwRaw as XgwStatus)

  // Parse agent statuses
  const agentIds = ['admin', 'warden', 'maintainer', 'evolver']
  const agents: AgentStatus[] = agentRaws.map((raw, i) => {
    if (isErrorResult(raw)) {
      return {
        id: agentIds[i]!,
        kind: 'unknown',
        started: false,
        inbox_pending: 0,
      }
    }
    return raw as AgentStatus
  })

  return { notifier, xgw, agents }
}

function isErrorResult(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && 'error' in raw
}

export function formatStatusText(result: StatusResult): string {
  const lines: string[] = []
  lines.push('=== TheClaw Status ===')
  lines.push('')
  lines.push(`notifier: ${result.notifier.running ? '✓ running' : '✗ stopped'}${result.notifier.pid ? ` (pid: ${result.notifier.pid})` : ''}`)
  lines.push(`xgw:      ${result.xgw.running ? '✓ running' : '✗ stopped'}${result.xgw.pid ? ` (pid: ${result.xgw.pid})` : ''}`)
  if (result.xgw.channels?.length) {
    for (const ch of result.xgw.channels) {
      lines.push(`  channel ${ch.id} (${ch.type}): ${ch.healthy ? '✓' : '✗'}`)
    }
  }
  lines.push('')
  lines.push('agents:')
  for (const agent of result.agents) {
    lines.push(`  ${agent.id} (${agent.kind}): ${agent.started ? '✓ started' : '✗ stopped'}, inbox: ${agent.inbox_pending}`)
  }
  return lines.join('\n')
}

export function formatStatusJson(result: StatusResult): string {
  return JSON.stringify(result, null, 2)
}
