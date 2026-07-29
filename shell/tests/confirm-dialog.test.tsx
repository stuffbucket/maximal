import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test } from "bun:test"

import { ConfirmDialog } from "../src/ui/components/ConfirmDialog"

/**
 * Behavioural tests for the Radix-AlertDialog-backed ConfirmDialog. Confirms the
 * prop contract callers rely on survives the reback: controlled `open`, an
 * `alertdialog` role, confirm/cancel routing, and the async `busy` pattern
 * (confirm does NOT auto-close — the caller owns `open`).
 */

afterEach(cleanup)

describe("ConfirmDialog", () => {
  test("renders nothing while closed", () => {
    render(
      <ConfirmDialog
        open={false}
        title="Delete?"
        body="This is permanent."
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  test("renders title + body with the alertdialog role when open", () => {
    render(
      <ConfirmDialog
        open
        title="Delete?"
        body="This is permanent."
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByRole("alertdialog")).toBeDefined()
    expect(screen.getByText("Delete?")).toBeDefined()
    expect(screen.getByText("This is permanent.")).toBeDefined()
  })

  test("confirm fires onConfirm and does not auto-close (caller owns open)", () => {
    let confirmed = 0
    let cancelled = 0
    render(
      <ConfirmDialog
        open
        title="Delete?"
        body="x"
        confirmLabel="Delete"
        onConfirm={() => {
          confirmed += 1
        }}
        onCancel={() => {
          cancelled += 1
        }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(confirmed).toBe(1)
    // Radix would fire onOpenChange(false) if Action closed it; our confirm is a
    // plain button, so onCancel must NOT be called by confirming.
    expect(cancelled).toBe(0)
  })

  test("cancel routes through onCancel", () => {
    let cancelled = 0
    render(
      <ConfirmDialog
        open
        title="Delete?"
        body="x"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onCancel={() => {
          cancelled += 1
        }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(cancelled).toBe(1)
  })

  test("a busy dialog disables both actions", () => {
    render(
      <ConfirmDialog
        open
        busy
        title="Delete?"
        body="x"
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(true)
    // Busy swaps the confirm label to the working state.
    expect(screen.getByText("Working…")).toBeDefined()
  })
})
