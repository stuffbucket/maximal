import { OpenAPIHono } from "@hono/zod-openapi"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  evaluateSetup,
  type SetupPaths,
  SetupStatusSchema,
} from "~/lib/config/setup-status"
import { forwardError } from "~/lib/errors/error"
import { PRODUCT_ENDPOINTS } from "~/routes/product-api"
import { server } from "~/server"

/**
 * Proof-of-shape tests for the maximal product OpenAPI surface.
 *
 * Two guarantees:
 *  (a) `/setup-status` still returns its original runtime shape after the
 *      migration to @hono/zod-openapi (no behaviour regression), and
 *  (b) `/openapi.json` is a valid document scoped to the product surface,
 *      exposes the `/setup-status` path, and references a `SetupStatus`
 *      component schema. Because the operation is generated from the same
 *      `createRoute` definition the handler answers, (b) is the
 *      DRIFT-BINDING check: the spec cannot describe a shape the route
 *      doesn't serve.
 */

interface SetupCheck {
  ok: boolean
  reason?: string
  path?: string
}

interface SetupStatusBody {
  ready: boolean
  checks: {
    appDir: SetupCheck
    config: SetupCheck
    db: SetupCheck
    githubAuth: SetupCheck
  }
  nextStep: string | null
}

describe("GET /setup-status (post-OpenAPI-migration)", () => {
  test("returns 200 with the original response shape", async () => {
    const res = await server.request("/setup-status")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")

    const body = (await res.json()) as SetupStatusBody

    // Top-level contract: exactly ready / checks / nextStep.
    expect(Object.keys(body).sort()).toEqual(["checks", "nextStep", "ready"])
    expect(typeof body.ready).toBe("boolean")
    expect(body.nextStep === null || typeof body.nextStep === "string").toBe(
      true,
    )

    // All four ordered checks are present, each an { ok: boolean } record.
    expect(Object.keys(body.checks).sort()).toEqual([
      "appDir",
      "config",
      "db",
      "githubAuth",
    ])
    for (const check of Object.values(body.checks)) {
      expect(typeof check.ok).toBe("boolean")
    }
  })
})

describe("GET /openapi.json (drift-binding)", () => {
  test("serves a valid product OpenAPI document", async () => {
    const res = await server.request("/openapi.json")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")

    const doc = (await res.json()) as {
      openapi: string
      info: { title: string; version: string }
      paths: Record<string, unknown>
      components?: { schemas?: Record<string, unknown> }
    }

    expect(doc.openapi).toMatch(/^3\./)
    expect(doc.info.title).toBe("maximal product API")
    expect(doc.info.version.length).toBeGreaterThan(0)
  })

  test("exposes the /setup-status path bound to the SetupStatus schema", async () => {
    const res = await server.request("/openapi.json")
    const doc = (await res.json()) as {
      paths: Record<
        string,
        {
          get?: {
            responses?: Record<
              string,
              {
                content?: Record<string, { schema?: { $ref?: string } }>
              }
            >
          }
        }
      >
      components?: { schemas?: Record<string, unknown> }
    }

    // The product path exists...
    expect(doc.paths).toHaveProperty("/setup-status")
    const ok = doc.paths["/setup-status"].get?.responses?.["200"]
    const schema = ok?.content?.["application/json"]?.schema
    // ...and its 200 response is bound (by $ref) to the SetupStatus schema,
    // not an inline duplicate that could drift.
    expect(schema?.$ref).toBe("#/components/schemas/SetupStatus")

    // The component schema for the response actually exists.
    expect(doc.components?.schemas).toHaveProperty("SetupStatus")
  })

  test("is scoped to the product surface only — no mirrored/completion endpoints", async () => {
    const res = await server.request("/openapi.json")
    const doc = (await res.json()) as { paths: Record<string, unknown> }

    // Exactly the product endpoints declared in the closed-world allowlist
    // (single source of truth in routes/product-api.ts).
    expect(Object.keys(doc.paths).sort()).toEqual([...PRODUCT_ENDPOINTS].sort())

    // Belt-and-braces: none of the proxy/mirror surfaces leaked in.
    const forbidden =
      /chat\/completions|\/messages|\/responses|\/embeddings|\/models|\/usage|\/token-usage/
    for (const path of Object.keys(doc.paths)) {
      expect(path).not.toMatch(forbidden)
    }
  })

  test("is served without authentication (public spec)", async () => {
    // No Authorization header, no API key: a fresh install must reach the
    // doc. `/openapi.json` is in server.ts's allowUnauthenticatedPaths.
    const res = await server.request("/openapi.json")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
  })
})

describe("product-API mount does not shadow sibling routes", () => {
  test("sibling routes remain reachable (mount at '/' is not a catch-all)", async () => {
    // `/status` is unauthenticated and served alongside the productApiRoutes
    // mount. If `server.route("/", productApiRoutes)` behaved as a catch-all
    // it would swallow this path; a 200 proves the mount is fall-through.
    const res = await server.request("/status")
    expect(res.status).toBe(200)
  })

  test("an unknown path still 404s (mount is not a catch-all)", async () => {
    const res = await server.request("/definitely-not-a-route")
    expect(res.status).toBe(404)
  })
})

