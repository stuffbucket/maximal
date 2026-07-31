import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, spyOn } from "bun:test"

import { ErrorBoundary } from "../src/ui/components/ErrorBoundary"

/**
 * Unit test for the island error boundary. Its job: when a descendant throws
 * during render, show the fallback instead of letting React unmount the whole
 * root to a blank node (the silent-blank failure the diagnostics island hit).
 */

function Boom(): never {
  throw new Error("kaboom")
}

afterEach(cleanup)

describe("ErrorBoundary", () => {
  test("renders children when nothing throws", () => {
    render(
      <ErrorBoundary fallback={<p>fallback</p>}>
        <p>healthy</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText("healthy")).toBeDefined()
    expect(screen.queryByText("fallback")).toBeNull()
  })

  test("shows the fallback when a child throws", () => {
    // React logs the caught error to console.error; silence it for the run.
    const spy = spyOn(console, "error").mockImplementation(() => {})
    render(
      <ErrorBoundary fallback={<p>fallback</p>}>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText("fallback")).toBeDefined()
    spy.mockRestore()
  })
})
