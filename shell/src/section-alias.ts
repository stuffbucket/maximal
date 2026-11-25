/**
 * Section ids that were renamed or folded into another. Old links, bookmarks
 * and the remembered last tab still carry the old id, so each one maps to the
 * id that replaced it. `#budget` is the Rules surface's former name; `#logs`
 * is now part of the one System section (`#diagnostics`).
 */
const SECTION_ALIASES: Readonly<Record<string, string>> = {
  budget: "rules",
  logs: "diagnostics",
};

/** The current id for a section id, which is itself when it was never renamed. */
export function canonicalSection(id: string): string {
  return Object.hasOwn(SECTION_ALIASES, id) ? SECTION_ALIASES[id]! : id;
}

/**
 * A location hash with its section canonicalised and any sub-page kept
 * (`#budget` becomes `#rules`, `#connectors/workiq` is unchanged). A hash that
 * is already current comes back as it is.
 */
export function canonicalHash(hash: string): string {
  const [section = "", ...rest] = hash.replace(/^#/, "").split("/");
  return `#${[canonicalSection(section), ...rest].join("/")}`;
}
