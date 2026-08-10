import { defineConfig } from '@playwright/test'

// Packaged-app E2E only — see e2e/packaged-app.spec.ts. Deliberately separate
// from vitest.config.ts's unit suite: this one needs `npm run package` to
// have already produced client/out/**, drives a REAL packaged app process
// (relocated outside the repo first — see e2e/support/relocate-app.ts), and
// is far slower than the unit tests (real Electron + sidecar boot).
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // One shared app launch per file (see beforeAll in packaged-app.spec.ts) —
  // running files in parallel would multiply packaged-app boot time for no
  // extra coverage, and there is currently only one spec file.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
})
