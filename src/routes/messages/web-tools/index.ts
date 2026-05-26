/**
 * Public surface of the web-tools subpackage.
 *
 * Only symbols imported from OUTSIDE this directory belong here.
 * Intra-package modules import each other directly (e.g. `./state`),
 * not through this barrel — keeps the dependency graph readable and
 * avoids cycles.
 */

export { handleWithWebToolsAgent } from "./flow"
export { splitWebTools } from "./rewriter"
