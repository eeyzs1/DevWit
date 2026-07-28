/**
 * Renderer build wrapper that reads .env and injects PostHog keys at build time.
 * Replaces the raw esbuild CLI invocation in package.json's build:renderer script.
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const envFile = join(rootDir, '.env')

const env = {}
if (existsSync(envFile)) {
  const lines = readFileSync(envFile, 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const sep = trimmed.indexOf('=')
    if (sep > 0) {
      const key = trimmed.slice(0, sep).trim()
      const value = trimmed.slice(sep + 1).trim().replace(/^["']|["']$/g, '')
      env[key] = value
    }
  }
}

const apiKey = env['POSTHOG_API_KEY'] ?? process.env['POSTHOG_API_KEY'] ?? ''
const host = env['POSTHOG_HOST'] ?? process.env['POSTHOG_HOST'] ?? ''

const defines = [
  `--define:process.env.POSTHOG_API_KEY=${JSON.stringify(JSON.stringify(apiKey))}`,
  `--define:process.env.POSTHOG_HOST=${JSON.stringify(JSON.stringify(host))}`,
].join(' ')

const esbuild = join(rootDir, 'node_modules', '.bin', 'esbuild')

const cmd = [
  JSON.stringify(esbuild),
  'apps/desktop/src/renderer/index.ts',
  '--bundle',
  '--outfile=apps/desktop/dist/renderer/index.js',
  '--format=iife',
  '--target=chrome130',
  '--sourcemap',
  '--loader:.css=css',
  defines,
].join(' ')

execSync(cmd, { stdio: 'inherit', cwd: rootDir })