describe("onError → forwardError wiring", () => {
  test("yields a 500 JSON error shape", async () => {
    // Mirror setup-status.ts's error wiring on a throwaway app so we exercise
    // the exact `.onError((e, c) => forwardError(c, e))` contract without
    // mocking the shared evaluateSetup module (see architecture.md → Testing
    // gotchas: no unrestored mock.module on shared modules).
    const probe = new OpenAPIHono()
    probe.get("/boom", () => {
      throw new Error("evaluateSetup failed")
    })
    probe.onError((error, c) => forwardError(c, error))

    const res = await probe.request("/boom")
    expect(res.status).toBe(500)
    const body = (await res.json()) as {
      error?: { message: string; type: string }
    }
    expect(body.error?.type).toBe("error")
    expect(body.error?.message).toContain("evaluateSetup failed")
  })
})

describe("SetupStatusSchema fidelity (interface → Zod migration)", () => {
  test("locks the pre-migration response shape", () => {
    const parsed = SetupStatusSchema.parse({
      ready: false,
      checks: {
        appDir: { ok: true, path: "/x" },
        config: { ok: false, reason: "invalid JSON", path: "/y" },
        db: { ok: true },
        githubAuth: { ok: true },
      },
      nextStep: "config",
    })

    // Exact top-level keys.
    expect(Object.keys(parsed).sort()).toEqual(["checks", "nextStep", "ready"])
    // Exact check keys, in the canonical set.
    expect(Object.keys(parsed.checks).sort()).toEqual(
      ["appDir", "config", "db", "githubAuth"].sort(),
    )
    // Optional detail fields (reason/path) survive the schema.
    expect(parsed.checks.config).toEqual({
      ok: false,
      reason: "invalid JSON",
      path: "/y",
    })
    // nextStep is a nullable enum member, not free-form.
    expect(() =>
      SetupStatusSchema.parse({ ...parsed, nextStep: "not-a-check" }),
    ).toThrow()
  })
})

/**
 * Closed-loop drift binding: the PUBLISHED doc advertises EXACTLY what the
 * runtime emits — no more, no less.
 *
 * The `$ref` binding in the earlier block proves the 200 response points at
 * the `SetupStatus` component, but a component can still over-advertise: an
 * ADDITIVE OPTIONAL field (`z.string().optional()`) added to
 * `SetupStatusSchema` lands in `components.schemas` (and thus in the doc)
 * while `evaluateSetup()` never emits it — and every other test here, plus
 * `tsc`, stays green. That is the exact drift the doc's comments claim is
 * impossible. This block makes the claim TRUE by comparing the doc's
 * advertised property set against the keys the real `evaluateSetup()`
 * actually returns.
 *
 * Optional-and-conditional fields (e.g. `reason`, only present on a failing
 * check; `nextStep`, non-null only when a check fails) are handled by driving
 * the REAL `evaluateSetup()` across BOTH a fully-passing state (a temp dir
 * with a valid config, db, and token) and a fully-failing state (nonexistent
 * paths), then taking the UNION of emitted keys. A field the doc advertises
 * but no reachable state emits is drift and reds the build.
 *
 * Both states are built by injecting the `SetupPaths` argument, so
 * `evaluateSetup` stays the genuine module under test — no `mock.module` on
 * the shared setup-status module (see architecture.md → Testing gotchas).
 */

// Minimal recursive view of the JSON-Schema nodes the doc emits. Enough to
// resolve `$ref`s and read `properties`; we never touch other keywords.
interface DocSchema {
  $ref?: string
  type?: string
  properties?: Record<string, DocSchema>
}

interface ProductDoc {
  components?: { schemas?: Record<string, DocSchema | undefined> }
}

// Resolve a possible `#/components/schemas/<Name>` ref against the doc's
// component table; returns the node unchanged when it isn't a ref.
function resolveRef(
  node: DocSchema,
  schemas: Record<string, DocSchema | undefined>,
): DocSchema {
  if (!node.$ref) return node
  const name = node.$ref.replace("#/components/schemas/", "")
  const target = schemas[name]
  if (!target) throw new Error(`unresolved $ref: ${node.$ref}`)
  return target
}

// The property names an object schema advertises (its `properties` keys),
// following a top-level `$ref` first.
function advertisedProps(
  node: DocSchema,
  schemas: Record<string, DocSchema | undefined>,
): Set<string> {
  const resolved = resolveRef(node, schemas)
  return new Set(Object.keys(resolved.properties ?? {}))
}

// Union of keys an object actually carries across every provided sample.
function emittedKeys(...samples: Array<Record<string, unknown>>): Set<string> {
  const keys = new Set<string>()
  for (const sample of samples) {
    for (const key of Object.keys(sample)) keys.add(key)
  }
  return keys
}

