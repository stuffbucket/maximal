/**
 * Filter members: an exact name or a simple glob. `*` matches any run of
 * characters (none included) and `?` exactly one; every other character is
 * literal, and matching is case-sensitive and whole-string. SQLite's `GLOB`
 * means the same (`globToSqlite`), so the ledger and the database agree.
 */

const compiled = new Map<string, RegExp>()

function regexpOf(pattern: string): RegExp {
  let regexp = compiled.get(pattern)
  if (regexp === undefined) {
    const source = pattern
      .replaceAll(/[$()+.[\\\]^{|}]/gu, String.raw`\$&`)
      .replaceAll("*", ".*")
      .replaceAll("?", ".")
    regexp = new RegExp(`^${source}$`, "su")
    compiled.set(pattern, regexp)
  }
  return regexp
}

export function globMatches(pattern: string, value: string): boolean {
  return regexpOf(pattern).test(value)
}

/** The pattern for SQLite's `GLOB`, where `[` would otherwise open a set. */
export function globToSqlite(pattern: string): string {
  return pattern.replaceAll("[", "[[]")
}
