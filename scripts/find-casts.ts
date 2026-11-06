#!/usr/bin/env bun
/**
 * Inventory TypeScript assertions with the compiler API, classified by how
 * dangerous they are.
 *
 *   bun run casts            # casts under src/ (default)
 *   bun run casts /tests/    # narrow to a path substring
 *   bun run casts ''         # everything the tsconfig program includes
 *   bun run casts:check      # fail on unjustified any→concrete casts
 *
 * The syntax (`x as T`) is easy to find, but the useful signal is semantic:
 * whether the asserted value is already `any`, such as an unvalidated
 * `JSON.parse()` or `response.json()` result. That requires a full TypeScript
 * Program and type checker rather than a text search.
 *
 * Categories, most dangerous first:
 *   - DOUBLE          `x as unknown as T` / `as any as T`
 *   - FROM any        unvalidated source asserted into a trusted shape
 *   - from unknown    source is honestly typed as unknown
 *   - other           concrete-to-concrete local narrowing
 *
 * `as const` is excluded because it narrows a literal rather than asserting a
 * boundary shape.
 *
 * The `--check` gate fails when `any` is asserted into a target with required,
 * non-unknown fields. A deliberately retained cast must explain why on its own
 * line or the line immediately above it:
 *
 *   // casts-keep: <why this any→concrete cast is safe>
 *   const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
 */
import path from "node:path"
import * as ts from "typescript"

const argv = process.argv.slice(2)
const CHECK = argv.includes("--check")
const scope = argv.find((argument) => !argument.startsWith("--")) ?? "/src/"

const KEEP_RE = /casts-keep:\s*(\S.*?)\s*$/
const TOP = new Set([ts.SyntaxKind.UnknownKeyword, ts.SyntaxKind.AnyKeyword])

type Category = "DOUBLE" | "FROM any" | "from unknown" | "other"

interface Row {
  category: Category
  keep: string | null
  loc: string
  src: string
  targetKind: string
  text: string
  tgt: string
}

const configPath = ts.findConfigFile(
  process.cwd(),
  ts.sys.fileExists,
  "tsconfig.json",
)
if (!configPath) throw new Error(`no tsconfig.json found from ${process.cwd()}`)

const { config } = ts.readConfigFile(configPath, ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(
  config,
  ts.sys,
  path.dirname(configPath),
)
const program = ts.createProgram(parsed.fileNames, parsed.options)
const checker = program.getTypeChecker()
const rows: Array<Row> = []

/** Whether the target promises at least one required, non-unknown property. */
function targetIsConcrete(type: ts.Type): boolean {
  if ((type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0) {
    return false
  }
  if (type.isUnion()) {
    const nonNullish = type.types.filter(
      (member) =>
        (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0,
    )
    return nonNullish.every((member) => targetIsConcrete(member))
  }

  const properties = checker.getPropertiesOfType(type)
  if (properties.length > 0) {
    return properties.some((property) => {
      if ((property.flags & ts.SymbolFlags.Optional) !== 0) return false
      const declaration =
        property.valueDeclaration ?? property.declarations?.[0]
      if (!declaration) return true
      const propertyType = checker.getTypeOfSymbolAtLocation(
        property,
        declaration,
      )
      return (
        (propertyType.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) === 0
      )
    })
  }

  const indexInfos = checker.getIndexInfosOfType(type)
  if (indexInfos.length > 0) {
    return indexInfos.some(
      (index) =>
        (index.type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) === 0,
    )
  }

  return true
}

/** Read a `casts-keep:` reason from the cast's line or the line above it. */
function keepReason(lines: Array<string>, line: number): string | null {
  for (const candidate of [lines[line], lines[line - 1]]) {
    const match = candidate?.match(KEEP_RE)
    if (match) return match[1]
  }
  return null
}

for (const sourceFile of program.getSourceFiles()) {
  if (
    sourceFile.isDeclarationFile ||
    sourceFile.fileName.includes("node_modules")
  )
    continue
  if (!sourceFile.fileName.includes(scope)) continue
  const lines = sourceFile.text.split("\n")

  const visit = (node: ts.Node): void => {
    const isAs = ts.isAsExpression(node)
    const isAngle = node.kind === ts.SyntaxKind.TypeAssertionExpression
    if (isAs || isAngle) {
      const assertion = node as ts.AsExpression | ts.TypeAssertion
      const isConst =
        isAs && ts.isConstTypeReference((assertion as ts.AsExpression).type)
      if (!isConst) {
        const sourceType = checker.getTypeAtLocation(assertion.expression)
        const targetType = checker.getTypeFromTypeNode(assertion.type)
        const inner = assertion.expression
        const doubleTop = ts.isAsExpression(inner) && TOP.has(inner.type.kind)
        const category: Category = doubleTop
          ? "DOUBLE"
          : sourceType.flags & ts.TypeFlags.Any
            ? "FROM any"
            : sourceType.flags & ts.TypeFlags.Unknown
              ? "from unknown"
              : "other"
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(),
        )

        rows.push({
          category,
          keep: keepReason(lines, line),
          loc: `${path.relative(process.cwd(), sourceFile.fileName)}:${line + 1}`,
          src: checker.typeToString(sourceType),
          targetKind: targetIsConcrete(targetType) ? "concrete" : "loose",
          text: node.getText().replace(/\s+/g, " ").slice(0, 80),
          tgt: checker.typeToString(targetType),
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
}

const order: Array<Category> = ["DOUBLE", "FROM any", "from unknown", "other"]
rows.sort(
  (left, right) =>
    order.indexOf(left.category) - order.indexOf(right.category) ||
    left.loc.localeCompare(right.loc),
)

const isGated = (row: Row): boolean =>
  row.category === "FROM any" && row.targetKind === "concrete"

if (CHECK) {
  const gated = rows.filter(isGated)
  const kept = gated.filter((row) => row.keep)
  const unjustified = gated.filter((row) => !row.keep)

  for (const row of kept) console.log(`KEPT   ${row.loc}  — ${row.keep}`)
  if (unjustified.length > 0) {
    console.error(
      `\n✖ ${unjustified.length} unjustified any→concrete boundary cast(s) in ${scope || "all"}:`,
    )
    for (const row of unjustified) {
      console.error(`  ${row.loc}\t${row.src} -> ${row.tgt}\t${row.text}`)
    }
    console.error(
      `\nNarrow each value by validating the boundary, or add a ` +
        `"// casts-keep: <reason>" comment on or above the line if it is genuinely safe.`,
    )
    process.exit(1)
  }

  console.log(
    `\n✓ ${kept.length} known any→concrete cast(s) accounted for, 0 unjustified in ${scope || "all"}.`,
  )
  process.exit(0)
}

for (const row of rows) {
  console.log(
    `${row.loc}\t[${row.category}/${row.targetKind}]\t${row.src} -> ${row.tgt}\t${row.text}`,
  )
}

const counts = new Map<string, number>()
for (const row of rows) {
  const key =
    row.category === "FROM any" ? `FROM any (${row.targetKind})` : row.category
  counts.set(key, (counts.get(key) ?? 0) + 1)
}
console.log(`\n— summary (${scope || "all"}) —`)
for (const [key, count] of [...counts].sort(
  (left, right) => right[1] - left[1],
)) {
  console.log(`${String(count).padStart(4)}  ${key}`)
}
console.log(`${String(rows.length).padStart(4)}  TOTAL (excl. as-const)`)
