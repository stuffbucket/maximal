import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Renderer. Root is src/renderer; outDir must be absolute when overriding root
// or Vite misdirects the output away from the package.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  plugins: [react()],
  server: {
    fs: {
      // Renderer fonts are shared from the repository-level neutral UI assets.
      allow: [resolve(import.meta.dirname, '..')],
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, '.vite/renderer/main_window'),
    emptyOutDir: true,
  },
})
