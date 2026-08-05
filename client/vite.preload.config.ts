import { defineConfig } from 'vite'

// Preload must be CommonJS (a sandboxed preload cannot use ESM).
export default defineConfig({
  build: {
    sourcemap: 'inline',
    rollupOptions: {
      external: [/^node:/, 'electron'],
      output: { entryFileNames: 'preload.js', format: 'cjs' },
    },
  },
})
