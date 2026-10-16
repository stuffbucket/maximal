#!/usr/bin/env bun
/**
 * Emit a CycloneDX 1.4 SBOM for production npm dependencies and run a
 * license scan. Pure Bun script — no new GitHub Actions / build deps.
 *
 * Usage:
 *
 *   bun scripts/sbom.ts
 *   bun scripts/sbom.ts --root . --root packages/mcp-broker
 *   bun scripts/sbom.ts --output PATH
 *   bun scripts/sbom.ts --no-fail-on-license
 *
 * License allowlist matches the conservative set from the parent PRD.
 * Loosen only with a documented justification in the commit message.
 */

import fs from "node:fs"
import path from "node:path"

const ALLOWED_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSD",
  "ISC",
  "Unlicense",
  "CC0-1.0",
  "0BSD",
  "BlueOak-1.0.0",
  "Python-2.0",
  "WTFPL",
  // SPDX expressions are split on AND / OR and checked leaf by leaf.
])

const LICENSE_ALIASES = new Map([
  // human-readable-ids@1.0.4 uses this non-SPDX spelling.
  ["Apache2", "Apache-2.0"],
])

interface PackageJson {
  name?: string
  version?: string
  license?: string | { type?: string }
  licenses?: Array<{ type?: string }>
  dependencies?: Record<string, string>
}

interface BomComponent {
  type: "library"
  "bom-ref": string
  name: string
  version: string
  purl: string
  licenses: Array<{ license: { id: string } | { name: string } }>
}

interface ScanRow {
  name: string
  version: string
  license: string
  allowed: boolean
}

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T
  } catch {
    return undefined
  }
}

function normalizeLicense(license: string): string {
  return license.replace(/\bApache2\b/gu, (value) =>
    LICENSE_ALIASES.get(value) ?? value,
  )
}

function extractLicense(pkg: PackageJson, packageDirectory: string): string {
  if (typeof pkg.license === "string") return normalizeLicense(pkg.license)
  if (pkg.license && typeof pkg.license === "object" && pkg.license.type) {
    return normalizeLicense(pkg.license.type)
  }
  if (pkg.licenses && pkg.licenses.length > 0 && pkg.licenses[0].type) {
    return normalizeLicense(pkg.licenses[0].type)
  }

  for (const fileName of ["LICENSE", "LICENSE.txt", "LICENSE.md"]) {
    try {
      const text = fs
        .readFileSync(path.join(packageDirectory, fileName), "utf8")
        .slice(0, 16_384)
      if (
        /^(?:The )?MIT License(?: \(MIT\))?/iu.test(text)
        && text.includes("Permission is hereby granted, free of charge")
      ) {
        return "MIT"
      }
    } catch {
      // Try the next conventional license filename.
    }
  }
  return "UNKNOWN"
}

function isAllowed(license: string): boolean {
  if (license === "UNKNOWN") return false
  const cleaned = license.replace(/[()]/g, "").trim()
  const leaves = cleaned.split(/\s+(?:AND|OR)\s+/iu)
  return leaves.every((leaf) => ALLOWED_LICENSES.has(leaf.trim()))
}

function resolveDependencyPackageJson(
  name: string,
  fromDirectory: string,
): string | undefined {
  let directory = fromDirectory
  while (true) {
    const candidate = path.join(directory, "node_modules", name, "package.json")
    try {
      return fs.realpathSync(candidate)
    } catch {
      const parent = path.dirname(directory)
      if (parent === directory) return undefined
      directory = parent
    }
  }
}

function collectDependencies(rootDirectories: Array<string>): Array<ScanRow> {
  const queue: Array<string> = []
  const unresolved = new Set<string>()

  const enqueueDependencies = (
    pkg: PackageJson,
    packageDirectory: string,
  ): void => {
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const packageJsonPath = resolveDependencyPackageJson(name, packageDirectory)
      if (packageJsonPath) queue.push(packageJsonPath)
      else unresolved.add(name)
    }
  }

  for (const rootDirectory of rootDirectories) {
    const absoluteRoot = path.resolve(rootDirectory)
    const root = readJson<PackageJson>(path.join(absoluteRoot, "package.json"))
    if (!root) throw new Error(`package.json not found under ${rootDirectory}`)
    enqueueDependencies(root, absoluteRoot)
  }

  const rows = new Map<string, ScanRow>()
  while (queue.length > 0) {
    const packageJsonPath = queue.shift()!
    const pkg = readJson<PackageJson>(packageJsonPath)
    if (!pkg) continue
    const name = pkg.name ?? path.basename(path.dirname(packageJsonPath))
    const version = pkg.version ?? "unknown"
    const key = `${name}@${version}`
    if (rows.has(key)) continue

    const license = extractLicense(pkg, path.dirname(packageJsonPath))
    rows.set(key, {
      name,
      version,
      license,
      allowed: isAllowed(license),
    })
    enqueueDependencies(pkg, path.dirname(packageJsonPath))
  }

  for (const name of unresolved) {
    const key = `${name}@unknown`
    if (!rows.has(key)) {
      rows.set(key, {
        name,
        version: "unknown",
        license: "UNKNOWN",
        allowed: false,
      })
    }
  }

  return [...rows.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name)
      || left.version.localeCompare(right.version),
  )
}

function buildBom(rows: Array<ScanRow>, rootName: string, rootVersion: string) {
  const components: Array<BomComponent> = rows.map((row) => ({
    type: "library",
    "bom-ref": `pkg:npm/${row.name}@${row.version}`,
    name: row.name,
    version: row.version,
    purl: `pkg:npm/${row.name}@${row.version}`,
    licenses: [
      row.license !== "UNKNOWN"
        ? { license: { id: row.license } }
        : { license: { name: "UNKNOWN" } },
    ],
  }))
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.4",
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: "application",
        name: rootName,
        version: rootVersion,
      },
    },
    components,
  }
}

function parseArgs(argv: Array<string>): {
  output: string
  failOnLicense: boolean
  roots: Array<string>
} {
  let output = "SBOM.cdx.json"
  let failOnLicense = true
  const roots: Array<string> = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") {
      output = argv[++index]
    } else if (argv[index] === "--root") {
      roots.push(argv[++index])
    } else if (argv[index] === "--no-fail-on-license") {
      failOnLicense = false
    }
  }
  return {
    output,
    failOnLicense,
    roots: roots.length === 0 ? ["."] : roots,
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2))
  const root = readJson<PackageJson>(
    path.join(path.resolve(args.roots[0]), "package.json"),
  )
  if (!root) {
    console.error(`package.json not found under ${args.roots[0]}`)
    return 1
  }
  const rows = collectDependencies(args.roots)
  const bom = buildBom(
    rows,
    root.name ?? "unknown",
    root.version ?? "0.0.0",
  )
  fs.writeFileSync(args.output, `${JSON.stringify(bom, null, 2)}\n`)

  const denied = rows.filter((row) => !row.allowed)
  console.log(`SBOM written: ${args.output}`)
  console.log(`Production dependencies scanned: ${rows.length}`)
  console.log(`Disallowed licenses: ${denied.length}`)
  if (denied.length > 0) {
    console.log("")
    console.log("Disallowed:")
    for (const row of denied) {
      console.log(`  ${row.name}@${row.version}  ${row.license}`)
    }
    if (args.failOnLicense) return 1
  }
  return 0
}

process.exit(main())
