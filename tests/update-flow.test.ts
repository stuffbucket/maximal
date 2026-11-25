import { describe, expect, test } from "bun:test"

import type { InstallUpdateOutcome } from "../shell/src/tauri/install-update-outcome"
import type { UpdateStatusResponse } from "../src/lib/config/settings-types"

import {
  requestUpdateConfirmation,
  subscribeToUpdateConfirmations,
} from "../shell/src/ui/features/update/update-confirm"
import {
  updateButtonLabels,
  updateConfirmCopy,
} from "../shell/src/ui/features/update/update-copy"
import {
  createUpdateFlow,
  updateOffer,
  type UpdateOffer,
  type UpdatePhase,
} from "../shell/src/ui/features/update/update-flow"

/**
 * The one update flow behind the title-bar icon and the System button: every
 * start asks first, a "no" does nothing, a "yes" does exactly the one hand-off
 * the build supports (install in place, open the download page, or show the
 * apt command), and a second start while one is open or running is ignored.
 */

const STATUS: UpdateStatusResponse = {
  current: "0.4.36",
  latest: "0.4.40",
  update_available: true,
  url: "https://mxml.sh/",
  update_command: null,
  enabled: true,
  checked_at: "2026-11-16T00:00:00.000Z",
  last_error: null,
}

const APT = "sudo apt update && sudo apt install --only-upgrade maximal"

describe("updateOffer", () => {
  test("offers nothing without a newer release, with checks off, or without a version", () => {
    expect(updateOffer(null, true)).toBeNull()
    expect(updateOffer({ ...STATUS, update_available: false }, true)).toBeNull()
    expect(updateOffer({ ...STATUS, enabled: false }, true)).toBeNull()
    expect(updateOffer({ ...STATUS, latest: null }, true)).toBeNull()
  })

  test("installs in place only where the shell can", () => {
    expect(updateOffer(STATUS, true)).toEqual({
      version: "0.4.40",
      url: "https://mxml.sh/",
      route: "in-place",
    })
    expect(updateOffer(STATUS, false)?.route).toBe("download")
  })

  test("an apt install always hands off to the apt command", () => {
    expect(updateOffer({ ...STATUS, update_command: APT }, false)?.route).toBe(
      "apt",
    )
    expect(updateOffer({ ...STATUS, update_command: APT }, true)?.route).toBe(
      "apt",
    )
  })
})

interface Harness {
  calls: Array<string>
  phases: Array<UpdatePhase>
  confirm: (answer: boolean) => void
  finishInstall: (outcome: InstallUpdateOutcome) => void
  startDownloading: () => void
  flow: ReturnType<typeof createUpdateFlow>
}

function harness(): Harness {
  const calls: Array<string> = []
  const phases: Array<UpdatePhase> = []
  let answer: ((value: boolean) => void) | null = null
  let finish: ((outcome: InstallUpdateOutcome) => void) | null = null
  let downloading: (() => void) | null = null
  const flow = createUpdateFlow({
    confirm: (offer) => {
      calls.push(`confirm:${offer.route}:${offer.version}`)
      return new Promise<boolean>((resolve) => {
        answer = resolve
      })
    },
    installInPlace: (version, onDownloading) => {
      calls.push(`install:${version}`)
      downloading = onDownloading
      return new Promise<InstallUpdateOutcome>((resolve) => {
        finish = resolve
      })
    },
    openDownloadPage: (url) => {
      calls.push(`open:${url}`)
    },
    revealAptCommand: () => {
      calls.push("reveal-apt")
    },
    onPhaseChange: (phase) => {
      phases.push(phase)
    },
  })
  return {
    calls,
    phases,
    flow,
    confirm: (value) => answer?.(value),
    finishInstall: (outcome) => finish?.(outcome),
    startDownloading: () => downloading?.(),
  }
}

const offer = (route: UpdateOffer["route"]): UpdateOffer => ({
  version: "0.4.40",
  url: "https://mxml.sh/",
  route,
})

