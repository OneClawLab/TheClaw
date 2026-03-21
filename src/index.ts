#!/usr/bin/env node
import { Command } from 'commander'
import { runSetup } from './commands/setup.js'
import { aggregateStatus, formatStatusText, formatStatusJson } from './commands/status.js'
import { runUpgrade } from './commands/upgrade.js'
import { CliError } from './profile-loader.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string }

const program = new Command()

program
  .name('theclaw')
  .description('Agent runtime platform assembly, configuration and observability CLI')
  .version(pkg.version)

program
  .command('setup')
  .description('Initialize the agent runtime platform')
  .option('--profile <name|path>', 'profile name or path', 'standard')
  .option('--reset', 'clear existing config and re-run all setup steps')
  .action(async (options: { profile: string; reset?: boolean }) => {
    try {
      await runSetup({ profile: options.profile, reset: options.reset })
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
  .option('--dry-run', 'show what would be done without executing')
  .action(async (options: { component?: string; dryRun?: boolean }) => {
    try {
      await runUpgrade({ component: options.component, dryRun: options.dryRun })
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
    console.error(`Error: ${err.message}`)
    process.exit(err.exitCode)
  }
  console.error(`Error: ${(err as Error).message ?? String(err)}`)
  process.exit(1)
}

program.parse(process.argv)
