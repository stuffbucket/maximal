import { VitePlugin } from '@electron-forge/plugin-vite'
import type { ForgeConfig } from '@electron-forge/shared-types'

// Minimal Forge config for the maximal client. The engine (maximal-core) ships
// as a compiled sidecar binary under resources/bin and is copied into the
// packaged app via extraResource; the client spawns it at runtime.
const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource: ['resources/bin'],
  },
  makers: [],
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
