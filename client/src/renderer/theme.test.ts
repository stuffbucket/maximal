import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SHELL_TERMINAL_PROPERTIES } from 'stuffbucket-electron/renderer'
import { shellVariableContract } from 'stuffbucket-electron/verify/shell-variables'

const require = createRequire(import.meta.url)
const SHELL_STYLES_PATH = require.resolve('stuffbucket-electron/renderer/styles.css')
const SHELL_STYLES = readFileSync(SHELL_STYLES_PATH, 'utf8')

function installedContract() {
  return shellVariableContract({
    stylesheets: [{ name: SHELL_STYLES_PATH, css: SHELL_STYLES }],
    runtimeProperties: Object.values(SHELL_TERMINAL_PROPERTIES),
  })
}

function definedThemeVariables(): Set<string> {
  const source = readFileSync(resolve(process.cwd(), 'src/renderer/theme.ts'), 'utf8')
  return new Set(
    [...source.matchAll(/^\s*(--shell-[a-z0-9-]+)\s*:/gm)].map((match) => match[1] ?? ''),
  )
}

describe('the stuffbucket-electron shell variable contract', () => {
  it('derives a non-empty contract from the installed package', () => {
    expect(SHELL_STYLES.length, `${SHELL_STYLES_PATH} resolved but was empty`).toBeGreaterThan(0)

    const contract = installedContract()

    expect(contract.required.length).toBeGreaterThan(0)
    expect(contract.fallback.length).toBeGreaterThan(0)
    expect(contract.runtime.length).toBeGreaterThan(0)
  })

  it('defines every variable the installed package requires without a fallback', () => {
    const required = installedContract().required
    const defined = definedThemeVariables()
    const missing = required.filter((name) => !defined.has(name))

    expect(
      missing,
      `theme.ts does not define required variables from ${SHELL_STYLES_PATH}: ${missing.join(', ')}`,
    ).toEqual([])
  })
})
