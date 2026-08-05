import { defineConfig } from 'vite'

// Main process bundle. Keep Electron + node builtins external.
export default defineConfig({
  build: {
    sourcemap: true,
    rollupOptions: {
      external: [/^node:/, 'electron'],
      output: { entryFileNames: 'main.js' },
    },
  },
})
