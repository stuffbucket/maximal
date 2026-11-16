import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"

import type { SmokeOperation, SmokeOptions } from "./options"

import { parseArgs, plannedImageCredits, UsageError, usage } from "./options"
import { answerEvidence, decodePng } from "./response-validation"

type SmokeStatus = "PASS" | "FAIL" | "REFUSED" | "AMBIGUOUS"

const PLUGIN_IDS = ["decisions", "systemone", "images"] as const
const GET_TIMEOUT_MS = 10_000
const POST_TIMEOUT_MS = 5 * 60_000
const UNBOUND_MODEL = "__maximal_live_smoke_unbound_9e35f130__"

interface PluginBinding {
  model: string
  provider: string
  upstreamModel: string
}

interface PluginState {
  id: string
  enabled: boolean
  lifecycle: string
  statusCode: string
  statusState: string
  bindings: Array<PluginBinding>
}

interface Preflight {
  version: string
  plugins: Partial<Record<string, PluginState>>
  budgetEnabled: boolean | undefined
}

interface ArtifactSummary {
  path: string
  bytes: number
  sha256: string
}

interface StepResult {
  operation: string
  model?: string
  status: SmokeStatus
  httpStatus?: number
  durationMs: number
  result: string
  evidence?: Record<string, string | number>
  usage?: Record<string, unknown>
  reportedCostCredits?: number
  artifact?: ArtifactSummary
}

interface SmokeReport {
  target: string
  version: string
  plannedImageCredits: number
  plugins: Partial<Record<string, PluginState>>
  operations: Array<StepResult>
}

class PreflightError extends Error {}
class AmbiguousPostError extends Error {}
class InvalidJsonResponseError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
function endpoint(baseUrl: URL, pathname: string): URL {
  return new URL(pathname.replace(/^\//u, ""), baseUrl)
}

function authHeaders(apiKey: string | undefined): Headers {
  const headers = new Headers({ Accept: "application/json" })
  if (apiKey) headers.set("x-api-key", apiKey)
  return headers
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === "") return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new InvalidJsonResponseError(
      `HTTP ${response.status} returned non-JSON content`,
    )
  }
}

function errorSummary(status: number, body: unknown): string {
  if (isRecord(body)) {
    const error = body.error
    if (isRecord(error)) {
      const message =
        typeof error.message === "string" ? error.message : undefined
      const code = typeof error.code === "string" ? error.code : undefined
      if (message || code) return [code, message].filter(Boolean).join(": ")
    }
    if (typeof body.message === "string") return body.message
  }
  return `HTTP ${status}`
}

async function getJson(
  options: SmokeOptions,
  pathname: string,
  authenticated = true,
): Promise<{ response: Response; body: unknown }> {
  const headers = authenticated ? authHeaders(options.apiKey) : undefined
  const response = await fetch(endpoint(options.baseUrl, pathname), {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(GET_TIMEOUT_MS),
  })
  return { response, body: await responseJson(response) }
}

interface PostInput {
  pathname: string
  body: BodyInit
  contentType?: string
}

interface OperationReply {
  response: Response
  body: unknown
  durationMs: number
}

async function post(
  options: SmokeOptions,
  input: PostInput,
): Promise<OperationReply> {
  const headers = authHeaders(options.apiKey)
  if (input.contentType) headers.set("content-type", input.contentType)
  const started = performance.now()
  let response: Response
  try {
    response = await fetch(endpoint(options.baseUrl, input.pathname), {
      method: "POST",
      headers,
      body: input.body,
      redirect: "error",
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : "transport error"
    throw new AmbiguousPostError(
      `POST ${input.pathname} had no definitive response (${reason}); it may have executed`,
    )
  }
  let parsed: unknown
  try {
    parsed = await responseJson(response)
  } catch (error) {
    if (error instanceof InvalidJsonResponseError) throw error
    const reason =
      error instanceof Error ? error.message : "body transport error"
    throw new AmbiguousPostError(
      `POST ${input.pathname} returned headers but its body did not complete (${reason}); it may have executed`,
    )
  }
  return {
    response,
    body: parsed,
    durationMs: Math.round(performance.now() - started),
  }
}

function bindingOf(value: unknown): Array<PluginBinding> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const { model, provider, upstreamModel } = item
    return (
        typeof model === "string"
          && typeof provider === "string"
          && typeof upstreamModel === "string"
      ) ?
        [{ model, provider, upstreamModel }]
      : []
  })
}

