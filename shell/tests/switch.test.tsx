import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test } from "bun:test"

import { Switch } from "../src/ui/components/Switch"

/**
 * Interaction test for the Switch component — the second unit under the render
 * harness, showing it covers user events (not just data-loading like Usage).
 */

afterEach(cleanup)

describe("Switch", () => {
  test("renders its label and reflects the checked prop", () => {
    render(<Switch checked label="Wi-Fi" onCheckedChange={() => {}} />)

    expect(screen.getByText("Wi-Fi")).toBeDefined()
    expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(true)
  })

  test("calls onCheckedChange with the toggled value when clicked", () => {
    const calls: Array<boolean> = []
    render(
      <Switch
        checked={false}
        label="Wi-Fi"
        onCheckedChange={(v) => calls.push(v)}
      />,
    )

    fireEvent.click(screen.getByRole("checkbox"))

    expect(calls).toEqual([true])
  })

  test("does not fire onCheckedChange while disabled", () => {
    const calls: Array<boolean> = []
    render(
      <Switch
        checked={false}
        disabled
        label="Wi-Fi"
        onCheckedChange={(v) => calls.push(v)}
      />,
    )

    fireEvent.click(screen.getByRole("checkbox"))

    expect(calls).toEqual([])
  })
})
