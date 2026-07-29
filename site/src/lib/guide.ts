// Canonical order + titles for the user guide surfaced at /guide.
// The Markdown source lives in docs/guide/*.md (a content collection; see
// site/src/content.config.ts). Keep this order in sync with docs/guide/README.md.
export const GUIDE_NAV = [
  { slug: "overview", title: "What is maximal?" },
  { slug: "install", title: "Install maximal" },
  { slug: "connect-copilot", title: "Connect GitHub Copilot" },
  { slug: "connect-your-tools", title: "Connect your tools" },
  { slug: "how-it-works", title: "How maximal works" },
  { slug: "usage-and-settings", title: "Usage and settings" },
  { slug: "troubleshooting", title: "Troubleshooting and FAQ" },
] as const;

export function guideTitle(slug: string): string {
  return GUIDE_NAV.find((n) => n.slug === slug)?.title ?? slug;
}
