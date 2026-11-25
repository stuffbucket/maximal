/* eslint-disable max-lines -- durable transaction and recovery protocol is kept together */
import type {
  PluginSettingsAuthority,
  PluginSettingsCommit,
  PluginSettingsProposal,
  PluginSettingsRevision,
  PluginSettingsTransaction,
} from "@stuffbucket/maximal-plugin-sdk/runtime"

import { PluginSettingsConflictError } from "@stuffbucket/maximal-plugin-sdk/runtime"
import { createHash, randomUUID } from "node:crypto"
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import path from "node:path"

const CONTROL_SCHEMA = "maximal-plugin-control/1"
const TRANSACTION_SCHEMA = "maximal-plugin-state-transaction/1"
const CONTROL_DIRECTORY = ".host"
const CONTROL_FILE = "control-plane.json"
const TRANSACTION_FILE = "transaction.json"
const DIR_MODE = 0o700
const FILE_MODE = 0o600
const MAX_STABLE_READ_ATTEMPTS = 8

interface FileGeneration {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly birthtimeMs: number
}

interface PluginControlRecord {
  revision: number
  digest?: string
}

export interface CommittedPluginGeneration {
  commitId: string
  /** Stable across every retry of the same exclusive-resource handoff. */
  handoffIdempotencyKey: string
  generationId: string
  inventoryDigest: string
  committedAt: string
  epoch: number
  pluginRevisions: Readonly<Record<string, number>>
  /** Serializable resolved inventory used to recover the selected generation. */
  inventory?: unknown
  /** Full runner cutover record when selection came through the supervisor. */
  generationRecord?: unknown
  installed?: boolean
  published?: boolean
}

interface ControlMutation {
  kind: string
  committedAt: string
  digest?: string
}

interface ControlDocument {
  $schema: typeof CONTROL_SCHEMA
  epoch: number
  plugins: Partial<Record<string, PluginControlRecord>>
  committedGeneration?: CommittedPluginGeneration
  lastMutation?: ControlMutation
  mutationDigests?: Partial<Record<string, string>>
}

interface FileState {
  readonly text: string | undefined
  readonly digest: string | undefined
  readonly generation: FileGeneration | undefined
}

interface CachedPluginState extends FileState {
  readonly revision: number
}

interface TransactionWrite {
  readonly pluginId: string
  readonly target: string
  readonly temp: string
  readonly text: string
  readonly digest: string
  readonly baseDigest: string | undefined
  readonly baseGeneration: FileGeneration | undefined
  readonly tempGeneration: FileGeneration
}

interface TransactionDocument {
  readonly $schema: typeof TRANSACTION_SCHEMA
  readonly id: string
  readonly control: ControlDocument
  readonly writes: ReadonlyArray<TransactionWrite>
}

export interface GenerationCommitProposal {
  commitId: string
  handoffIdempotencyKey: string
  generationId: string
  inventoryDigest: string
  baseEpoch: number
  pluginRevisions: Readonly<Record<string, number>>
  committedAt?: string
  /** Serializable runner cutover record selected at this commit point. */
  generationRecord?: unknown
}

export type StateBrokerFaultPoint =
  | "after-settings-temp-sync"
  | "before-commit-point"
  | "after-commit-point"
  | "after-settings-rename"
  | "after-control-rename"

export interface PluginStateBrokerOptions {
  /** Deterministic fault seam for crash/recovery tests. */
  fault?(point: StateBrokerFaultPoint): Promise<void> | void
}

export interface StagedGenerationProposal {
  commitId: string
  handoffIdempotencyKey: string
  generationId: string
  inventoryDigest: string
  pluginIds: ReadonlyArray<string>
  committedAt?: string
  /** Serializable resolved inventory selected at the same commit point. */
  inventory?: unknown
}

export interface PluginStateTransaction extends PluginSettingsTransaction {
  selectGeneration(proposal: StagedGenerationProposal): void
}

export interface PluginStateBroker extends PluginSettingsAuthority {
  beginTransaction(): PluginStateTransaction
  /** Persist the selected generation after fencing every settings revision. */
  commitGeneration(
    proposal: GenerationCommitProposal,
  ): Promise<CommittedPluginGeneration>
  committedGeneration(): Promise<CommittedPluginGeneration | undefined>
  markGenerationInstalled(commitId: string): Promise<void>
  markGenerationPublished(commitId: string): Promise<void>
  /** Advance the same durable epoch for another authoritative control mutation. */
  advanceEpoch(kind: string, mutationDigest?: string): Promise<number>
}

function digest(text: string): string
function digest(text: undefined): undefined
function digest(text: string | undefined): string | undefined {
  return text === undefined ? undefined : (
      createHash("sha256").update(text).digest("hex")
    )
}