function pluginState(id: string, value: unknown): PluginState {
  if (!isRecord(value))
    throw new PreflightError(`${id}: invalid plugin response`)
  const status = isRecord(value.status) ? value.status : {}
  const config = isRecord(value.config) ? value.config : {}
  return {
    id,
    enabled: value.enabled === true,
    lifecycle:
      typeof value.lifecycle === "string" ? value.lifecycle : "unknown",
    statusCode: typeof status.code === "string" ? status.code : "unknown",
    statusState: typeof status.state === "string" ? status.state : "unknown",
    bindings: bindingOf(config.bindings),
  }
}

function modelIds(value: unknown): Set<string> {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new PreflightError("/v1/models returned an invalid catalog")
  }
  return new Set(
    value.data.flatMap((item) =>
      isRecord(item) && typeof item.id === "string" ? [item.id] : [],
    ),
  )
}

function requireSuccessfulGet(
  pathname: string,
  response: Response,
  body: unknown,
): void {
  if (response.ok) return
  const hint =
    response.status === 401 ?
      " Set MAXIMAL_API_KEY to an enabled Maximal client key."
    : ""
  throw new PreflightError(
    `${pathname}: ${errorSummary(response.status, body)}.${hint}`,
  )
}

function validateProbeModel(
  plugins: Partial<Record<string, PluginState>>,
  models: ReadonlySet<string>,
): void {
  const bound = Object.values(plugins).some((plugin) =>
    plugin?.bindings.some(({ model }) => model === UNBOUND_MODEL),
  )
  if (bound || models.has(UNBOUND_MODEL)) {
    throw new PreflightError(
      "The negative-probe sentinel is configured; refusing unsafe probes",
    )
  }
}

function validateSelectedPlugins(
  options: SmokeOptions,
  plugins: Partial<Record<string, PluginState>>,
  models: ReadonlySet<string>,
): void {
  const selectedPlugins = new Set(
    options.operations.map((operation) =>
      operation.startsWith("images.") ? "images" : operation,
    ),
  )
  for (const id of selectedPlugins) {
    const plugin = plugins[id]
    if (
      !plugin
      || !plugin.enabled
      || plugin.lifecycle !== "active"
      || plugin.statusState !== "ready"
      || plugin.bindings.length === 0
    ) {
      throw new PreflightError(`${id} is not enabled, active, bound, and ready`)
    }
    for (const binding of plugin.bindings) {
      if (!models.has(binding.model)) {
        throw new PreflightError(
          `${id} binding ${binding.model} is absent from /v1/models`,
        )
      }
    }
  }
}

async function preflight(options: SmokeOptions): Promise<Preflight> {
  const statusResult = await getJson(options, "/status", false)
  requireSuccessfulGet("/status", statusResult.response, statusResult.body)
  if (!isRecord(statusResult.body) || statusResult.body.service !== "maximal") {
    throw new PreflightError("Target did not identify itself as Maximal")
  }
  const subsystems =
    isRecord(statusResult.body.subsystems) ? statusResult.body.subsystems : {}
  const copilot = isRecord(subsystems.copilot) ? subsystems.copilot : {}
  if (copilot.authenticated !== true || copilot.ready !== true) {
    throw new PreflightError("Copilot is not authenticated and ready")
  }

  const plugins: Partial<Record<string, PluginState>> = {}
  for (const id of PLUGIN_IDS) {
    const result = await getJson(options, `/settings/api/plugins/${id}`)
    requireSuccessfulGet(
      `/settings/api/plugins/${id}`,
      result.response,
      result.body,
    )
    plugins[id] = pluginState(id, result.body)
  }

  const modelsResult = await getJson(options, "/v1/models")
  requireSuccessfulGet("/v1/models", modelsResult.response, modelsResult.body)
  const models = modelIds(modelsResult.body)

  const budgetResult = await getJson(options, "/settings/api/budget")
  requireSuccessfulGet(
    "/settings/api/budget",
    budgetResult.response,
    budgetResult.body,
  )
  const budgetEnabled =
    (
      isRecord(budgetResult.body)
      && typeof budgetResult.body.enabled === "boolean"
    ) ?
      budgetResult.body.enabled
    : undefined

  validateSelectedPlugins(options, plugins, models)
  if (options.negativeProbes) validateProbeModel(plugins, models)

  return {
    version:
      typeof statusResult.body.version === "string" ?
        statusResult.body.version
      : "unknown",
    plugins,
    budgetEnabled,
  }
}

