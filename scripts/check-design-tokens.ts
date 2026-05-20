#!/usr/bin/env bun
/**
 * Design-token drift gate.
 *
 * Enforces the rules in .design-context.md that aren't naturally
 * expressible in stylelint, by scanning CSS for the specific
 * (token, allowed-selector) pairs we care about and flagging
 * everything else.
 *
 * Current rules:
 *
 *   --text-xs (0.75rem / 12px) is reserved for glyph-only contexts
 *   per design-context: "Body text: minimum size --text-base (16px);
 *   Settings: --text-base for control labels, --text-sm for
 *   descriptions." Only `.kbd` (keycap badge) is permitted to use it.
 *
 * Why a script and not stylelint:
 *   - stylelint's `declaration-property-value-disallowed-list` is
 *     selector-blind; it can't say "allowed inside .kbd."
 *   - a custom stylelint plugin is overkill for a handful of
 *     project-specific rules.
 *   - bun runs it in <100ms and the output is grep-friendly.
 *
 * Exit code 0 = clean, 1 = at least one violation. Wired into
 * `bun run lint:fast` so it runs alongside oxlint + tsc + eslint.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

interface Violation {
  file: string
  selector: string
  line: number
  token: string
  rule: string
}

interface Rule {
  /** Token name as it appears in CSS (e.g. "--text-xs"). */
  token: string
  /** Selectors permitted to use the token. Regex matched against
   *  the trimmed selector list of the containing rule. */
  allow: Array<RegExp>
  /** One-line rationale shown in violation output. */
  why: string
}

const RULES: Array<Rule> = [
  {
    token: "--text-xs",
    allow: [/\.kbd\b/],
    why: ".design-context.md: --text-xs reserved for glyph contexts only (e.g. .kbd keycap). Settings should use --text-sm (14px) as the floor.",
  },
]

const FILES: Array<string> = [
  "shell/src/styles.css",
  // Add other CSS files here as the project grows. Skill templates
  // (.claude/skills/**) are intentionally NOT scanned — they're
  // reference snippets, not shipped code.
]

const REPO = resolve(import.meta.dir, "..")

function check(file: string): Array<Violation> {
  const path = resolve(REPO, file)
  const src = readFileSync(path, "utf8")
  const violations: Array<Violation> = []

  // Walk CSS rules without a full parser. The pattern we look for
  // is `<selector> { … }` where the body contains `var(<token>)`.
  // CSS comments are stripped first so a /* ban var(--text-xs) */
  // example in a comment doesn't trigger.
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    " ".repeat(m.length),
  )

  // Find `selector { body }` pairs at any nesting depth. The CSS
  // here is flat (no nesting), so a non-greedy `{...}` match is
  // sufficient.
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = ruleRe.exec(stripped)) !== null) {
    const selector = m[1].trim()
    const body = m[2]
    const ruleStart = m.index
    for (const rule of RULES) {
      const ref = `var(${rule.token})`
      if (!body.includes(ref)) continue
      if (rule.allow.some((re) => re.test(selector))) continue
      const offset = ruleStart + m[1].length + 1 + body.indexOf(ref)
      const line = src.slice(0, offset).split("\n").length
      violations.push({
        file,
        selector,
        line,
        token: rule.token,
        rule: rule.why,
      })
    }
  }
  return violations
}

function main(): void {
  const all: Array<Violation> = []
  for (const file of FILES) {
    all.push(...check(file))
  }
  if (all.length === 0) {
    console.log(
      `[check-design-tokens] clean (${FILES.length} file${FILES.length === 1 ? "" : "s"} scanned, ${RULES.length} rule${RULES.length === 1 ? "" : "s"})`,
    )
    process.exit(0)
  }
  console.error(
    `[check-design-tokens] ${all.length} violation${all.length === 1 ? "" : "s"}:`,
  )
  for (const v of all) {
    console.error(
      `  ${v.file}:${v.line}  ${v.token} used in \`${v.selector.replace(/\s+/g, " ")}\``,
    )
    console.error(`    ${v.rule}`)
  }
  process.exit(1)
}

main()
