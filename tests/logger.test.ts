import { afterEach, expect, mock, test } from "bun:test"

import { debugJson, debugJsonTail } from "../src/lib/logger"
import { state } from "../src/lib/state"

afterEach(() => {
  state.verbose = false
})

test("debugJson skips serialization when verbose logging is disabled", () => {
  state.verbose = false

  const logger = {
    debug: mock(() => {}),
  }
  const toJSON = mock(() => ({ ok: true }))

  debugJson(logger as never, "payload", { toJSON })

  expect(toJSON).not.toHaveBeenCalled()
  expect(logger.debug).not.toHaveBeenCalled()
})

test("debugJson logs the serialized payload when verbose logging is enabled", () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { ok: true }

  debugJson(logger as never, "payload", payload)

  expect(logger.debug).toHaveBeenCalledWith("payload", JSON.stringify(payload))
})

test("debugJsonTail preserves tail truncation behavior", () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  // `text` is content → redacted before truncation. The tail is taken
  // of the redacted JSON, so truncation and redaction compose.
  const payload = { text: "abcdefghijklmnopqrstuvwxyz" }
  const redacted = { text: `[redacted ${payload.text.length} chars]` }
  const expected = JSON.stringify(redacted).slice(-10)

  debugJsonTail(logger as never, "payload", { value: payload, tailLength: 10 })

  expect(logger.debug).toHaveBeenCalledWith("payload", expected)
})