function firstModel(preflightResult: Preflight, pluginId: string): string {
  const plugin = preflightResult.plugins[pluginId]
  if (!plugin || plugin.bindings.length === 0) {
    throw new PreflightError(`${pluginId} has no configured binding`)
  }
  return plugin.bindings[0].model
}

function safeUsage(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !isRecord(body.usage)) return undefined
  return Object.fromEntries(
    Object.entries(body.usage).filter(
      ([, value]) => typeof value === "number" || isRecord(value),
    ),
  )
}

function reportedCredits(body: unknown): number | undefined {
  if (!isRecord(body) || !isRecord(body.copilot_usage)) return undefined
  const raw = body.copilot_usage.total_nano_aiu
  return typeof raw === "number" && Number.isFinite(raw) ?
      Math.round((raw / 1_000_000_000) * 100) / 100
    : undefined
}

interface OperationResultInput {
  operation: SmokeOperation
  model: string
  reply: OperationReply
}

function successfulResult(input: OperationResultInput): StepResult {
  const { operation, model, reply } = input
  const { response, body, durationMs } = reply
  if (!response.ok) {
    const refused = response.status === 402 || response.status === 403
    return {
      operation,
      model,
      status: refused ? "REFUSED" : "FAIL",
      httpStatus: response.status,
      durationMs,
      result: errorSummary(response.status, body),
    }
  }
  const evidence =
    operation === "decisions" || operation === "systemone" ?
      answerEvidence(operation, body)
    : undefined
  const valid = operation.startsWith("images.") || evidence !== undefined
  const usage = safeUsage(body)
  const reportedCostCredits = reportedCredits(body)
  return {
    operation,
    model,
    status: valid ? "PASS" : "FAIL",
    httpStatus: response.status,
    durationMs,
    result: valid ? "response shape valid" : "response did not contain answers",
    ...(evidence === undefined ? {} : { evidence }),
    ...(usage === undefined ? {} : { usage }),
    ...(reportedCostCredits === undefined ? {} : { reportedCostCredits }),
  }
}

async function runDecision(
  options: SmokeOptions,
  preflightResult: Preflight,
): Promise<StepResult> {
  const model = firstModel(preflightResult, "decisions")
  const reply = await post(options, {
    pathname: "/v1/decisions",
    body: JSON.stringify({
      model,
      input: "The smoke marker is present.",
      questions: [
        {
          type: "predicate",
          name: "marker_present",
          instructions: "The input says the smoke marker is present.",
        },
      ],
    }),
    contentType: "application/json",
  })
  return successfulResult({ operation: "decisions", model, reply })
}

async function runSystemOne(
  options: SmokeOptions,
  preflightResult: Preflight,
): Promise<StepResult> {
  const model = firstModel(preflightResult, "systemone")
  const reply = await post(options, {
    pathname: "/v1/systemone",
    body: JSON.stringify({
      model,
      state: "The smoke marker is present.",
      questions: {
        marker_present: {
          type: "noul",
          instructions: "The state says the smoke marker is present.",
        },
      },
    }),
    contentType: "application/json",
  })
  return successfulResult({ operation: "systemone", model, reply })
}

function requiredOutDir(options: SmokeOptions): string {
  if (!options.outDir)
    throw new Error("Image operation requires an output directory")
  return options.outDir
}

