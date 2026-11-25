import {
  isPluginSettingsConflictError,
  type PluginSettingsProposal,
  type PluginSettingsRevision,
} from "@stuffbucket/maximal-plugin-sdk/runtime"
import { afterEach, describe, expect, test } from "bun:test"
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { GenerationCommitRecord } from "~/lib/plugins/generation-cutover"

import { createDurableGenerationJournal } from "~/lib/plugins/generation-journal"
import { createPluginStateBroker } from "~/lib/plugins/state-broker"

const roots: Array<string> = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "plugin-state-broker-"))
  roots.push(value)
  return value
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject.")
}

function settings(
  pluginId: string,
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify(
    {
      $schema: "maximal-plugin-settings/1",
      plugin: pluginId,
      version: 1,
      ...extra,
    },
    null,
    2,
  )}\n`
}

function proposal(
  base: PluginSettingsRevision,
  text: string,
  kind: PluginSettingsProposal["kind"] = "config",
): PluginSettingsProposal {
  return {
    pluginId: base.pluginId,
    baseRevision: base.revision,
    baseEpoch: base.epoch,
    kind,
    text,
  }
}

function generationRecord(
  epoch: number,
  handoffIdempotencyKey = "handoff-old-to-new",
): GenerationCommitRecord<{ version: number }> {
  return {
    commitId: "commit-new",
    handoffIdempotencyKey,
    previousGenerationId: "old",
    generationId: "new",
    artifactId: "artifact-new",
    fence: {
      epoch,
      settingsRevisions: { alpha: 0 },
      providerRevisions: {},
    },
    snapshot: { version: 2 },
    snapshotRevision: 1,
    health: [{ pluginId: "alpha", state: "active" }],
    previousHealth: [{ pluginId: "alpha", state: "active" }],
    resources: ["port:4150"],
    events: [],
  }
}

// eslint-disable-next-line max-lines-per-function -- broker scenarios share temporary-root cleanup
describe("parent plugin state broker", () => {
  test("one CAS race commits and the rejected proposal changes no settings bytes", async () => {
    const directory = await root()
    const broker = createPluginStateBroker(directory)
    const base = await broker.snapshot("alpha")
    const first = settings("alpha", { config: { value: 1 } })
    const second = settings("alpha", { config: { value: 2 } })

    const results = await Promise.allSettled([
      broker.commit(proposal(base, first)),
      broker.commit(proposal(base, second)),
    ])

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(
      rejected?.status === "rejected"
        && isPluginSettingsConflictError(rejected.reason),
    ).toBe(true)
    const bytes = await readFile(
      path.join(directory, "alpha", "settings.json"),
      "utf8",
    )
    expect([first, second]).toContain(bytes)
  })

  test("an edit during candidate preparation fences the stale proposal", async () => {
    const directory = await root()
    const pluginDirectory = path.join(directory, "alpha")
    await mkdir(pluginDirectory, { recursive: true })
    const original = settings("alpha", { config: { value: "old" } })
    await writeFile(path.join(pluginDirectory, "settings.json"), original)
    const broker = createPluginStateBroker(directory)
    const candidateBase = await broker.snapshot("alpha")

    const edited = settings("alpha", { config: { value: "person" } })
    await writeFile(path.join(pluginDirectory, "settings.json"), edited)
    const error = await broker
      .commit(
        proposal(
          candidateBase,
          settings("alpha", { config: { value: "candidate" } }),
          "migration",
        ),
      )
      .catch((caught: unknown) => caught)

    expect(isPluginSettingsConflictError(error)).toBe(true)
    expect(
      await readFile(path.join(pluginDirectory, "settings.json"), "utf8"),
    ).toBe(edited)
  })

  test("permission and catalog proposals replay without losing either change", async () => {
    const directory = await root()
    const broker = createPluginStateBroker(directory)

    const apply = async (
      kind: PluginSettingsProposal["kind"],
      mutate: (document: Record<string, unknown>) => void,
    ): Promise<void> => {
      for (;;) {
        const base = await broker.snapshot("alpha")
        const document =
          base.text === undefined ?
            (JSON.parse(settings("alpha")) as Record<string, unknown>)
          : (JSON.parse(base.text) as Record<string, unknown>)
        mutate(document)
        try {
          await broker.commit(
            proposal(base, `${JSON.stringify(document, null, 2)}\n`, kind),
          )
          return
        } catch (error) {
          if (!isPluginSettingsConflictError(error)) throw error
        }
      }
    }

    await Promise.all([
      apply("permissions", (document) => {
        const tools = (document.tools ?? {}) as Record<string, unknown>
        document.tools = { ...tools, permissions: { search: "allow" } }
      }),
      apply("catalog", (document) => {
        const tools = (document.tools ?? {}) as Record<string, unknown>
        document.tools = {
          ...tools,
          catalog: { updatedAt: "2026-01-01T00:00:00.000Z", tools: [] },
        }
      }),
    ])

    const committed = await broker.snapshot("alpha")
    const document = JSON.parse(committed.text ?? "{}") as {
      tools?: { permissions?: unknown; catalog?: unknown }
    }
    expect(document.tools?.permissions).toEqual({ search: "allow" })
    expect(document.tools?.catalog).toEqual({
      updatedAt: "2026-01-01T00:00:00.000Z",
      tools: [],
    })
  })

  test("a failure before the commit point leaves committed bytes unchanged", async () => {
    const directory = await root()
    const pluginDirectory = path.join(directory, "alpha")
    await mkdir(pluginDirectory, { recursive: true })
    const file = path.join(pluginDirectory, "settings.json")
    const original = settings("alpha", { config: { value: "old" } })
    await writeFile(file, original)
    const broker = createPluginStateBroker(directory, {
      fault(point) {
        if (point === "before-commit-point") throw new Error("before commit")
      },
    })
    const base = await broker.snapshot("alpha")

    const commitError = await failureOf(
      broker.commit(
        proposal(base, settings("alpha", { config: { value: "new" } })),
      ),
    )
    expect(commitError).toBeInstanceOf(Error)
    expect((commitError as Error).message).toContain("before commit")

    expect(await readFile(file, "utf8")).toBe(original)
    expect(
      await failureOf(
        readFile(path.join(directory, ".host", "transaction.json"), "utf8"),
      ),
    ).toMatchObject({ code: "ENOENT" })
  })

  test.each([
    "after-commit-point",
    "after-settings-rename",
    "after-control-rename",
  ] as const)(
    "a failure at %s recovers the durably selected transaction",
    async (faultPoint) => {
      const directory = await root()
      const pluginDirectory = path.join(directory, "alpha")
      await mkdir(pluginDirectory, { recursive: true })
      const file = path.join(pluginDirectory, "settings.json")
      await writeFile(file, settings("alpha", { config: { value: "old" } }))
      let failed = false
      const broker = createPluginStateBroker(directory, {
        fault(point) {
          if (!failed && point === faultPoint) {
            failed = true
            throw new Error(`fault at ${point}`)
          }
        },
      })
      const base = await broker.snapshot("alpha")
      const selected = settings("alpha", { config: { value: "selected" } })

      const commitError = await failureOf(
        broker.commit(proposal(base, selected)),
      )
      expect(commitError).toBeInstanceOf(Error)
      expect((commitError as Error).message).toContain(`fault at ${faultPoint}`)

      const reopened = createPluginStateBroker(directory)
      const recovered = await reopened.snapshot("alpha")
      expect(recovered.text).toBe(selected)
      expect(recovered.revision).toBe(base.revision + 1)
      expect(await readFile(file, "utf8")).toBe(selected)
      expect(
        await failureOf(
          readFile(path.join(directory, ".host", "transaction.json"), "utf8"),
        ),
      ).toMatchObject({ code: "ENOENT" })
    },
  )

  test("a settings transaction publishes all plugin files at one epoch", async () => {
    const directory = await root()
    const broker = createPluginStateBroker(directory)
    const transaction = broker.beginTransaction()
    const alphaBase = await transaction.snapshot("alpha")
    const alphaText = settings("alpha", { config: { value: 1 } })
    await transaction.commit(proposal(alphaBase, alphaText, "migration"))
    const betaBase = await transaction.snapshot("beta")
    const betaText = settings("beta", { config: { value: 2 } })
    await transaction.commit(proposal(betaBase, betaText, "catalog"))

    const commits = await transaction.finish()

    expect(commits).toHaveLength(2)
    expect(new Set(commits.map((commit) => commit.epoch)).size).toBe(1)
    const [alpha, beta] = await Promise.all([
      broker.snapshot("alpha"),
      broker.snapshot("beta"),
    ])
    expect(alpha.text).toBe(alphaText)
    expect(beta.text).toBe(betaText)
    expect(alpha.epoch).toBe(beta.epoch)
  })

  test("generation selection is fenced against edits during candidate preparation", async () => {
    const directory = await root()
    const pluginDirectory = path.join(directory, "alpha")
    await mkdir(pluginDirectory, { recursive: true })
    const file = path.join(pluginDirectory, "settings.json")
    await writeFile(file, settings("alpha", { config: { value: "old" } }))
    const broker = createPluginStateBroker(directory)
    const transaction = broker.beginTransaction()
    await transaction.snapshot("alpha")
    const direct = settings("alpha", { config: { value: "person" } })
    const replacement = path.join(pluginDirectory, ".direct-edit.json")
    await writeFile(replacement, direct)
    await rename(replacement, file)
    transaction.selectGeneration({
      commitId: "commit-candidate",
      handoffIdempotencyKey: "handoff-candidate",
      generationId: "candidate",
      inventoryDigest: "sha256:candidate",
      pluginIds: ["alpha"],
    })

    const error = await failureOf(transaction.finish())

    expect(isPluginSettingsConflictError(error)).toBe(true)
    expect(await broker.committedGeneration()).toBeUndefined()
    expect(await readFile(file, "utf8")).toBe(direct)
  })

  test("identity fencing catches an A-to-B-to-A replacement", async () => {
    const directory = await root()
    const pluginDirectory = path.join(directory, "alpha")
    await mkdir(pluginDirectory, { recursive: true })
    const file = path.join(pluginDirectory, "settings.json")
    const original = settings("alpha", { config: { value: "A" } })
    await writeFile(file, original)
    const broker = createPluginStateBroker(directory)
    const stale = await broker.snapshot("alpha")
    const replacement = path.join(pluginDirectory, ".replacement.json")
    await writeFile(replacement, original)
    await rename(replacement, file)

    const observed = await broker.snapshot("alpha")

    expect(observed.text).toBe(original)
    expect(observed.revision).toBe(stale.revision + 1)
    expect(observed.epoch).toBe(stale.epoch + 1)
    const error = await broker
      .commit(
        proposal(stale, settings("alpha", { config: { value: "candidate" } })),
      )
      .catch((caught: unknown) => caught)
    expect(isPluginSettingsConflictError(error)).toBe(true)
  })

  test("a direct edit after settings rename is preserved as a later revision", async () => {
    const directory = await root()
    const pluginDirectory = path.join(directory, "alpha")
    await mkdir(pluginDirectory, { recursive: true })
    const file = path.join(pluginDirectory, "settings.json")
    await writeFile(file, settings("alpha", { config: { value: "old" } }))
    const direct = settings("alpha", { config: { value: "person" } })
    let edited = false
    const broker = createPluginStateBroker(directory, {
      async fault(point) {
        if (!edited && point === "after-settings-rename") {
          edited = true
          const replacement = path.join(pluginDirectory, ".direct-edit.json")
          await writeFile(replacement, direct)
          await rename(replacement, file)
        }
      },
    })
    const base = await broker.snapshot("alpha")

    const committed = await broker.commit(
      proposal(base, settings("alpha", { config: { value: "candidate" } })),
    )
    const latest = await broker.snapshot("alpha")

    expect(committed.text).toBe(direct)
    expect(committed.revision).toBe(base.revision + 2)
    expect(latest).toMatchObject({
      revision: committed.revision,
      epoch: committed.epoch,
      text: direct,
    })
    expect(await readFile(file, "utf8")).toBe(direct)
  })

  test("config and provider mutations share one durable no-op-aware epoch", async () => {
    const directory = await root()
    const broker = createPluginStateBroker(directory)

    expect(await broker.advanceEpoch("config", "config-a")).toBe(1)
    expect(await broker.advanceEpoch("config", "config-a")).toBe(1)
    expect(await broker.advanceEpoch("provider:copilot", "provider-a")).toBe(2)
    const base = await broker.snapshot("alpha")
    const committed = await broker.commit(
      proposal(base, settings("alpha", { config: { value: 1 } })),
    )

    expect(committed.epoch).toBe(3)
    const reopened = createPluginStateBroker(directory)
    expect(await reopened.advanceEpoch("provider:copilot", "provider-a")).toBe(
      3,
    )
    expect(await reopened.advanceEpoch("provider:copilot", "provider-b")).toBe(
      4,
    )
  })

  test("generation commits are epoch-fenced and durable", async () => {
    const directory = await root()
    const broker = createPluginStateBroker(directory)
    const alpha = await broker.snapshot("alpha")
    const committed = await broker.commitGeneration({
      commitId: "commit-1",
      handoffIdempotencyKey: "handoff-1",
      generationId: "generation-1",
      inventoryDigest: "sha256:inventory",
      baseEpoch: alpha.epoch,
      pluginRevisions: { alpha: alpha.revision },
      committedAt: "2026-01-01T00:00:00.000Z",
    })

    expect(committed.epoch).toBe(1)
    const reopened = createPluginStateBroker(directory)
    expect(await reopened.committedGeneration()).toEqual(committed)
  })

  test("runner journal retries an exact durable handoff key", async () => {
    const directory = await root()
    const broker = createPluginStateBroker(directory)
    const journal = createDurableGenerationJournal<{ version: number }>(broker)
    const record = generationRecord(await broker.epoch())
    const signal = new AbortController().signal

    expect(
      await journal.commitDurably(record.handoffIdempotencyKey, record, signal),
    ).toBe("committed")
    expect(
      await journal.commitDurably(record.handoffIdempotencyKey, record, signal),
    ).toBe("committed")
    expect(await broker.epoch()).toBe(1)
    expect(
      await journal.queryDurableCommit(record.handoffIdempotencyKey, signal),
    ).toBe("committed")
    expect(await journal.committed(signal)).toEqual(record)

    const mismatched = { ...record, artifactId: "artifact-other" }
    const mismatch = await failureOf(
      journal.commitDurably(record.handoffIdempotencyKey, mismatched, signal),
    )
    expect(mismatch).toBeInstanceOf(Error)
    expect(String(mismatch)).toContain("reused for a different selection")
  })

  test("runner journal recovers a commit with an unknown callback outcome", async () => {
    const directory = await root()
    let failed = false
    const broker = createPluginStateBroker(directory, {
      fault(point) {
        if (!failed && point === "after-commit-point") {
          failed = true
          throw new Error("lost commit acknowledgement")
        }
      },
    })
    const journal = createDurableGenerationJournal<{ version: number }>(broker)
    const record = generationRecord(await broker.epoch())
    const signal = new AbortController().signal

    const lostAcknowledgement = await failureOf(
      journal.commitDurably(record.handoffIdempotencyKey, record, signal),
    )
    expect(String(lostAcknowledgement)).toContain("lost commit acknowledgement")

    expect(
      await journal.queryDurableCommit(record.handoffIdempotencyKey, signal),
    ).toBe("committed")
    expect(await journal.committed(signal)).toEqual(record)
    await journal.markInstalled(record.commitId, signal)
    await journal.markPublished(record.commitId, signal)
    expect(await broker.committedGeneration()).toMatchObject({
      commitId: record.commitId,
      handoffIdempotencyKey: record.handoffIdempotencyKey,
      installed: true,
      published: true,
    })
  })
})
