import { existsSync } from 'node:fs'

import { VitePlugin } from '@electron-forge/plugin-vite'
import type { ForgeConfig } from '@electron-forge/shared-types'
import type { OsxSignOptions } from '@electron/packager'

// macOS inside-out signing is driven here (invoked by @electron/osx-sign during
// `electron-forge package`) and ENABLED ONLY when SIGN_IDENTITY is present. The
// private stuffbucket/macos-builder producer (.macos-builder/build.sh) exports
// SIGN_IDENTITY plus MACOS_ENTITLEMENTS (pointing at the builder-owned
// bun-runtime.entitlements). A bare local `bun run package` leaves both unset and
// produces an UNSIGNED app for dev. An Electron .app has nested Helper apps + the
// Electron Framework, so it must be signed inside-out — the builder's top-level
// sign alone is not enough, hence signing happens here during packaging.
const identity = process.env.SIGN_IDENTITY
const entitlements = process.env.MACOS_ENTITLEMENTS

if (identity && (!entitlements || !existsSync(entitlements))) {
  throw new Error(`MACOS_ENTITLEMENTS must name an existing file when SIGN_IDENTITY is set (got ${String(entitlements)})`)
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Must EQUAL the approved builder policy's bundle_id_allowed
    // (co.stuffbucket.maximal); otherwise Electron defaults to a wrong
    // CFBundleIdentifier and the builder's per-repo policy gate rejects the build.
    appBundleId: 'co.stuffbucket.maximal',
    appCategoryType: 'public.app-category.developer-tools',
    icon: 'build/icon', // Forge appends the platform extension (.icns on macOS)
    // maximal-core ships as a compiled Bun sidecar under resources/bin and is
    // copied into the packaged app at Contents/Resources/bin — OUTSIDE the asar,
    // so it stays a real, spawnable, signable executable; the client spawns it.
    extraResource: ['resources/bin'],
    ...(identity
      ? {
          osxSign: {
            identity,
            // Electron Packager defaults this to true, which can report a
            // successful package after signing failed and left a partial app.
            continueOnError: false,
            // osx-sign 1.3.3 follows framework `Versions/Current` symlinks while
            // walking, then attempts to sign the same binary-looking resources
            // twice. Sign the canonical `Versions/A` tree and skip only aliases.
            ignore: (filePath) => filePath.includes('/Versions/Current/'),
            // Apply bun-runtime entitlements + hardened runtime UNIFORMLY to every
            // signed component (app, Helper apps, Electron Framework, and the Bun
            // sidecar). bun-runtime is a superset that satisfies all of them:
            // allow-jit + allow-unsigned-executable-memory (Electron V8 AND
            // Bun/JavaScriptCore) + disable-library-validation (spawn the
            // separately-signed sidecar, load Bun's bundled libs) + network.
            optionsForFile: () => ({ entitlements, hardenedRuntime: true }),
          } as OsxSignOptions & { continueOnError: false },
        }
      : {}),
  },
  makers: [], // the private macos-builder packages the .dmg; we only build the .app
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
  ],
}

export default config
