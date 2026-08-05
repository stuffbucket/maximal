import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

interface CorePackage {
  version: string
}

interface LockPackage {
  resolved?: string
}

interface PackageLock {
  packages?: Record<string, LockPackage>
}

const coreRoot = resolve('node_modules/@stuffbucket/maximal-core')
const corePackage = JSON.parse(readFileSync(resolve(coreRoot, 'package.json'), 'utf8')) as CorePackage
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as PackageLock
const resolved = lock.packages?.['node_modules/@stuffbucket/maximal-core']?.resolved ?? ''
const gitSha = resolved.match(/#([0-9a-f]{40})$/)?.[1] ?? ''
const spec = process.env.MAXIMAL_CORE_REF || `v${corePackage.version}`
const channel = corePackage.version.includes('-') ? corePackage.version.split('-', 2)[1].split('.', 1)[0] : 'stable'
const output = resolve(process.env.MAXIMAL_CORE_OUT || 'resources/bin/maximal-core')

mkdirSync(dirname(output), { recursive: true })

const args = [
  'build',
  '--compile',
  '--minify',
  '--sourcemap',
  '--target=bun-darwin-arm64',
  '--define',
  `__MAXIMAL_VERSION__=${JSON.stringify(corePackage.version)}`,
  '--define',
  `__MAXIMAL_GIT_SHA__=${JSON.stringify(gitSha)}`,
  '--define',
  `__MAXIMAL_GIT_BRANCH__=${JSON.stringify(spec)}`,
  '--define',
  `__MAXIMAL_CHANNEL__=${JSON.stringify(channel)}`,
  resolve(coreRoot, 'src/main.ts'),
  '--outfile',
  output,
]

console.log(`Building maximal-core ${corePackage.version} (${gitSha.slice(0, 12) || 'unknown revision'})`)
const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
