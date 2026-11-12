/** Keep build output out of Vite's watcher while allowing staged `.ui` changes
 * to trigger the preview reload that refreshes window-story iframes. */
export function ignoreStorybookWatchPath(file: string): boolean {
  return /[\\/]storybook-static([\\/]|$)/.test(file);
}
