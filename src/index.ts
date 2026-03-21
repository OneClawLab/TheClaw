import { Command, CommanderError } from 'commander'
import { runSetup } from './commands/setup.js'
import { aggregateStatus, formatStatusText, formatStatusJson } from './commands/status.js'
import { runUpgrade } from './commands/upgrade.js'
import { CliError } from './profile-loader.js'
import type { ProviderName } from './types.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

process.stdout.on('error', (err) => { if ((err as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0); throw err })
process.stderr.on('error', (err) => { if ((err as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0); throw err })

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string }

const VALID_PROVIDERS: ProviderName[] = ['registry', 'local']

function parseProvider(value: string): ProviderName {
  if (!VALID_PROVIDERS.includes(value as ProviderName)) {
    throw new CliError(`Invalid provider '${value}'. Valid options: ${VALID_PROVIDERS.join(', ')}`, 2)
  }
  return value as ProviderName
}

const program = new Command()
program.exitOverride()

program
  .name('theclaw')
  .description('TheClaw setup and config CLI command')
  .version(pkg.version)

program
  .command('setup')
  .description('Initialize TheClaw agent runtime platform')
  .option('--profile <name|path>', 'profile name or path', 'standard')
  .option('--provider <name>', 'component install provider: registry (default) or local', 'registry')
  .option('--reset', 'clear existing config and re-run all setup steps')
  .action(async (options: { profile: string; provider: string; reset?: boolean }) => {
    try {
      await runSetup({ profile: options.profile, provider: parseProvider(options.provider), reset: options.reset })
    } catch (err: unknown) {
      handleError(err)
    }
  })

program
  .command('status')
  .description('Show platform component status')
  .option('--json', 'output JSON format')
  .option('--deep', 'deep connectivity check')
  .action(async (options: { json?: boolean; deep?: boolean }) => {
    try {
      const result = await aggregateStatus(options)
      if (options.json) {
        console.log(formatStatusJson(result))
      } else {
        console.log(formatStatusText(result))
      }
    } catch (err: unknown) {
      handleError(err)
    }
  })

program
  .command('upgrade')
  .description('Upgrade components to versions declared in components.yaml')
  .option('--component <name>', 'upgrade only the specified component')
  .option('--provider <name>', 'component install provider: registry (default) or local', 'registry')
  .option('--dry-run', 'show what would be done without executing')
  .action(async (options: { component?: string; provider: string; dryRun?: boolean }) => {
    try {
      await runUpgrade({ component: options.component, provider: parseProvider(options.provider), dryRun: options.dryRun })
    } catch (err: unknown) {
      handleError(err)
    }
  })

program.on('command:*', () => {
  console.error(`Unknown command: ${program.args.join(' ')}`)
  console.error('Run theclaw --help for available commands.')
  process.exit(2)
})

function handleError(err: unknown): never {
  if (err instanceof CliError) {
    process.stderr.write(`Error: ${err.message}\n`)
    process.exit(err.exitCode)
  }
  if (err instanceof CommanderError) {
    // commander exit code 1 (bad args) → remap to 2
    process.stderr.write(`${err.message}\n`)
    process.exit(err.exitCode === 1 ? 2 : err.exitCode)
  }
  process.stderr.write(`Error: ${(err as Error).message ?? String(err)}\n`)
  process.exit(1)
}

try {
  program.parse(process.argv)
} catch (err: unknown) {
  handleError(err)
}