function freshControl(): ControlDocument {
  return { $schema: CONTROL_SCHEMA, epoch: 0, plugins: {} }
}

function validNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parsePluginRecords(
  value: unknown,
): Partial<Record<string, PluginControlRecord>> {
  if (!isRecord(value))
    throw new Error("Plugin control-plane metadata has invalid revisions.")
  const plugins: Partial<Record<string, PluginControlRecord>> = {}
  for (const [id, entry] of Object.entries(value)) {
    if (!isRecord(entry) || !validNonnegativeInteger(entry.revision))
      throw new Error(`Plugin control-plane revision for "${id}" is invalid.`)
    if (entry.digest !== undefined && typeof entry.digest !== "string")
      throw new Error(`Plugin control-plane digest for "${id}" is invalid.`)
    plugins[id] = {
      revision: entry.revision,
      ...(entry.digest === undefined ? {} : { digest: entry.digest }),
    }
  }
  return plugins
}

// eslint-disable-next-line complexity -- validates every persisted generation field together
function parseGeneration(value: unknown): CommittedPluginGeneration {
  if (!isRecord(value) || !isRecord(value.pluginRevisions))
    throw new Error("Plugin control-plane generation metadata is invalid.")
  if (
    typeof value.generationId !== "string"
    || typeof value.inventoryDigest !== "string"
    || typeof value.committedAt !== "string"
    || !validNonnegativeInteger(value.epoch)
    || (value.commitId !== undefined && typeof value.commitId !== "string")
    || (value.handoffIdempotencyKey !== undefined
      && typeof value.handoffIdempotencyKey !== "string")
    || (value.installed !== undefined && typeof value.installed !== "boolean")
    || (value.published !== undefined && typeof value.published !== "boolean")
  )
    throw new Error("Plugin control-plane generation metadata is invalid.")
  const pluginRevisions: Record<string, number> = {}
  for (const [id, revision] of Object.entries(value.pluginRevisions)) {
    if (!validNonnegativeInteger(revision))
      throw new Error(`Plugin generation revision for "${id}" is invalid.`)
    pluginRevisions[id] = revision
  }
  const commitId = value.commitId ?? value.generationId
  const handoffIdempotencyKey =
    value.handoffIdempotencyKey
    ?? `legacy:${value.generationId}:${value.inventoryDigest}`
  return {
    commitId,
    handoffIdempotencyKey,
    generationId: value.generationId,
    inventoryDigest: value.inventoryDigest,
    committedAt: value.committedAt,
    epoch: value.epoch,
    pluginRevisions,
    ...(value.inventory === undefined ? {} : { inventory: value.inventory }),
    ...(value.generationRecord === undefined ?
      {}
    : { generationRecord: value.generationRecord }),
    ...(value.installed === undefined ? {} : { installed: value.installed }),
    ...(value.published === undefined ? {} : { published: value.published }),
  }
}

function parseMutation(value: unknown): ControlMutation | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value)
    || typeof value.kind !== "string"
    || typeof value.committedAt !== "string"
    || (value.digest !== undefined && typeof value.digest !== "string")
  )
    throw new Error("Plugin control-plane mutation metadata is invalid.")
  return {
    kind: value.kind,
    committedAt: value.committedAt,
    ...(value.digest === undefined ? {} : { digest: value.digest }),
  }
}

function parseControlValue(value: unknown): ControlDocument {
  if (!isRecord(value))
    throw new Error("Plugin control-plane metadata must be an object.")
  if (value.$schema !== CONTROL_SCHEMA || !validNonnegativeInteger(value.epoch))
    throw new Error("Plugin control-plane metadata has an unsupported schema.")
  const lastMutation = parseMutation(value.lastMutation)
  let mutationDigests: Record<string, string> | undefined
  if (value.mutationDigests !== undefined) {
    if (!isRecord(value.mutationDigests))
      throw new Error("Plugin control-plane mutation digests are invalid.")
    mutationDigests = {}
    for (const [kind, mutationDigest] of Object.entries(
      value.mutationDigests,
    )) {
      if (typeof mutationDigest !== "string")
        throw new Error("Plugin control-plane mutation digests are invalid.")
      mutationDigests[kind] = mutationDigest
    }
  }
  return {
    $schema: CONTROL_SCHEMA,
    epoch: value.epoch,
    plugins: parsePluginRecords(value.plugins),
    ...(value.committedGeneration === undefined ?
      {}
    : { committedGeneration: parseGeneration(value.committedGeneration) }),
    ...(lastMutation === undefined ? {} : { lastMutation }),
    ...(mutationDigests === undefined ? {} : { mutationDigests }),
  }
}

