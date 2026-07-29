// Canonical order, titles, and one-line blurbs for the user guide surfaced at
// /guide. The Markdown source lives in docs/guide/*.md (a content collection;
// see site/src/content.config.ts). Keep this in sync with docs/guide/README.md.
export const GUIDE_NAV = [
  {
    slug: "overview",
    title: "What is maximal?",
    blurb: "The one-paragraph version — what it does and who it's for.",
  },
  {
    slug: "install",
    title: "Install maximal",
    blurb: "Homebrew or the menu-bar app, on macOS.",
  },
  {
    slug: "connect-copilot",
    title: "Connect GitHub Copilot",
    blurb: "Sign in with GitHub so maximal can use your plan.",
  },
  {
    slug: "connect-your-tools",
    title: "Connect your tools",
    blurb: "Point Claude Code, Codex, opencode, and SDK clients at maximal.",
  },
  {
    slug: "how-it-works",
    title: "How maximal works",
    blurb: "The whole idea, step by step.",
  },
  {
    slug: "usage-and-settings",
    title: "Usage and settings",
    blurb: "A map of every section in the app.",
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting and FAQ",
    blurb: "Fixes for the common snags, and quick answers.",
  },
] as const;

export function guideTitle(slug: string): string {
  return GUIDE_NAV.find((n) => n.slug === slug)?.title ?? slug;
}
