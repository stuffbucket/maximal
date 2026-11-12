import { describe, expect, test } from "bun:test"

import {
  formatAgo,
  renderRemoteUsage,
  type UsageData,
} from "../shell/src/dashboard/usage-quotas"

const NOW = 1_800_000_000_000
const options = { quotaMoreOpen: false, now: NOW }

const data: UsageData = {
  quota_snapshots: {
    chat: {
      entitlement: 0,
      remaining: 0,
      percent_remaining: 100,
      unlimited: true,
    },
    premium_interactions: {
      entitlement: 300,
      remaining: 112,
      percent_remaining: 37.3,
      unlimited: false,
    },
  },
}

describe("renderRemoteUsage", () => {
  test("ready quotas render in full colour with no status line", () => {
    const html = renderRemoteUsage(
      { status: "ready", snapshot: { data, fetchedAt: NOW - 60_000 } },
      options,
    )
    expect(html).toContain("62.7% Used")
    expect(html).toContain("quota-progress--ok")
    expect(html).not.toContain("usage-quotas--unavailable")
    expect(html).not.toContain("usage-status")
  })

  test("a stale snapshot is kept, greyed, under an 'Updated … ago' line", () => {
    const html = renderRemoteUsage(
      {
        status: "unavailable",
        snapshot: { data, fetchedAt: NOW - 12 * 60_000 },
        reason:
          "Request failed with status 504: GitHub didn't respond in time.",
      },
      options,
    )
    // The numbers stay…
    expect(html).toContain("62.7% Used")
    expect(html).toContain("188 / 300")
    // …greyed, with a quiet line saying how old they are.
    expect(html).toContain(
      'class="dashboard-bento__body usage-quotas--unavailable"',
    )
    expect(html).toContain("Updated 12 minutes ago · reconnecting to GitHub")
    // The raw failure is only the hover text, and nothing reads as an error.
    expect(html).toContain(
      'title="Request failed with status 504: GitHub didn&#39;t respond in time."',
    )
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain("failed</")
  })

  test("with no data yet, the layout renders greyed with placeholders", () => {
    const html = renderRemoteUsage(
      { status: "unavailable", snapshot: null, reason: "boom" },
      options,
    )
    expect(html).toContain("usage-quotas--unavailable")
    expect(html).toContain("Waiting for GitHub usage…")
    expect(html).toContain("premium interactions")
    expect(html).toContain("quota-progress--unknown")
    expect(html).toContain(">—</output>")
    expect(html).not.toContain("% Used")
    expect(html).not.toContain('role="alert"')
  })

  test("the first read in flight looks the same as no data yet", () => {
    const html = renderRemoteUsage(
      { status: "unavailable", snapshot: null },
      options,
    )
    expect(html).toContain("Waiting for GitHub usage…")
    expect(html).toContain('<p class="usage-status">')
  })

  test("signed out points to Account settings without owning sign-in", () => {
    const html = renderRemoteUsage({ status: "signed-out" }, options)
    expect(html).toContain("usage-signed-out")
    expect(html).toContain("Account setup required")
    expect(html).toContain("Sign-in and account setup are handled in Settings.")
    expect(html).toContain('data-usage-action="open-account-settings"')
    expect(html).toContain("Open Account settings")
    expect(html).not.toContain("Sign in to GitHub")
    expect(html).not.toContain("usage-quotas--unavailable")
  })

  test("nothing renders before the first request", () => {
    expect(renderRemoteUsage({ status: "idle" }, options)).toBe("")
  })
})

describe("formatAgo", () => {
  test("rounds to whole minutes (at least one), then hours, then days", () => {
    expect(formatAgo(10_000)).toBe("1 minute ago")
    expect(formatAgo(12 * 60_000)).toBe("12 minutes ago")
    expect(formatAgo(3 * 3_600_000)).toBe("3 hours ago")
    expect(formatAgo(2 * 86_400_000)).toBe("2 days ago")
  })
})
