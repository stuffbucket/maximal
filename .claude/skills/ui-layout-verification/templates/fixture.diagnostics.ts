import type { Page } from "@playwright/test"

// Route-stub the settings data endpoints so an island renders deterministic
// content. Copy and adapt this file with island.spec.ts.

export async function stubDiagnostics(page: Page): Promise<void> {
  await page.route("**/settings/api/diagnostics", (route) =>
    route.fulfill({ json: DIAGNOSTICS }),
  )
  await page.route("**/settings/api/update-status", (route) =>
    route.fulfill({ json: UPDATE_STATUS }),
  )
}

export const DIAGNOSTICS = {
  version: "1.2.3",
  source_revision: "abcdef0",
  source_branch: "main",
  launch_path: "/Applications/Maximal.app/Contents/MacOS/maximal",
  launch_kind: "dmg-app" as const,
  pid: 4242,
  uptime_ms: 65_000,
  account_type: "individual",
  models_cached: 12,
  tokens: { github_token_present: true, copilot_token_present: true },
  rate_limit: {
    interval_seconds: null,
    last_request_at: null,
    wait_when_throttled: false,
  },
  web_search: { kind: "CopilotResponsesExecutor", detail: "gpt-5-mini" },
  context_management: {
    advertised: [{ model: "claude-opus-5", support: true }],
    cache: {
      policy: "rejections-only" as const,
      entries: [
        {
          model: "claude-opus-4.7",
          strategy: "clear_thinking_20251015",
          rejected_at: "2026-09-19T00:00:00.000Z",
        },
      ],
    },
  },
}

export const UPDATE_STATUS = {
  current: "1.2.3",
  latest: "1.2.3",
  update_available: false,
  url: "https://mxml.sh",
  update_command: null,
  enabled: true,
  checked_at: null,
  last_error: null,
}
