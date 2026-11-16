/** Keep build output out of Vite's watcher while allowing staged `.ui` changes
 * to trigger the preview reload that refreshes window-story iframes. */
export function ignoreStorybookWatchPath(file: string): boolean {
  return /[\\/]storybook-static([\\/]|$)/.test(file);
}

/** Ignore static sources copied by build-ui: reading them can produce macOS
 * change events, which would otherwise make the Storybook restager loop. */
export function ignoreStorybookRestagePath(file: string): boolean {
  return (
    /(^|[\\/])vendor([\\/]|$)/.test(file) ||
    /(^|[\\/])ui[\\/]features[\\/]apps[\\/]icons([\\/]|$)/.test(file)
  );
}
