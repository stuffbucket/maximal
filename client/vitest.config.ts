import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Two projects because main-process code (Node APIs, `electron` module) and
// renderer code (DOM globals, React) need different test environments — one
// `environment: 'node'` config for both would either give the renderer no
// `window`/`document`, or give the main process a fake DOM it never has.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: [
            'src/main/**/*.test.ts',
            'src/preload/**/*.test.ts',
            'src/shared/**/*.test.ts',
          ],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
})
