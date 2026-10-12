import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

import { resolveApiKey } from "~/lib/auth/api-key-helper"
import { sendProviderRequest } from "~/lib/http/send-request"
import { PATHS } from "~/lib/platform/paths"

import { CODEX_BASE_URL, selectedProvider } from "./config"
import { parseConfig, valueAt } from "./toml"

const Provider = z.object({
  base_url: z.literal(CODEX_BASE_URL),
  wire_api: z.literal("responses"),
  auth: z.object({ command: z.string(), args: z.array(z.string()) }),
})

/** Standalone CLI invocations have no in-process Copilot model cache. Read the
 * running gateway's filtered task model list without touching GitHub auth. */
export async function readCodexGatewayModels(): Promise<Array<string>> {
  const key = resolveApiKey("codex")
  if (!key.ok)
    throw new Error(
      "Add an enabled API client key in Maximal Settings before connecting Codex.",
    )
  try {
    const response = await sendProviderRequest(
      { baseUrl: CODEX_BASE_URL, apiKey: key.key, authType: "authorization" },
      "http://127.0.0.1:4141/settings/api/apps",
      { method: "GET", timeoutMs: 10000, redirect: "error" },
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error()
    }
    const result = z
      .object({
        apps: z.array(
          z.object({
            id: z.string(),
            routing: z
              .object({ available_models: z.array(z.string()) })
              .optional(),
          }),
        ),
      })
      .parse(await response.json())
    const models = result.apps.find((app) => app.id === "codex")?.routing
      ?.available_models
    if (!models?.length) throw new Error()
    return models
  } catch {
    throw new Error(
      "Could not read Maximal's supported Codex models. Start Maximal, connect your account, and try again.",
    )
  }
}

function helperCommand(): { command: string; args: Array<string> } {
  const executable = process.execPath
  const runtime = /^(?:bun|node)(?:\.exe)?$/iu.test(path.basename(executable))
  if (runtime) {
    return {
      command: executable,
      args: [
        path.resolve(Bun.main),
        "api",
        "codex",
        "--api-home",
        path.resolve(PATHS.APP_DIR),
      ],
    }
  }
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "maximal"),
    "/opt/homebrew/bin/maximal",
    "/usr/local/bin/maximal",
  ]
  const stable = candidates.find((candidate) => {
    try {
      return fs.realpathSync(candidate) === fs.realpathSync(executable)
    } catch {
      return false
    }
  })
  return {
    command: stable ?? executable,
    args: ["api", "codex", "--api-home", path.resolve(PATHS.APP_DIR)],
  }
}

export function codexProvider(providerId: string): string {
  const helper = helperCommand()
  return [
    `[model_providers.${JSON.stringify(providerId)}]`,
    'name = "Maximal"',
    `base_url = ${JSON.stringify(CODEX_BASE_URL)}`,
    'wire_api = "responses"',
    "",
    `[model_providers.${JSON.stringify(providerId)}.auth]`,
    `command = ${JSON.stringify(helper.command)}`,
    `args = ${JSON.stringify(helper.args)}`,
    "timeout_ms = 5000",
    "refresh_interval_ms = 300000",
    "",
  ].join("\n")
}

async function readHelperKey(
  command: string,
  args: Array<string>,
): Promise<string> {
  const expected = resolveApiKey("codex")
  if (!expected.ok) {
    throw new Error(
      "Add an enabled API client key in Maximal Settings before enabling Codex.",
    )
  }
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 5000, maxBuffer: 8192, windowsHide: true },
      (error, stdout) => {
        if (error || stdout.trim() !== expected.key) {
          reject(
            new Error(
              "Codex could not retrieve its Maximal key. Restart the updated Maximal app and try again.",
            ),
          )
          return
        }
        resolve(stdout.trim())
      },
    )
  })
}

export async function verifyCodexProvider(
  text: string,
  model: string,
): Promise<void> {
  const provider = Provider.parse(
    valueAt(parseConfig(text), ["model_providers", selectedProvider(text)]),
  )
  const key = await readHelperKey(provider.auth.command, provider.auth.args)
  let response: Response
  try {
    response = await sendProviderRequest(
      {
        baseUrl: provider.base_url,
        apiKey: key,
        authType: "authorization",
      },
      `${provider.base_url}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          input: "Reply with OK.",
          stream: false,
          store: false,
          max_output_tokens: 1024,
        }),
        timeoutMs: 30000,
        redirect: "error",
      },
    )
  } catch {
    throw new Error(
      "Could not reach Maximal on port 4141 or the routing check timed out. Check that Maximal is running and try again.",
    )
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      `Codex routing verification failed (HTTP ${response.status}). Check your Maximal account and selected model, then try again.`,
    )
  }
  const result: unknown = await response.json().catch(() => null)
  const parsed = z
    .object({
      object: z.literal("response"),
      status: z.literal("completed"),
      output: z.array(z.unknown()),
      error: z.null().optional(),
    })
    .safeParse(result)
  if (!parsed.success) {
    throw new Error(
      "The selected model did not complete the Codex routing check. Choose another model or try again.",
    )
  }
}