function parseControl(text: string | undefined): ControlDocument {
  if (text === undefined) return freshControl()
  try {
    return parseControlValue(JSON.parse(text))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError("Plugin control-plane metadata is not valid JSON.", {
        cause: error,
      })
    }
    throw error
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function generationOf(value: {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
}): FileGeneration {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
    birthtimeMs: value.birthtimeMs,
  }
}

function parseFileGeneration(value: unknown): FileGeneration {
  if (!isRecord(value))
    throw new Error("Plugin state transaction has an invalid file generation.")
  const fields = [
    "dev",
    "ino",
    "size",
    "mtimeMs",
    "ctimeMs",
    "birthtimeMs",
  ] as const
  for (const field of fields) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field]))
      throw new Error(
        "Plugin state transaction has an invalid file generation.",
      )
  }
  return generationOf(value as unknown as FileGeneration)
}

function sameGeneration(
  left: FileGeneration | undefined,
  right: FileGeneration | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs
  )
}

function sameObject(left: FileGeneration, right: FileGeneration): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** Rename may change ctime, while content writes change mtime and replacements
 * change inode. These fields identify the synced temp after installation. */
function sameInstalledGeneration(
  left: FileGeneration | undefined,
  right: FileGeneration,
): boolean {
  return (
    left !== undefined
    && sameObject(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.birthtimeMs === right.birthtimeMs
  )
}

function cloneControl(control: ControlDocument): ControlDocument {
  return structuredClone(control)
}

function sameRevisions(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const leftEntries = Object.entries(left)
  return (
    leftEntries.length === Object.keys(right).length
    && leftEntries.every(([id, revision]) => right[id] === revision)
  )
}

function recordLaterSettingsState(
  control: ControlDocument,
  write: TransactionWrite,
  observed: FileState,
): void {
  const record = control.plugins[write.pluginId]
  if (!record)
    throw new Error(`Transaction metadata for "${write.pluginId}" is missing.`)
  control.epoch += 1
  control.plugins[write.pluginId] = {
    revision: record.revision + 1,
    ...(observed.digest === undefined ? {} : { digest: observed.digest }),
  }
  control.lastMutation = {
    kind: "direct-edit",
    committedAt: new Date().toISOString(),
    ...(observed.digest === undefined ? {} : { digest: observed.digest }),
  }
}

// eslint-disable-next-line max-params -- mirrors the conflict error's two CAS coordinates
function conflict(
  pluginId: string,
  expectedRevision: number,
  actualRevision: number,
  expectedEpoch: number,
  actualEpoch: number,
): PluginSettingsConflictError {
  return new PluginSettingsConflictError({
    pluginId,
    expectedRevision,
    actualRevision,
    expectedEpoch,
    actualEpoch,
  })
}

class FilePluginStateBroker implements PluginStateBroker {
  readonly #storageRoot: string
  readonly #controlDirectory: string
  readonly #controlFile: string
  readonly #transactionFile: string
  readonly #fault: PluginStateBrokerOptions["fault"]
  readonly #cache = new Map<string, CachedPluginState>()
  #control: ControlDocument | undefined
  #queue: Promise<void> = Promise.resolve()

  constructor(storageRoot: string, options: PluginStateBrokerOptions) {
    this.#storageRoot = path.resolve(storageRoot)
    this.#controlDirectory = path.join(this.#storageRoot, CONTROL_DIRECTORY)
    this.#controlFile = path.join(this.#controlDirectory, CONTROL_FILE)
    this.#transactionFile = path.join(this.#controlDirectory, TRANSACTION_FILE)
    this.#fault =
      options.fault === undefined ?
        undefined
      : (point) => options.fault?.(point)
  }

  snapshot(pluginId: string): Promise<PluginSettingsRevision> {
    return this.#run(async () => {
      await this.#loadControl()
      const state = await this.#sync(pluginId)
      return Object.freeze({
        pluginId,
        revision: state.revision,
        epoch: this.#controlDocument().epoch,
        ...(state.text === undefined ? {} : { text: state.text }),
      })
    })
  }

  commit(proposal: PluginSettingsProposal): Promise<PluginSettingsCommit> {
    return this.#run(async () => {
      const commits = await this.#commitProposals([proposal])
      return commits[0]
    })
  }

  // eslint-disable-next-line max-lines-per-function -- transaction closure shares staged CAS state
  beginTransaction(): PluginStateTransaction {
    const base = new Map<string, PluginSettingsRevision>()
    const staged = new Map<string, PluginSettingsRevision>()
    let baseEpoch: number | undefined
    let localEpoch: number | undefined
    let stagedGeneration: StagedGenerationProposal | undefined
    let closed = false
    const ensureOpen = (): void => {
      if (closed) throw new Error("Plugin settings transaction is closed.")
    }
    const snapshot = async (
      pluginId: string,
    ): Promise<PluginSettingsRevision> => {
      ensureOpen()
      const current = staged.get(pluginId)
      if (current) return current
      let initial = base.get(pluginId)
      if (!initial) {
        initial = await this.snapshot(pluginId)
        if (baseEpoch !== undefined && initial.epoch !== baseEpoch) {
          throw conflict(
            pluginId,
            initial.revision,
            initial.revision,
            baseEpoch,
            initial.epoch,
          )
        }
        baseEpoch ??= initial.epoch
        localEpoch ??= initial.epoch
        base.set(pluginId, initial)
      }
      return Object.freeze({ ...initial, epoch: localEpoch ?? initial.epoch })
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- object methods need private broker access
    const owner = this
    const transaction: PluginStateTransaction = {
      snapshot,
      async commit(proposal) {
        const current = await snapshot(proposal.pluginId)
        const epoch = localEpoch ?? current.epoch
        if (
          current.revision !== proposal.baseRevision
          || epoch !== proposal.baseEpoch
        ) {
          throw conflict(
            proposal.pluginId,
            proposal.baseRevision,
            current.revision,
            proposal.baseEpoch,
            epoch,
          )
        }
        if (current.text === proposal.text) {
          return Object.freeze({
            pluginId: proposal.pluginId,
            revision: current.revision,
            epoch,
            text: proposal.text,
          })
        }
        localEpoch = epoch + 1
        const next = Object.freeze({
          pluginId: proposal.pluginId,
          revision: current.revision + 1,
          epoch: localEpoch,
          text: proposal.text,
        })
        staged.set(proposal.pluginId, next)
        return next
      },
      async epoch() {
        ensureOpen()
        if (localEpoch !== undefined) return localEpoch
        const epoch = await owner.epoch()
        baseEpoch = epoch
        // Transaction methods are caller-serialized; the broker queue serializes authority reads.
        // eslint-disable-next-line require-atomic-updates
        localEpoch = epoch
        return epoch
      },
      beginTransaction() {
        throw new Error(
          "Nested plugin settings transactions are not supported.",
        )
      },
      selectGeneration(proposal) {
        ensureOpen()
        if (stagedGeneration)
          throw new Error(
            "A generation is already selected in this transaction.",
          )
        stagedGeneration = {
          ...proposal,
          pluginIds: [...proposal.pluginIds],
          ...(proposal.inventory === undefined ?
            {}
          : { inventory: structuredClone(proposal.inventory) }),
        }
      },
      async finish() {
        ensureOpen()
        closed = true
        const proposals: Array<PluginSettingsProposal> = []
        for (const [pluginId, current] of staged) {
          const initial = base.get(pluginId)
          if (!initial || current.text === undefined) continue
          proposals.push({
            pluginId,
            baseRevision: initial.revision,
            baseEpoch: initial.epoch,
            kind: "migration",
            text: current.text,
          })
        }
        return await owner.#run(() =>
          owner.#commitProposals(proposals, stagedGeneration, baseEpoch),
        )
      },
      rollback() {
        closed = true
        staged.clear()
      },
    }
    return transaction
  }

  epoch(): Promise<number> {
    return this.#run(async () => {
      await this.#loadControl()
      return this.#controlDocument().epoch
    })
  }

  advanceEpoch(kind: string, mutationDigest?: string): Promise<number> {
    return this.#run(async () => {
      await this.#loadControl()
      const current = this.#controlDocument()
      if (
        mutationDigest !== undefined
        && current.mutationDigests?.[kind] === mutationDigest
      )
        return current.epoch
      const next = cloneControl(current)
      next.epoch += 1
      next.lastMutation = {
        kind,
        committedAt: new Date().toISOString(),
        ...(mutationDigest === undefined ? {} : { digest: mutationDigest }),
      }
      if (mutationDigest !== undefined) {
        next.mutationDigests = {
          ...next.mutationDigests,
          [kind]: mutationDigest,
        }
      }
      await this.#commitDocument(next, [])
      return next.epoch
    })
  }

  commitGeneration(
    proposal: GenerationCommitProposal,
  ): Promise<CommittedPluginGeneration> {
    return this.#run(async () => {
      await this.#loadControl()
      const current = this.#controlDocument()
      for (const [pluginId, revision] of Object.entries(
        proposal.pluginRevisions,
      )) {
        const state = await this.#sync(pluginId)
        if (
          state.revision !== revision
          || current.epoch !== proposal.baseEpoch
        ) {
          throw conflict(
            pluginId,
            revision,
            state.revision,
            proposal.baseEpoch,
            current.epoch,
          )
        }
      }
      if (current.epoch !== proposal.baseEpoch) {
        throw conflict("<generation>", 0, 0, proposal.baseEpoch, current.epoch)
      }
      const next = cloneControl(current)
      next.epoch += 1
      const committed = Object.freeze({
        commitId: proposal.commitId,
        handoffIdempotencyKey: proposal.handoffIdempotencyKey,
        generationId: proposal.generationId,
        inventoryDigest: proposal.inventoryDigest,
        committedAt: proposal.committedAt ?? new Date().toISOString(),
        epoch: next.epoch,
        pluginRevisions: Object.freeze({ ...proposal.pluginRevisions }),
        ...(proposal.generationRecord === undefined ?
          {}
        : { generationRecord: structuredClone(proposal.generationRecord) }),
      })
      next.committedGeneration = committed
      next.lastMutation = {
        kind: "generation",
        committedAt: committed.committedAt,
        digest: proposal.inventoryDigest,
      }
      await this.#commitDocument(next, [])
      return committed
    })
  }

  committedGeneration(): Promise<CommittedPluginGeneration | undefined> {
    return this.#run(async () => {
      await this.#loadControl()
      const committed = this.#controlDocument().committedGeneration
      return committed === undefined ? undefined : structuredClone(committed)
    })
  }

  markGenerationInstalled(commitId: string): Promise<void> {
    return this.#markGenerationProgress(commitId, "installed")
  }

  markGenerationPublished(commitId: string): Promise<void> {
    return this.#markGenerationProgress(commitId, "published")
  }

  #markGenerationProgress(
    commitId: string,
    marker: "installed" | "published",
  ): Promise<void> {
    return this.#run(async () => {
      await this.#loadControl()
      const current = this.#controlDocument()
      const committed = current.committedGeneration
      if (!committed || committed.commitId !== commitId) {
        throw new Error(
          `Plugin generation commit "${commitId}" is not selected.`,
        )
      }
      if (committed[marker] === true) return
      const next = cloneControl(current)
      const selected = next.committedGeneration
      if (!selected) throw new Error("Committed plugin generation is missing.")
      selected[marker] = true
      await this.#commitDocument(next, [])
    })
  }

  #run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task)
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  #settingsFile(pluginId: string): string {
    if (!/^[a-z0-9][\w.-]{0,127}$/i.test(pluginId)) {
      throw new Error(`Invalid plugin storage id "${pluginId}".`)
    }
    const file = path.join(this.#storageRoot, pluginId, "settings.json")
    const relative = path.relative(this.#storageRoot, file)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Plugin storage id "${pluginId}" escapes its root.`)
    }
    return file
  }

  async #loadControl(): Promise<void> {
    if (this.#control) return
    await this.#ensureDirectory(this.#controlDirectory)
    const transactionText = await this.#readText(this.#transactionFile)
    if (transactionText !== undefined) {
      const transaction = this.#parseTransaction(transactionText)
      await this.#finishCommittedTransaction(transaction)
    }
    this.#control = parseControl(await this.#readText(this.#controlFile))
  }

  #controlDocument(): ControlDocument {
    if (!this.#control)
      throw new Error("Plugin state broker is not initialized.")
    return this.#control
  }

  async #readText(file: string): Promise<string | undefined> {
    try {
      return await readFile(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  async #readStable(file: string): Promise<FileState> {
    for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
      let handle
      try {
        handle = await open(file, "r")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { text: undefined, digest: undefined, generation: undefined }
        }
        throw error
      }
      try {
        const before = generationOf(await handle.stat())
        const text = await handle.readFile({ encoding: "utf8" })
        const after = generationOf(await handle.stat())
        if (!sameGeneration(before, after)) continue
        let linked
        try {
          linked = generationOf(await stat(file))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
          throw error
        }
        if (!sameGeneration(after, linked) || !sameObject(after, linked))
          continue
        return { text, digest: digest(text), generation: after }
      } finally {
        await handle.close()
      }
    }
    throw new Error(`Could not read a stable plugin settings file at ${file}.`)
  }

  async #sync(pluginId: string): Promise<CachedPluginState> {
    const observed = await this.#readStable(this.#settingsFile(pluginId))
    const cached = this.#cache.get(pluginId)
    if (
      cached
      && cached.digest === observed.digest
      && sameGeneration(cached.generation, observed.generation)
    )
      return cached
    const control = this.#controlDocument()
    const recorded = control.plugins[pluginId]
    if (!cached && recorded && recorded.digest === observed.digest) {
      const initial = { ...observed, revision: recorded.revision }
      this.#cache.set(pluginId, initial)
      return initial
    }
    if (!cached && recorded === undefined) {
      const initial = { ...observed, revision: 0 }
      this.#cache.set(pluginId, initial)
      return initial
    }
    const revision =
      Math.max(cached?.revision ?? 0, recorded?.revision ?? 0) + 1
    const next = cloneControl(control)
    next.epoch += 1
    next.plugins[pluginId] = {
      revision,
      ...(observed.digest === undefined ? {} : { digest: observed.digest }),
    }
    next.lastMutation = {
      kind: "direct-edit",
      committedAt: new Date().toISOString(),
      ...(observed.digest === undefined ? {} : { digest: observed.digest }),
    }
    await this.#commitDocument(next, [])
    const changed = { ...observed, revision }
    this.#cache.set(pluginId, changed)
    return changed
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- atomic validation, selection, and commit stay together
  async #commitProposals(
    proposals: ReadonlyArray<PluginSettingsProposal>,
    generation?: StagedGenerationProposal,
    expectedEpoch?: number,
  ): Promise<ReadonlyArray<PluginSettingsCommit>> {
    await this.#loadControl()
    const states = new Map<string, CachedPluginState>()
    for (const proposal of proposals) {
      if (states.has(proposal.pluginId))
        throw new Error(`Duplicate proposal for plugin "${proposal.pluginId}".`)
      states.set(proposal.pluginId, await this.#sync(proposal.pluginId))
    }
    for (const pluginId of generation?.pluginIds ?? []) {
      if (!states.has(pluginId))
        states.set(pluginId, await this.#sync(pluginId))
    }
    const current = this.#controlDocument()
    if (expectedEpoch !== undefined && current.epoch !== expectedEpoch) {
      throw conflict("<transaction>", 0, 0, expectedEpoch, current.epoch)
    }
    for (const proposal of proposals) {
      const state = states.get(proposal.pluginId)
      if (!state) throw new Error("Missing settings proposal state.")
      if (
        state.revision !== proposal.baseRevision
        || current.epoch !== proposal.baseEpoch
      ) {
        throw conflict(
          proposal.pluginId,
          proposal.baseRevision,
          state.revision,
          proposal.baseEpoch,
          current.epoch,
        )
      }
    }
    const changed = proposals.filter(
      (proposal) => states.get(proposal.pluginId)?.text !== proposal.text,
    )
    const selectedRevisions: Record<string, number> = {}
    for (const pluginId of generation?.pluginIds ?? []) {
      const state = states.get(pluginId)
      if (!state)
        throw new Error(`Generation plugin "${pluginId}" has no revision.`)
      selectedRevisions[pluginId] =
        state.revision
        + (changed.some((proposal) => proposal.pluginId === pluginId) ? 1 : 0)
    }
    const selected = current.committedGeneration
    const generationUnchanged =
      generation !== undefined
      && selected?.commitId === generation.commitId
      && selected.handoffIdempotencyKey === generation.handoffIdempotencyKey
      && selected.generationId === generation.generationId
      && selected.inventoryDigest === generation.inventoryDigest
      && sameRevisions(selected.pluginRevisions, selectedRevisions)
    if (
      changed.length === 0
      && (generation === undefined || generationUnchanged)
    ) {
      return proposals.map((proposal) => {
        const state = states.get(proposal.pluginId)
        if (!state) throw new Error("Missing settings proposal state.")
        return Object.freeze({
          pluginId: proposal.pluginId,
          revision: state.revision,
          epoch: current.epoch,
          text: proposal.text,
        })
      })
    }
    const next = cloneControl(current)
    next.epoch += 1
    for (const proposal of changed) {
      const state = states.get(proposal.pluginId)
      if (!state) throw new Error("Missing settings proposal state.")
      next.plugins[proposal.pluginId] = {
        revision: state.revision + 1,
        digest: digest(proposal.text),
      }
    }
    if (generation) {
      const pluginRevisions: Record<string, number> = {}
      for (const pluginId of generation.pluginIds) {
        const revision =
          next.plugins[pluginId]?.revision ?? states.get(pluginId)?.revision
        if (revision === undefined)
          throw new Error(`Generation plugin "${pluginId}" has no revision.`)
        pluginRevisions[pluginId] = revision
      }
      const committedAt = generation.committedAt ?? new Date().toISOString()
      next.committedGeneration = {
        commitId: generation.commitId,
        handoffIdempotencyKey: generation.handoffIdempotencyKey,
        generationId: generation.generationId,
        inventoryDigest: generation.inventoryDigest,
        committedAt,
        epoch: next.epoch,
        pluginRevisions,
        ...(generation.inventory === undefined ?
          {}
        : { inventory: structuredClone(generation.inventory) }),
      }
      next.lastMutation = {
        kind: "generation",
        committedAt,
        digest: generation.inventoryDigest,
      }
    } else {
      next.lastMutation = {
        kind: changed.length === 1 ? changed[0].kind : "settings-batch",
        committedAt: new Date().toISOString(),
      }
    }
    await this.#commitDocument(
      next,
      changed.map((proposal) => {
        const base = states.get(proposal.pluginId)
        if (!base) throw new Error("Missing settings proposal state.")
        return { proposal, base }
      }),
    )
    return proposals.map((proposal) => {
      const record = this.#controlDocument().plugins[proposal.pluginId]
      if (!record) throw new Error("Committed settings metadata is missing.")
      const latest = this.#cache.get(proposal.pluginId)
      return Object.freeze({
        pluginId: proposal.pluginId,
        revision: record.revision,
        epoch: this.#controlDocument().epoch,
        text: latest?.text ?? proposal.text,
      })
    })
  }

  async #ensureDirectory(directory: string): Promise<void> {
    const missing: Array<string> = []
    let candidate = directory
    for (;;) {
      try {
        const existing = await stat(candidate)
        if (!existing.isDirectory())
          throw new Error(`Plugin state path is not a directory: ${candidate}`)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        missing.push(candidate)
        const parent = path.dirname(candidate)
        if (parent === candidate) throw error
        candidate = parent
      }
    }
    await mkdir(directory, { recursive: true, mode: DIR_MODE })
    for (const created of missing.reverse()) {
      if (process.platform !== "win32") await chmod(created, DIR_MODE)
      await this.#syncDirectory(created)
      await this.#syncDirectory(path.dirname(created))
    }
    if (missing.length === 0) {
      if (process.platform !== "win32") await chmod(directory, DIR_MODE)
      await this.#syncDirectory(directory)
    }
  }

  async #syncDirectory(directory: string): Promise<void> {
    if (process.platform === "win32") return
    const handle = await open(directory, "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async #writeTemp(file: string, text: string): Promise<FileGeneration> {
    const directory = path.dirname(file)
    await this.#ensureDirectory(directory)
    const handle = await open(file, "wx", FILE_MODE)
    let generation: FileGeneration
    try {
      await handle.writeFile(text, { encoding: "utf8" })
      if (process.platform !== "win32") await handle.chmod(FILE_MODE)
      await handle.sync()
      generation = generationOf(await handle.stat())
    } finally {
      await handle.close()
    }
    // The journal may commit immediately after this returns, so the temp's
    // directory entry must already survive a crash as well as its file bytes.
    await this.#syncDirectory(directory)
    return generation
  }

  async #durableRename(source: string, target: string): Promise<void> {
    await rename(source, target)
    await this.#syncDirectory(path.dirname(target))
  }

  async #commitDocument(
    control: ControlDocument,
    changes: ReadonlyArray<{
      proposal: PluginSettingsProposal
      base: CachedPluginState
    }>,
  ): Promise<void> {
    const id = randomUUID()
    const writes: Array<TransactionWrite> = []
    const cleanup: Array<string> = []
    let committed = false
    try {
      for (const { proposal, base } of changes) {
        const target = this.#settingsFile(proposal.pluginId)
        const temp = path.join(path.dirname(target), `.settings.json.${id}.tmp`)
        cleanup.push(temp)
        const tempGeneration = await this.#writeTemp(temp, proposal.text)
        writes.push({
          pluginId: proposal.pluginId,
          target,
          temp,
          text: proposal.text,
          digest: digest(proposal.text),
          baseDigest: base.digest,
          baseGeneration: base.generation,
          tempGeneration,
        })
      }
      await this.#fault?.("after-settings-temp-sync")
      const transaction: TransactionDocument = {
        $schema: TRANSACTION_SCHEMA,
        id,
        control: cloneControl(control),
        writes,
      }
      const journalTemp = path.join(
        this.#controlDirectory,
        `.${TRANSACTION_FILE}.${id}.tmp`,
      )
      cleanup.push(journalTemp)
      await this.#writeTemp(journalTemp, serialize(transaction))
      await this.#fault?.("before-commit-point")
      await this.#durableRename(journalTemp, this.#transactionFile)
      committed = true
      await this.#fault?.("after-commit-point")
      await this.#finishCommittedTransaction(transaction)
    } catch (error) {
      if (!committed) {
        await Promise.all(cleanup.map((file) => rm(file, { force: true })))
      } else {
        this.#control = undefined
        this.#cache.clear()
      }
      throw error
    }
  }

  // eslint-disable-next-line complexity -- recovery handles pre-rename, installed, and later-edit states
  async #finishCommittedTransaction(
    transaction: TransactionDocument,
  ): Promise<void> {
    const control = cloneControl(transaction.control)
    const finalStates = new Map<string, FileState>()
    for (const write of transaction.writes) {
      let observed = await this.#readStable(write.target)
      const isBase =
        observed.digest === write.baseDigest
        && sameGeneration(observed.generation, write.baseGeneration)
      const isInstalled =
        observed.digest === write.digest
        && sameInstalledGeneration(observed.generation, write.tempGeneration)
      if (isBase) {
        await this.#durableRename(write.temp, write.target)
        await this.#fault?.("after-settings-rename")
        observed = await this.#readStable(write.target)
        if (
          observed.digest !== write.digest
          || !sameInstalledGeneration(observed.generation, write.tempGeneration)
        ) {
          // Rename linearized the selected transaction. A different generation
          // observed afterwards is a later direct edit, including A→B→A.
          recordLaterSettingsState(control, write, observed)
        }
      } else if (!isInstalled) {
        // A direct edit after the journal rename is a later authoritative
        // revision. Preserve it and place it after the selected transaction.
        recordLaterSettingsState(control, write, observed)
      }
      finalStates.set(write.pluginId, observed)
      await rm(write.temp, { force: true })
    }

    for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
      const controlTemp = path.join(
        this.#controlDirectory,
        `.${CONTROL_FILE}.${transaction.id}.${attempt}.tmp`,
      )
      await this.#writeTemp(controlTemp, serialize(control))
      await this.#durableRename(controlTemp, this.#controlFile)
      await this.#fault?.("after-control-rename")

      let changed = false
      for (const write of transaction.writes) {
        const observed = await this.#readStable(write.target)
        const previous = finalStates.get(write.pluginId)
        if (
          previous
          && previous.digest === observed.digest
          && sameGeneration(previous.generation, observed.generation)
        )
          continue
        recordLaterSettingsState(control, write, observed)
        finalStates.set(write.pluginId, observed)
        changed = true
      }
      if (!changed) {
        await rm(this.#transactionFile, { force: true })
        await this.#syncDirectory(this.#controlDirectory)
        this.#control = control
        for (const write of transaction.writes) {
          const state = finalStates.get(write.pluginId)
          const record = control.plugins[write.pluginId]
          if (!state || !record)
            throw new Error("Committed plugin settings state is incomplete.")
          this.#cache.set(write.pluginId, {
            ...state,
            revision: record.revision,
          })
        }
        return
      }
    }
    throw new Error(
      "Plugin settings kept changing during transaction recovery.",
    )
  }

  // eslint-disable-next-line complexity -- persisted journal fields are validated in one parser
  #parseTransaction(text: string): TransactionDocument {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      throw new Error("Plugin state transaction is not valid JSON.", {
        cause: error,
      })
    }
    if (
      !isRecord(value)
      || value.$schema !== TRANSACTION_SCHEMA
      || typeof value.id !== "string"
      || !Array.isArray(value.writes)
    )
      throw new Error("Plugin state transaction has an unsupported schema.")
    const writes: Array<TransactionWrite> = []
    for (const item of value.writes) {
      if (
        !isRecord(item)
        || typeof item.pluginId !== "string"
        || typeof item.target !== "string"
        || typeof item.temp !== "string"
        || typeof item.text !== "string"
        || typeof item.digest !== "string"
        || (item.baseDigest !== undefined
          && typeof item.baseDigest !== "string")
        || !isRecord(item.tempGeneration)
        || (item.baseGeneration !== undefined && !isRecord(item.baseGeneration))
      )
        throw new Error("Plugin state transaction contains an invalid write.")
      const target = this.#settingsFile(item.pluginId)
      if (
        item.target !== target
        || path.dirname(item.temp) !== path.dirname(target)
      )
        throw new Error("Plugin state transaction contains an unsafe path.")
      writes.push({
        pluginId: item.pluginId,
        target: item.target,
        temp: item.temp,
        text: item.text,
        digest: item.digest,
        baseDigest: item.baseDigest,
        baseGeneration:
          item.baseGeneration === undefined ?
            undefined
          : parseFileGeneration(item.baseGeneration),
        tempGeneration: parseFileGeneration(item.tempGeneration),
      })
    }
    return {
      $schema: TRANSACTION_SCHEMA,
      id: value.id,
      control: parseControlValue(value.control),
      writes,
    }
  }
}

/**
 * Parent-side authority for host-reserved plugin documents. Plugin code keeps
 * direct access to ordinary files in its data directory, but `settings.json`
 * is rejected by the storage service and only this broker writes it.
 */
export function createPluginStateBroker(
  storageRoot: string,
  options: PluginStateBrokerOptions = {},
): PluginStateBroker {
  return new FilePluginStateBroker(storageRoot, options)
}