async function fetchProductDoc(): Promise<ProductDoc> {
  const res = await server.request("/openapi.json")
  return (await res.json()) as ProductDoc
}

// The doc's component-schema table (throws if the doc has none, which would
// itself be a regression). Callers get a non-optional table to work with.
async function fetchSchemas(): Promise<Record<string, DocSchema | undefined>> {
  const doc = await fetchProductDoc()
  const schemas = doc.components?.schemas
  if (!schemas) throw new Error("product doc has no components.schemas")
  return schemas
}

// A required named component (throws if the doc stops publishing it).
function component(
  schemas: Record<string, DocSchema | undefined>,
  name: string,
): DocSchema {
  const node = schemas[name]
  if (!node) throw new Error(`missing component schema: ${name}`)
  return node
}

// A path set that makes every check fail: nonexistent dir/config/db/token.
// Exercises the `ok:false` branch → checks carry `reason`, and `nextStep`
// resolves to a real enum member instead of `null`.
const FAILING_PATHS: SetupPaths = {
  appDir: "/setup-status-openapi-drift-nonexistent",
  configPath: "/setup-status-openapi-drift-nonexistent/config.json",
  dbPath: "/setup-status-openapi-drift-nonexistent/copilot-api.sqlite",
  githubTokenPath: "/setup-status-openapi-drift-nonexistent/github_token",
}

// A fully-passing state, built in a throwaway temp dir so it doesn't depend on
// the ambient install: the dir exists + is writable (appDir ok), a valid
// config file (config ok), a non-empty db file (db ok), and a bare-token file
// (githubAuth ok) → `ready:true`, `nextStep:null`, each check emits only
// `ok`/`path`. Combined with FAILING_PATHS, the union of emitted keys covers
// every optional/nullable field the doc can advertise.
let passingDir: string
let PASSING_PATHS: SetupPaths

beforeAll(() => {
  passingDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-status-drift-"))
  const configPath = path.join(passingDir, "config.json")
  const dbPath = path.join(passingDir, "copilot-api.sqlite")
  const githubTokenPath = path.join(passingDir, "github_token")
  fs.writeFileSync(configPath, "{}") // valid against AppConfigSchema defaults
  fs.writeFileSync(dbPath, "sqlite") // any non-empty content: checkDb wants size>0
  fs.writeFileSync(githubTokenPath, "ghp_exampletoken") // bare token → ok
  PASSING_PATHS = {
    appDir: passingDir,
    configPath,
    dbPath,
    githubTokenPath,
  }
})

afterAll(() => {
  fs.rmSync(passingDir, { recursive: true, force: true })
})

describe("GET /openapi.json ↔ evaluateSetup() (closed-loop drift binding)", () => {
  test("the doc advertises EXACTLY the top-level keys the runtime emits", async () => {
    const schemas = await fetchSchemas()
    const advertised = advertisedProps(
      component(schemas, "SetupStatus"),
      schemas,
    )

    // Real runtime, both reachable states. No mocks: both come from injecting
    // the SetupPaths argument, so evaluateSetup stays the genuine module.
    const ready = await evaluateSetup(PASSING_PATHS)
    const notReady = await evaluateSetup(FAILING_PATHS)
    // Sanity-guard the fixture: the two states must actually differ, else the
    // union below wouldn't cover the optional/nullable fields and the test
    // would pass vacuously. `ready.nextStep` proves the null branch; the
    // failing run proves the non-null enum branch.
    expect(ready.ready).toBe(true)
    expect(ready.nextStep).toBeNull()
    expect(notReady.ready).toBe(false)
    expect(notReady.nextStep).not.toBeNull()

    const emitted = emittedKeys(ready, notReady)

    // Exactly equal: no advertised-but-never-emitted (additive-optional)
    // property, and no emitted-but-undocumented property.
    expect([...advertised].sort()).toEqual([...emitted].sort())
  })

  test("the doc advertises EXACTLY the check-result keys the runtime emits", async () => {
    const schemas = await fetchSchemas()

    // Resolve the nested check-result shape via its $ref off SetupStatus →
    // checks → <any check> → #/components/schemas/SetupCheckResult.
    const setupStatus = resolveRef(component(schemas, "SetupStatus"), schemas)
    const checksNode = setupStatus.properties?.checks
    expect(checksNode).toBeDefined()
    if (!checksNode) return
    const checkNodes = Object.values(checksNode.properties ?? {})
    expect(checkNodes.length).toBeGreaterThan(0)

    const advertised = advertisedProps(checkNodes[0], schemas)

    // Every advertised check property must appear on SOME real check across
    // the passing + failing runs (the union covers `ok`/`path` from passing
    // checks and `reason` from failing ones).
    const ready = await evaluateSetup(PASSING_PATHS)
    const notReady = await evaluateSetup(FAILING_PATHS)
    const emitted = emittedKeys(
      ...Object.values(ready.checks),
      ...Object.values(notReady.checks),
    )

    expect([...advertised].sort()).toEqual([...emitted].sort())
  })
})
