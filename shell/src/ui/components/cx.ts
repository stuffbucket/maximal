// vendored: lightweight classname joiner — replaces clsx for our use.
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ")
}