describe("createUpdateFlow", () => {
  test("does nothing when nothing is offered", async () => {
    const h = harness()
    await h.flow.start(null)
    expect(h.calls).toEqual([])
    expect(h.flow.phase).toBe("idle")
  })

  for (const route of ["in-place", "download", "apt"] as const) {
    test(`${route}: cancelling the confirmation performs no update or hand-off`, async () => {
      const h = harness()
      const run = h.flow.start(offer(route))
      expect(h.flow.phase).toBe("confirming")
      h.confirm(false)
      await run
      expect(h.calls).toEqual([`confirm:${route}:0.4.40`])
      expect(h.flow.phase).toBe("idle")
      expect(h.phases).toEqual(["confirming", "idle"])
    })
  }

  test("in-place: one confirmation, then the shell installs that exact version", async () => {
    const h = harness()
    const run = h.flow.start(offer("in-place"))
    h.confirm(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(h.calls).toEqual(["confirm:in-place:0.4.40", "install:0.4.40"])
    h.startDownloading()
    expect(h.flow.phase).toBe("downloading")
    h.finishInstall("cancelled")
    await run
    expect(h.flow.phase).toBe("idle")
    expect(h.phases).toEqual(["confirming", "downloading", "idle"])
    // Only one confirmation for the whole flow, and no page opened.
    expect(h.calls.filter((c) => c.startsWith("confirm:"))).toHaveLength(1)
    expect(h.calls.some((c) => c.startsWith("open:"))).toBe(false)
  })

  test("in-place: a build that can't install after all opens the page without asking again", async () => {
    const h = harness()
    const run = h.flow.start(offer("in-place"))
    h.confirm(true)
    await Promise.resolve()
    await Promise.resolve()
    h.finishInstall("unavailable")
    await run
    expect(h.calls).toEqual([
      "confirm:in-place:0.4.40",
      "install:0.4.40",
      "open:https://mxml.sh/",
    ])
  })

  for (const outcome of ["busy", "cancelled", "failed"] as const) {
    test(`in-place: a ${outcome} install opens nothing more`, async () => {
      const h = harness()
      const run = h.flow.start(offer("in-place"))
      h.confirm(true)
      await Promise.resolve()
      await Promise.resolve()
      h.finishInstall(outcome)
      await run
      expect(h.calls).toEqual(["confirm:in-place:0.4.40", "install:0.4.40"])
    })
  }

  test("download: confirming opens the download page once and installs nothing", async () => {
    const h = harness()
    const run = h.flow.start(offer("download"))
    h.confirm(true)
    await run
    expect(h.calls).toEqual([
      "confirm:download:0.4.40",
      "open:https://mxml.sh/",
    ])
    expect(h.flow.phase).toBe("idle")
  })

  test("apt: confirming reveals the command and neither installs nor opens a page", async () => {
    const h = harness()
    const run = h.flow.start(offer("apt"))
    h.confirm(true)
    await run
    expect(h.calls).toEqual(["confirm:apt:0.4.40", "reveal-apt"])
  })

  test("a second start while the confirmation is open is ignored", async () => {
    const h = harness()
    const first = h.flow.start(offer("in-place"))
    await h.flow.start(offer("in-place"))
    await h.flow.start(offer("download"))
    expect(h.calls).toEqual(["confirm:in-place:0.4.40"])
    h.confirm(false)
    await first
  })

  test("a second start while the update downloads is ignored", async () => {
    const h = harness()
    const first = h.flow.start(offer("in-place"))
    h.confirm(true)
    await Promise.resolve()
    await Promise.resolve()
    h.startDownloading()
    await h.flow.start(offer("in-place"))
    expect(h.calls).toEqual(["confirm:in-place:0.4.40", "install:0.4.40"])
    h.finishInstall("failed")
    await first
    // Idle again: the next start asks again.
    const again = h.flow.start(offer("in-place"))
    expect(h.calls.at(-1)).toBe("confirm:in-place:0.4.40")
    h.confirm(false)
    await again
  })
})

describe("update confirmation bridge", () => {
  test("fails closed when no dialog is mounted", async () => {
    expect(await requestUpdateConfirmation(offer("in-place"))).toBe(false)
  })

  test("hands the offer to the dialog and resolves with its answer", async () => {
    const seen: Array<UpdateOffer> = []
    const unsubscribe = subscribeToUpdateConfirmations((request) => {
      seen.push(request.offer)
      request.answer(true)
    })
    try {
      expect(await requestUpdateConfirmation(offer("apt"))).toBe(true)
      expect(seen).toEqual([offer("apt")])
    } finally {
      unsubscribe()
    }
    expect(await requestUpdateConfirmation(offer("apt"))).toBe(false)
  })
})

describe("update copy", () => {
  test("in-place uses the approved install-and-restart wording", () => {
    expect(updateConfirmCopy(offer("in-place"))).toEqual({
      title: "Update Maximal?",
      body: "Maximal will download and install 0.4.40, then restart. Requests in progress will stop.",
      confirmLabel: "Install and restart",
      cancelLabel: "Not now",
    })
  })

  test("download says the browser opens mxml.sh, and nothing about restarting", () => {
    const copy = updateConfirmCopy(offer("download"))
    expect(copy.title).toBe("Update Maximal?")
    expect(copy.confirmLabel).toBe("Open mxml.sh")
    expect(copy.cancelLabel).toBe("Not now")
    expect(copy.body).toContain("0.4.40")
    expect(copy.body).toContain("mxml.sh")
    expect(copy.body).not.toMatch(/restart|install and/iu)
  })

  test("apt explains the command is copied and run by hand, never that Maximal installs", () => {
    const copy = updateConfirmCopy(offer("apt"))
    expect(copy.title).toBe("Update Maximal?")
    expect(copy.confirmLabel).toBe("Show command")
    expect(copy.cancelLabel).toBe("Not now")
    expect(copy.body).toContain("0.4.40")
    expect(copy.body).toMatch(/copy/iu)
    expect(copy.body).toMatch(/terminal/iu)
    expect(copy.body).not.toMatch(/restart|will (?:download|install)/iu)
  })

  test("the icon is named for the version, and both entry points say when it downloads", () => {
    expect(updateButtonLabels(offer("in-place"), "idle")).toEqual({
      icon: "Update Maximal to 0.4.40",
      system: "Update to 0.4.40",
    })
    expect(updateButtonLabels(offer("apt"), "confirming")).toEqual({
      icon: "Update Maximal to 0.4.40",
      system: "Update to 0.4.40",
    })
    expect(updateButtonLabels(offer("in-place"), "downloading")).toEqual({
      icon: "Downloading update…",
      system: "Downloading…",
    })
  })
})
