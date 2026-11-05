/**
 * Transcript normalisation: what varies between runs (ports, random ids,
 * timestamps, durations, secrets) becomes a stable placeholder so a whole
 * transcript can be compared with a committed snapshot.
 */

const ISO_TIME =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g
/** Random (non-fixture) UUIDs; fixture ids start with eight zeros. */
const UUID =
  /\b(?!0{8}-)[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi
const LOOPBACK_PORT = /\b(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\b/g
const DURATION = /\b\d+(?:\.\d+)? ?(ms|s|seconds)\b/g

export interface NormalizerOptions {
  /** Exact substrings (e.g. an origin) → their placeholder, longest first. */
  aliases?: Readonly<Record<string, string>>
  /** Secret values → placeholder (default `<secret>`). */
  secrets?: ReadonlyArray<string>
  /** Replace durations like `250 ms` / `3 s` with `<n> ms` (default true). */
  durations?: boolean
}

/** Stable placeholders for run-specific values. Mutable: add aliases as origins become known. */
export class Normalizer {
  readonly #aliases = new Map<string, string>()
  readonly #secrets = new Set<string>()
  readonly #ordinals = new Map<string, Map<string, number>>()
  readonly #durations: boolean

  constructor(options: NormalizerOptions = {}) {
    for (const [value, label] of Object.entries(options.aliases ?? {}))
      this.alias(value, label)
    for (const secret of options.secrets ?? []) this.secret(secret)
    this.#durations = options.durations ?? true
  }

  /** Replace every occurrence of `value` with `label`. */
  alias(value: string, label: string): this {
    if (value !== "") this.#aliases.set(value, label)
    return this
  }

  /** Mask `value` as `<secret>`. */
  secret(value: string): this {
    if (value !== "") this.#secrets.add(value)
    return this
  }

  get secrets(): ReadonlyArray<string> {
    return [...this.#secrets]
  }

  /** `<kind>#1`, `<kind>#2`, … in first-seen order (session ids, request ids). */
  ordinal(kind: string, raw: string): string {
    let seen = this.#ordinals.get(kind)
    if (!seen) {
      seen = new Map()
      this.#ordinals.set(kind, seen)
    }
    let index = seen.get(raw)
    if (index === undefined) {
      index = seen.size + 1
      seen.set(raw, index)
    }
    return `${kind}#${index}`
  }

  text(input: string): string {
    let text = input
    for (const secret of this.#secrets)
      text = text.replaceAll(secret, "<secret>")
    const aliases = [...this.#aliases].sort(([a], [b]) => b.length - a.length)
    for (const [value, label] of aliases) text = text.replaceAll(value, label)
    text = text
      .replaceAll(ISO_TIME, "<time>")
      .replaceAll(UUID, "<uuid>")
      .replaceAll(LOOPBACK_PORT, "$1:<port>")
    if (this.#durations) text = text.replaceAll(DURATION, "<n> $1")
    return text
  }

  /** Deep copy with every string (and object key) normalised. */
  value<T>(input: T): T {
    return this.#walk(input) as T
  }

  #walk(input: unknown): unknown {
    if (typeof input === "string") return this.text(input)
    if (Array.isArray(input)) return input.map((item) => this.#walk(item))
    if (input === null || typeof input !== "object") return input
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(input))
      out[this.text(key)] = this.#walk(item)
    return out
  }
}

/** Every secret that occurs in `value` (deep, after `JSON.stringify`). */
export function findSecrets(
  value: unknown,
  secrets: ReadonlyArray<string>,
): Array<string> {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return secrets.filter((secret) => secret !== "" && text.includes(secret))
}
