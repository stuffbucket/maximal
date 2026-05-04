#!/usr/bin/env bun
/**
 * Emit a CycloneDX 1.4 SBOM for production npm dependencies and run a
 * license scan. Pure Bun script — no new GitHub Actions / build deps.
 *
 * Usage:
 *
 *   bun scripts/sbom.ts                    # emit SBOM.cdx.json + summary;
 *                                          # exit non-zero on disallowed license
 *   bun scripts/sbom.ts --output PATH      # custom output path
 *   bun scripts/sbom.ts --no-fail-on-license  # don't enforce, just report
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
  // SPDX expressions — handle composite licenses below by splitting on
  // " AND " / " OR " and re-checking each leaf against this set.
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

function readJson<T>(p: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T
  } catch {
    return undefined
  }
}

function extractLicense(pkg: PackageJson): string {
  if (typeof pkg.license === "string") return pkg.license
  if (pkg.license && typeof pkg.license === "object" && pkg.license.type) {
    return pkg.license.type
  }
  if (pkg.licenses && pkg.licenses.length > 0 && pkg.licenses[0].type) {
    return pkg.licenses[0].type
  }
  return "UNKNOWN"
}

function isAllowed(license: string): boolean {
  if (license === "UNKNOWN") return false
  // Strip parens, split on AND/OR, every leaf must be in the allowlist.
  const cleaned = license.replace(/[()]/g, "").trim()
  const leaves = cleaned.split(/\s+(?:AND|OR)\s+/i)
  return leaves.every((leaf) => ALLOWED_LICENSES.has(leaf.trim()))
}

function collectDependencies(): Set<string> {
  // Production-only set: walk dependencies (not devDependencies) starting
  // from the root package.json, recursively. Each visited package's own
  // `dependencies` (no devDependencies) feeds the queue.
  const root = readJson<PackageJson>("package.json")
  if (!root) {
    throw new Error("package.json not found at cwd")
  }
  const visited = new Set<string>()
  const queue: Array<string> = Object.keys(root.dependencies ?? {})

  while (queue.length > 0) {
    const name = queue.shift()!
    if (visited.has(name)) continue
    visited.add(name)
    const pkgPath = path.join("node_modules", name, "package.json")
    const pkg = readJson<PackageJson>(pkgPath)
    if (!pkg) continue
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!visited.has(dep)) queue.push(dep)
    }
  }
  return visited
}

interface ScanRow {
  name: string
  version: string
  license: string
  allowed: boolean
}

function scan(deps: Set<string>): Array<ScanRow> {
  const rows: Array<ScanRow> = []
  for (const name of deps) {
    const pkg = readJson<PackageJson>(
      path.join("node_modules", name, "package.json"),
    )
    if (!pkg) {
      rows.push({ name, version: "unknown", license: "UNKNOWN", allowed: false })
      continue
    }
    const license = extractLicense(pkg)
    rows.push({
      name,
      version: pkg.version ?? "unknown",
      license,
      allowed: isAllowed(license),
    })
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

function buildBom(rows: Array<ScanRow>, rootName: string, rootVersion: string) {
  const components: Array<BomComponent> = rows.map((r) => ({
    type: "library",
    "bom-ref": `pkg:npm/${r.name}@${r.version}`,
    name: r.name,
    version: r.version,
    purl: `pkg:npm/${r.name}@${r.version}`,
    licenses: [
      r.license !== "UNKNOWN"
        ? { license: { id: r.license } }
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
} {
  let output = "SBOM.cdx.json"
  let failOnLicense = true
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--output") {
      output = argv[++i]
    } else if (argv[i] === "--no-fail-on-license") {
      failOnLicense = false
    }
  }
  return { output, failOnLicense }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2))
  const root = readJson<PackageJson>("package.json")
  if (!root) {
    console.error("package.json not found")
    return 1
  }
  const deps = collectDependencies()
  const rows = scan(deps)

  const bom = buildBom(
    rows,
    root.name ?? "unknown",
    root.version ?? "0.0.0",
  )
  fs.writeFileSync(args.output, JSON.stringify(bom, null, 2) + "\n")

  const denied = rows.filter((r) => !r.allowed)
  console.log(`SBOM written: ${args.output}`)
  console.log(`Production dependencies scanned: ${rows.length}`)
  console.log(`Disallowed licenses: ${denied.length}`)
  if (denied.length > 0) {
    console.log("")
    console.log("Disallowed:")
    for (const r of denied) {
      console.log(`  ${r.name}@${r.version}  ${r.license}`)
    }
    if (args.failOnLicense) return 1
  }
  return 0
}

process.exit(main())
