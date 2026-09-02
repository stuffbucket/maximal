import { VitePlugin } from '@electron-forge/plugin-vite'
import type { ForgeConfig } from '@electron-forge/shared-types'

// This config NEVER signs, and must not learn how.
//
// stuffbucket/macos-builder runs the producer with its signing keychain LOCKED
// and SIGN_IDENTITY set to the ad-hoc identity "-", so a packager configured to
// sign fails with "No identity found for signing." That failure is the point:
// untrusted client code can never reach the Developer ID.
//
// The builder signs the finished bundle instead — `sign_walk = bun-runtime` in
// .macos-builder/config walks every nested code item deepest-first, then seals
// the outer bundle.

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
