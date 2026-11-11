// Variant B render: monotone inside families only; cross-family routes may be non-monotone when the
// detour is ≤ 1.25× with ≤ 4 bends. Rendered locally (SVG/PNG), never written to the board.
import { planMap } from "./pipeline.ts"
import { toSvg } from "./svg.ts"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"

const L = JSON.parse(readFileSync(process.argv[2] ?? "fixtures/map-8-248.live.json", "utf8"))
const out = process.argv[3] ?? "out/variant-b"
mkdirSync(out, { recursive: true })
const R = await planMap(L, { policy: "B" })
R.name = "variant B (monotone inside families)"
;(R as any).swapPts = []
writeFileSync(`${out}/plan-b.json`, JSON.stringify(R))
writeFileSync(`${out}/variant-b.svg`, toSvg(R))
try { execFileSync("rsvg-convert", ["-w", "4000", "-o", `${out}/variant-b.png`, `${out}/variant-b.svg`]) } catch {}
console.log(JSON.stringify(R.checks))
process.exit(0)
