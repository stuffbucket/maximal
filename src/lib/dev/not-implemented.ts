/**
 * Scaffolding marker for the single-window redesign (docs/spec/single-window-redesign.md).
 *
 * Modules created during the "wire the shapes first" pass delegate their bodies
 * here so that:
 *   - `tsc` is satisfied (this returns `never`, assignable to any return type);
 *   - `noUnusedParameters` is satisfied (pass the params in `refs` so they read
 *     as used without the body actually consuming them);
 *   - a grep for `notImplemented(` enumerates every stub still to be filled in.
 *
 * Delete this module once every call site is implemented.
 */
export function notImplemented(
  name: string,
  _refs?: Record<string, unknown>,
): never {
  throw new Error(
    `TODO(single-window): ${name} is scaffolded but not implemented`,
  )
}
