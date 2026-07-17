/**
 * find-casts.ts — inventory every TypeScript type assertion in the project via
 * the compiler API, classified by how dangerous it is.
 *
 *   bun run casts            # casts under src/ (default)
 *   bun run casts /tests/    # narrow to a path substring
 *   bun run casts ''         # everything the tsconfig program includes
 *
 * Why the compiler API and not grep: the *syntax* (`x as T`) is easy to match,
 * but the useful signal is *semantic* — is the value being cast already `any`
 * (an unvalidated boundary like `JSON.parse(...)` / `response.json()`)? Only the
 * type checker knows that, and it needs a full Program, not a lone SourceFile.
 *
 * Categories, most-dangerous first:
 *   - DOUBLE          `x as unknown as T` / `as any as T` — laundered through a
 *                     top type to defeat the checker's "unrelated types" guard.
 *   - FROM any        the source type is `any` — an unvalidated external boundary
 *                     cast into a trusted shape (the class behind the interval:NaN
 *                     device-code bug). Casting to a REQUIRED-field concrete type
 *                     over-promises; casting to a loose `{ f?: unknown }` shape is
 *                     defensive — the `targetKind` column distinguishes them.
 *   - from unknown    source is `unknown` (a wrapper already narrowed it; the
 *                     cast is at least honest about being unchecked).
 *   - other           concrete → concrete (local narrows, union refinements).
 *
 * `as const` is excluded (it's a literal-narrowing directive, not an assertion).
 * Dev diagnostic only — not wired into CI.
 */
import * as ts from "typescript"
import path from "node:path"

const scope = process.argv[2] ?? "/src/"

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

const TOP = new Set([ts.SyntaxKind.UnknownKeyword, ts.SyntaxKind.AnyKeyword])

type Category = "DOUBLE" | "FROM any" | "from unknown" | "other"
interface Row {
  loc: string
  category: Category
  /** "concrete" if the target has any required non-`unknown` member, else "loose". */
  targetKind: string
  src: string
  tgt: string
  text: string
}

const rows: Row[] = []

/** Does the target type promise a required, non-`unknown` property? Those are
 *  the over-promising casts (the runtime can lack the field); a target whose
 *  members are all optional / `unknown` is defensive and lower-risk. */
function targetIsConcrete(type: ts.Type): boolean {
  const props = checker.getPropertiesOfType(type)
  if (props.length === 0) return true // a plain named type (e.g. GhHostsJson)
  return props.some((p) => {
    const optional = (p.flags & ts.SymbolFlags.Optional) !== 0
    if (optional) return false
    const decl = p.valueDeclaration ?? p.declarations?.[0]
    if (!decl) return true // required prop we can't introspect → treat as concrete
    const t = checker.getTypeOfSymbolAtLocation(p, decl)
    const topOnly = (t.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0
    return !topOnly
  })
}

for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || sf.fileName.includes("node_modules")) continue
  if (!sf.fileName.includes(scope)) continue

  const visit = (node: ts.Node): void => {
    const isAs = ts.isAsExpression(node)
    const isAngle = node.kind === ts.SyntaxKind.TypeAssertionExpression
    if (isAs || isAngle) {
      const n = node as ts.AsExpression | ts.TypeAssertion
      const isConst = isAs && ts.isConstTypeReference((n as ts.AsExpression).type)
      if (!isConst) {
        const srcType = checker.getTypeAtLocation(n.expression)
        const tgtType = checker.getTypeFromTypeNode(n.type)

        const inner = n.expression
        const doubleTop = ts.isAsExpression(inner) && TOP.has(inner.type.kind)

        const category: Category =
          doubleTop ? "DOUBLE"
          : srcType.flags & ts.TypeFlags.Any ? "FROM any"
          : srcType.flags & ts.TypeFlags.Unknown ? "from unknown"
          : "other"

        const { line } = sf.getLineAndCharacterOfPosition(node.getStart())
        rows.push({
          loc: `${path.relative(process.cwd(), sf.fileName)}:${line + 1}`,
          category,
          targetKind: targetIsConcrete(tgtType) ? "concrete" : "loose",
          src: checker.typeToString(srcType),
          tgt: checker.typeToString(tgtType),
          text: node.getText().replace(/\s+/g, " ").slice(0, 80),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

const ORDER: Category[] = ["DOUBLE", "FROM any", "from unknown", "other"]
rows.sort(
  (a, b) =>
    ORDER.indexOf(a.category) - ORDER.indexOf(b.category) ||
    a.loc.localeCompare(b.loc),
)

for (const r of rows) {
  console.log(
    `${r.loc}\t[${r.category}/${r.targetKind}]\t${r.src} -> ${r.tgt}\t${r.text}`,
  )
}

const counts = new Map<string, number>()
for (const r of rows) {
  const key = r.category === "FROM any" ? `FROM any (${r.targetKind})` : r.category
  counts.set(key, (counts.get(key) ?? 0) + 1)
}
console.log(`\n— summary (${scope || "all"}) —`)
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(v).padStart(4)}  ${k}`)
}
console.log(`${String(rows.length).padStart(4)}  TOTAL (excl. as-const)`)
