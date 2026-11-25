import { describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:net"

import {
  firstAvailablePort,
  portIsAvailable,
  storybookPortOption,
} from "../packages/storybook/scripts/port"

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP listener"))
        return
      }
      resolve(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

describe("Storybook dev port", () => {
  test("uses 6006 by default and recognizes supported explicit forms", () => {
    expect(storybookPortOption([])).toEqual({ explicit: false, port: 6006 })
    expect(storybookPortOption(["--port", "6100"])).toEqual({
      explicit: true,
      port: 6100,
    })
    expect(storybookPortOption(["-p", "6101"])).toEqual({
      explicit: true,
      port: 6101,
    })
    expect(storybookPortOption(["--port=6102"])).toEqual({
      explicit: true,
      port: 6102,
    })
  })

  test("leaves invalid explicit values for Storybook to diagnose", () => {
    expect(storybookPortOption(["--port", "nope"])).toEqual({
      explicit: true,
      port: null,
    })
  })

  test("detects a listener and releases the probe cleanly", async () => {
    const blocker = createServer()
    const port = await listen(blocker)
    try {
      expect(await portIsAvailable(port)).toBe(false)
      expect(await firstAvailablePort(port, port)).toBeNull()
    } finally {
      await close(blocker)
    }
    expect(await portIsAvailable(port)).toBe(true)
  })
})
