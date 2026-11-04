/**
 * Plugin-system test helpers: inline test plugins, a real gateway composed
 * through `src/lib/plugins/compose.ts` with them (temp storage, recording
 * host), installed as the app's running gateway, and the real Hono app on a
 * loopback port (so `/mcp/*` sees a loopback peer address).
 */

import type {
  Context,
  JsonSchemaObject,
  PluginKind,
  PluginModule,
} from "@stuffbucket/maximal-plugin-sdk"
import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { serve } from "srvx"
import { z } from "zod"

import { writeConfig } from "~/lib/config/config"
import { composePluginGateway } from "~/lib/plugins/compose"
import { setPluginGateway } from "~/lib/plugins/gateway"

export interface DefinePluginOptions {
  /** Defaults to `connector`. */
  kind?: PluginKind
  settingsVersion?: number
  configSchema?: JsonSchemaObject
  defaultToolPermission?: PluginModule["defaultToolPermission"]
  migrateSettings?: PluginModule["migrateSettings"]
}

/** The inline test plugins' config: `{}` is valid; `endpoint` follows the
 *  connector-kit convention (overrides the manifest's upstream). */
export const TestConfig = z.object({
  greeting: z.string().default("hi"),
  endpoint: z.url().optional(),
})

export function definePlugin(
  name: string,
  apply: (ctx: Context) => void | Promise<void>,
  options: DefinePluginOptions = {},
): PluginModule {
  const kind = options.kind ?? "connector"
  return {
    name,
    manifest: {
      id: name,
      kind,
      displayName: name.toUpperCase(),
      description: `${name} plugin`,
      settingsVersion: options.settingsVersion ?? 1,
      ...(options.configSchema ? { configSchema: options.configSchema } : {}),
      ...(kind === "connector" ?
        {
          connector: {
            transport: "streamable-http" as const,
            endpoint: `https://${name}.example.test/mcp`,
            auth: {
              type: "entra" as const,
              clientId: "00000000-0000-4000-8000-000000000001",
              authority: "https://login.example.test/organizations",
              scopes: ["api://example/.default"],
              redirectUri: "http://localhost:12798",
            },
            terms: { url: "https://example.test/terms", label: "Terms" },
          },
        }
      : {}),
    },
    inject: ["tools", "surface", "storage", "host"],
    Config: TestConfig,
    apply,
    ...(options.defaultToolPermission ?
      { defaultToolPermission: options.defaultToolPermission }
    : {}),
    ...(options.migrateSettings ?
      { migrateSettings: options.migrateSettings }
    : {}),
  }
}

export interface TestGateway {
  gateway: PluginGateway
  storageRoot: string
  opened: Array<string>
  dispose(): Promise<void>
}

/** Compose a gateway from `plugins`, start the ones `enabled` lists, and
 *  install it as the running gateway. */
export async function startTestGateway(
  plugins: ReadonlyArray<PluginModule>,
  enabled: ReadonlyArray<string> = [],
  options: { storageRoot?: string } = {},
): Promise<TestGateway> {
  const storageRoot =
    options.storageRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "plugins-"))
  const opened: Array<string> = []
  const gateway = composePluginGateway({
    plugins,
    storageRoot,
    host: {
      openExternal: (url) => {
        opened.push(url)
        return Promise.resolve()
      },
    },
  })
  const config = writeConfig({
    plugins: Object.fromEntries(enabled.map((id) => [id, { enabled: true }])),
  })
  setPluginGateway(gateway)
  await gateway.reconcile(config.plugins)
  return {
    gateway,
    storageRoot,
    opened,
    async dispose() {
      setPluginGateway(undefined)
      await gateway.dispose()
      writeConfig({})
      fs.rmSync(storageRoot, { recursive: true, force: true })
    },
  }
}

/** Serve the real app on a loopback port. */
export async function serveApp(
  fetch: (request: Request) => Response | Promise<Response>,
): Promise<{ origin: string; close(): Promise<void> }> {
  const httpServer = serve({
    fetch,
    hostname: "127.0.0.1",
    port: 0,
    silent: true,
    bun: { idleTimeout: 0 },
  })
  await httpServer.ready()
  const url = httpServer.url
  if (!url) throw new Error("test server reported no URL")
  return {
    origin: new URL(url).origin,
    close: () => httpServer.close(true),
  }
}

export async function waitFor(
  check: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
