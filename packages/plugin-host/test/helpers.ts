import type {
  Context,
  HostServices,
  PluginModule,
  ToolDefinition,
} from "@stuffbucket/maximal-plugin-sdk"
import type {
  PluginGatewayErrorCode,
  PluginGatewayEvent,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import {
  createFileStorage,
  createStorageSettingsAuthority,
} from "@stuffbucket/maximal-plugin-sdk/runtime"
import { expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

import { createPluginHost, PluginGatewayError } from "../src/index"

const cleanups: Array<() => Promise<void> | void> = []

/** Register with `afterEach(runCleanups)`. */
export async function runCleanups(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
}

export function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-host-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function fakeHost(): HostServices & {
  logs: Array<string>
  opened: Array<string>
} {
  const logs: Array<string> = []
  const opened: Array<string> = []
  const log = (level: string) => (message: string) =>
    void logs.push(`${level}: ${message}`)
  return {
    logs,
    opened,
    appVersion: "1.2.3",
    maximalPort: () => 4141,
    logger: {
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    },
    openExternal(url) {
      opened.push(url)
      return Promise.resolve()
    },
  }
}

export function tool(
  name: string,
  execute?: ToolDefinition["execute"],
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute:
      execute
      ?? ((input) =>
        Promise.resolve({
          content: [{ type: "text", text: `${name}:${JSON.stringify(input)}` }],
        })),
  }
}

export function define<C>(
  name: string,
  Config: PluginModule<C>["Config"],
  apply: (ctx: Context, config: C) => void | Promise<void>,
): PluginModule<C> {
  return {
    name,
    manifest: {
      id: name,
      kind: "extension",
      displayName: name.toUpperCase(),
      description: `${name} plugin`,
      homepage: `https://example.test/${name}`,
      settingsVersion: 1,
    },
    inject: ["tools", "surface", "storage", "host"],
    Config,
    apply,
  }
}

/** Write `<root>/<id>/settings.json` directly (as a user or older app would). */
export function seedSettings(
  root: string,
  id: string,
  document: unknown,
): string {
  const dir = path.join(root, id)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "settings.json")
  writeFileSync(
    file,
    typeof document === "string" ? document : JSON.stringify(document),
  )
  return file
}

export function envelope(id: string, config?: unknown, version = 1) {
  return {
    $schema: "maximal-plugin-settings/1",
    plugin: id,
    version,
    ...(config === undefined ? {} : { config }),
  }
}

export const Empty = z.object({})

export const noop = () => {}

export function testSettingsAuthority(storageRoot: string) {
  return createStorageSettingsAuthority(createFileStorage(storageRoot))
}

/** A gateway built from deliberately malformed plugin lists (constructor must throw). */
export function buildHost(plugins: Array<unknown>) {
  return () =>
    createPluginHost({
      plugins: plugins as Array<PluginModule>,
      services: {
        host: fakeHost(),
        storageRoot: os.tmpdir(),
        settingsAuthority: createStorageSettingsAuthority(
          createFileStorage(os.tmpdir()),
        ),
      },
    })
}

export function createHost(
  plugins: ReadonlyArray<PluginModule>,
  host = fakeHost(),
  storageRoot = tempDir(),
) {
  const storage = createFileStorage(storageRoot)
  const gateway = createPluginHost({
    plugins,
    services: {
      host,
      storageRoot,
      storage,
      settingsAuthority: createStorageSettingsAuthority(storage),
    },
  })
  cleanups.push(() => gateway.dispose())
  const events: Array<PluginGatewayEvent> = []
  gateway.subscribe((event) => events.push(event))
  return { gateway, events, host, storageRoot }
}

export async function expectGatewayError(
  promise: Promise<unknown> | (() => unknown),
  code: PluginGatewayErrorCode,
): Promise<void> {
  try {
    await (typeof promise === "function" ? promise() : promise)
  } catch (error) {
    expect(error).toBeInstanceOf(PluginGatewayError)
    expect((error as PluginGatewayError).code).toBe(code)
    return
  }
  throw new Error(`expected PluginGatewayError ${code}`)
}