async function saveArtifact(
  outDir: string,
  filename: string,
  bytes: Buffer,
): Promise<ArtifactSummary> {
  const path = `${outDir}/${filename}`
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" })
  return {
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

interface GeneratedImage {
  bytes: Buffer
  result: StepResult
}

async function runImageGeneration(
  options: SmokeOptions,
  preflightResult: Preflight,
): Promise<GeneratedImage> {
  const model = firstModel(preflightResult, "images")
  const response = await post(options, {
    pathname: "/v1/images/generations",
    body: JSON.stringify({
      model,
      prompt:
        "A single solid red square centered on a white background, no text.",
      size: "1024x1024",
      quality: "low",
      n: 1,
      output_format: "png",
    }),
    contentType: "application/json",
  })
  if (!response.response.ok) {
    return {
      bytes: Buffer.alloc(0),
      result: successfulResult({
        operation: "images.generate",
        model,
        reply: response,
      }),
    }
  }
  let bytes: Buffer
  try {
    bytes = decodePng(response.body)
  } catch (error) {
    return {
      bytes: Buffer.alloc(0),
      result: {
        operation: "images.generate",
        model,
        status: "FAIL",
        httpStatus: response.response.status,
        durationMs: response.durationMs,
        result:
          error instanceof Error ? error.message : "invalid image response",
      },
    }
  }
  const artifact = await saveArtifact(
    requiredOutDir(options),
    "generated.png",
    bytes,
  )
  return {
    bytes,
    result: {
      operation: "images.generate",
      model,
      status: "PASS",
      httpStatus: response.response.status,
      durationMs: response.durationMs,
      result: "PNG signature valid",
      ...(safeUsage(response.body) === undefined ?
        {}
      : { usage: safeUsage(response.body) }),
      ...(reportedCredits(response.body) === undefined ?
        {}
      : { reportedCostCredits: reportedCredits(response.body) }),
      artifact,
    },
  }
}

async function runImageEdit(
  options: SmokeOptions,
  preflightResult: Preflight,
  source: Buffer,
): Promise<StepResult> {
  const model = firstModel(preflightResult, "images")
  const form = new FormData()
  form.append("model", model)
  form.append(
    "prompt",
    "Change the red square to blue; preserve the composition.",
  )
  form.append("size", "1024x1024")
  form.append("quality", "low")
  form.append("n", "1")
  form.append("output_format", "png")
  form.append(
    "image[]",
    new File([Uint8Array.from(source)], "generated.png", { type: "image/png" }),
  )
  const response = await post(options, {
    pathname: "/v1/images/edits",
    body: form,
  })
  if (!response.response.ok) {
    return successfulResult({
      operation: "images.edit",
      model,
      reply: response,
    })
  }
  let bytes: Buffer
  try {
    bytes = decodePng(response.body)
  } catch (error) {
    return {
      operation: "images.edit",
      model,
      status: "FAIL",
      httpStatus: response.response.status,
      durationMs: response.durationMs,
      result: error instanceof Error ? error.message : "invalid image response",
    }
  }
  const artifact = await saveArtifact(
    requiredOutDir(options),
    "edited.png",
    bytes,
  )
  return {
    operation: "images.edit",
    model,
    status: "PASS",
    httpStatus: response.response.status,
    durationMs: response.durationMs,
    result: "PNG signature valid",
    ...(safeUsage(response.body) === undefined ?
      {}
    : { usage: safeUsage(response.body) }),
    ...(reportedCredits(response.body) === undefined ?
      {}
    : { reportedCostCredits: reportedCredits(response.body) }),
    artifact,
  }
}

async function runNegativeProbes(
  options: SmokeOptions,
): Promise<Array<StepResult>> {
  const probes = [
    {
      operation: "negative.decisions",
      path: "/v1/decisions",
      body: { model: UNBOUND_MODEL, input: "No upstream call.", questions: [] },
    },
    {
      operation: "negative.systemone",
      path: "/v1/systemone",
      body: { model: UNBOUND_MODEL, state: "No upstream call.", questions: {} },
    },
    {
      operation: "negative.images.generate",
      path: "/v1/images/generations",
      body: { model: UNBOUND_MODEL, prompt: "Do not generate." },
    },
    {
      operation: "negative.images.edit",
      path: "/v1/images/edits",
      body: {
        model: UNBOUND_MODEL,
        prompt: "Do not edit.",
        images: [{ image_url: "data:image/png;base64,AQID" }],
      },
    },
  ]
  const results: Array<StepResult> = []
  for (const probe of probes) {
    const response = await post(options, {
      pathname: probe.path,
      body: JSON.stringify(probe.body),
      contentType: "application/json",
    })
    const error =
      isRecord(response.body) && isRecord(response.body.error) ?
        response.body.error
      : {}
    const passed =
      response.response.status === 404
      && response.response.headers.get("x-should-retry") === "false"
      && error.type === "invalid_request_error"
      && error.code === "model_not_enabled"
      && typeof error.message === "string"
    results.push({
      operation: probe.operation,
      model: UNBOUND_MODEL,
      status: passed ? "PASS" : "FAIL",
      httpStatus: response.response.status,
      durationMs: response.durationMs,
      result:
        passed ?
          "unbound model rejected before provider dispatch"
        : errorSummary(response.response.status, response.body),
    })
    if (!passed) break
  }
  return results
}

function budgetState(enabled: boolean | undefined): string {
  if (enabled === undefined) return "unknown"
  return enabled ? "on" : "off"
}

function printPreflight(result: Preflight, options: SmokeOptions): void {
  console.log("")
  console.log("Live operation smoke")
  console.log(`Target:  ${options.baseUrl.origin}`)
  console.log(`Version: ${result.version}`)
  console.log(`Budget:  ${budgetState(result.budgetEnabled)}`)
  console.log("")
  console.log("Plugin       State        Model")
  console.log("------------ ------------ --------------------------------")
  for (const id of PLUGIN_IDS) {
    const plugin = result.plugins[id]
    console.log(
      `${id.padEnd(12)} ${(plugin?.statusCode ?? "unknown").padEnd(12)} ${plugin?.bindings.map(({ model }) => model).join(", ") || "<none>"}`,
    )
  }
  console.log("")
  const credits = plannedImageCredits(options.operations)
  if (options.operations.length === 0 && !options.negativeProbes) {
    console.log("Preflight PASS — no model request sent.")
  } else {
    console.log(
      `Operations: ${options.operations.join(", ") || "negative probes only"}`,
    )
    if (credits > 0) console.log(`Planned image estimate: ${credits} credits`)
  }
}

function printResults(results: ReadonlyArray<StepResult>): void {
  if (results.length === 0) return
  console.log("")
  console.log("Status     HTTP  Duration  Operation")
  console.log("---------- ----- --------- ------------------------")
  for (const result of results) {
    console.log(
      `${result.status.padEnd(10)} ${String(result.httpStatus ?? "-").padEnd(5)} ${(String(result.durationMs) + "ms").padEnd(9)} ${result.operation}`,
    )
    console.log(`  ${result.result}`)
    if (result.evidence) {
      console.log(`  evidence: ${JSON.stringify(result.evidence)}`)
    }
    if (result.artifact) {
      console.log(
        `  ${result.artifact.path} (${result.artifact.bytes} bytes, sha256 ${result.artifact.sha256})`,
      )
    }
    if (result.reportedCostCredits !== undefined) {
      console.log(`  reported cost: ${result.reportedCostCredits} credits`)
    }
  }
  console.log("")
}

async function writeReport(
  options: SmokeOptions,
  preflightResult: Preflight,
  operations: Array<StepResult>,
): Promise<void> {
  if (!options.outDir) return
  const report: SmokeReport = {
    target: options.baseUrl.origin,
    version: preflightResult.version,
    plannedImageCredits: plannedImageCredits(options.operations),
    plugins: preflightResult.plugins,
    operations,
  }
  const path = `${options.outDir}/report.json`
  await writeFile(path, `${JSON.stringify(report, undefined, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  })
  console.log(`Report: ${path}`)
}

export async function runSmoke(options: SmokeOptions): Promise<number> {
  if (options.outDir) await mkdir(options.outDir, { mode: 0o700 })
  const preflightResult = await preflight(options)
  printPreflight(preflightResult, options)
  const results: Array<StepResult> = []

  if (options.negativeProbes) {
    results.push(...(await runNegativeProbes(options)))
  }
  if (results.some(({ status }) => status !== "PASS")) {
    printResults(results)
    await writeReport(options, preflightResult, results)
    return 1
  }

  let generated: Buffer | undefined
  for (const operation of options.operations) {
    let result: StepResult
    switch (operation) {
      case "decisions": {
        result = await runDecision(options, preflightResult)

        break
      }
      case "systemone": {
        result = await runSystemOne(options, preflightResult)

        break
      }
      case "images.generate": {
        const generation = await runImageGeneration(options, preflightResult)
        generated = generation.bytes
        result = generation.result

        break
      }
      default: {
        if (!generated || generated.length === 0) {
          throw new Error("Image edit fixture generation did not succeed")
        }
        result = await runImageEdit(options, preflightResult, generated)
      }
    }
    results.push(result)
    if (result.status !== "PASS") break
  }

  printResults(results)
  await writeReport(options, preflightResult, results)
  return results.every(({ status }) => status === "PASS") ? 0 : 1
}

async function main(): Promise<number> {
  try {
    const options = parseArgs(process.argv.slice(2))
    return await runSmoke(options)
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message)
      if (error.message !== usage()) console.error(`\n${usage()}`)
      return 2
    }
    if (error instanceof AmbiguousPostError) {
      console.error(`AMBIGUOUS: ${error.message}`)
      return 3
    }
    if (error instanceof PreflightError) {
      console.error(`Preflight failed: ${error.message}`)
      return 2
    }
    console.error(error instanceof Error ? error.message : "Smoke failed")
    return 1
  }
}

if (import.meta.main) process.exitCode = await main()
