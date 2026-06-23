/**
 * Compile-time build metadata.
 *
 * Values are injected by `bun build --compile --define ...` for
 * release binaries (see release.yml). When unset — running source
 * via `bun src/main.ts`, or after a stock `bun build` without the
 * defines — we fall back to package.json's version and leave the
 * git SHA undefined (the live `.git` walk in src/lib/version.ts
 * picks it up in dev).
 *
 * Why globals + --define instead of build-time codegen: identical
 * effect, no .gen.ts file to gitignore, no extra prebuild script
 * to keep wired into every place that runs the code (CI, IDE,
 * postinstall, dev). Bun's --define honors literal substitution
 * at bundle time IFF the bare identifier appears in source — it
 * does NOT walk through `globalThis[name]` lookups. So we read
 * the bare identifier directly here, with declarations below to
 * keep TypeScript happy and a `typeof` guard so the dev path
 * (where the substitution didn't happen) doesn't ReferenceError.
 */

import packageJson from "../../package.json" with { type: "json" }

declare const __MAXIMAL_VERSION__: string
declare const __MAXIMAL_GIT_SHA__: string
declare const __MAXIMAL_GIT_BRANCH__: string
declare const __MAXIMAL_CHANNEL__: string

export const BUILD_VERSION: string =
  typeof __MAXIMAL_VERSION__ === "string" && __MAXIMAL_VERSION__.length > 0 ?
    __MAXIMAL_VERSION__
  : packageJson.version

export const BUILD_GIT_SHA: string | undefined =
  typeof __MAXIMAL_GIT_SHA__ === "string" && __MAXIMAL_GIT_SHA__.length > 0 ?
    __MAXIMAL_GIT_SHA__
  : undefined

export const BUILD_GIT_BRANCH: string | undefined =
  (
    typeof __MAXIMAL_GIT_BRANCH__ === "string"
    && __MAXIMAL_GIT_BRANCH__.length > 0
  ) ?
    __MAXIMAL_GIT_BRANCH__
  : undefined

/**
 * The release channel this build follows (`stable`, `beta`, …). Injected by
 * `--define __MAXIMAL_CHANNEL__` for release/beta binaries; defaults to
 * `stable` for source runs and stock builds. The update manifest is
 * channel-keyed, so this is what decides which channel's version a build
 * polls (see src/lib/update-check.ts).
 */
export const BUILD_CHANNEL: string =
  typeof __MAXIMAL_CHANNEL__ === "string" && __MAXIMAL_CHANNEL__.length > 0 ?
    __MAXIMAL_CHANNEL__
  : "stable"
