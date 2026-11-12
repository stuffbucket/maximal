/**
 * Section ids that were renamed. Old links, bookmarks and the remembered last
 * tab still carry the old id, so each one maps to the id that replaced it.
 * `#budget` is the Rules surface's former name.
 */
const SECTION_ALIASES: Readonly<Record<string, string>> = {
  budget: "rules",
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
