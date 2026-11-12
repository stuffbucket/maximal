import { isPluginSettingsConflictError } from "@stuffbucket/maximal-plugin-sdk/runtime"
import { createHash } from "node:crypto"

import type {
  DurableCommitState,
  DurableGenerationJournal,
  GenerationCommitRecord,
} from "./generation-cutover"
import type {
  CommittedPluginGeneration,
  PluginStateBroker,
} from "./state-broker"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isGenerationCommitRecord<TSnapshot>(
  value: unknown,
): value is GenerationCommitRecord<TSnapshot> {
  return (
    isRecord(value)
    && typeof value.commitId === "string"
    && typeof value.handoffIdempotencyKey === "string"
    && typeof value.previousGenerationId === "string"
    && typeof value.generationId === "string"
    && typeof value.artifactId === "string"
    && isRecord(value.fence)
    && typeof value.fence.epoch === "number"
    && isRecord(value.fence.settingsRevisions)
    && isRecord(value.fence.providerRevisions)
    && typeof value.snapshotRevision === "number"
    && Array.isArray(value.health)
    && Array.isArray(value.previousHealth)
    && Array.isArray(value.resources)
    && Array.isArray(value.events)
    && Object.hasOwn(value, "snapshot")
  )
}

function serializedRecord<TSnapshot>(
  record: GenerationCommitRecord<TSnapshot>,
): string {
  return JSON.stringify(record)
}

function recordDigest<TSnapshot>(
  record: GenerationCommitRecord<TSnapshot>,
): string {
  return createHash("sha256").update(serializedRecord(record)).digest("hex")
}

function selectedRecord<TSnapshot>(
  selected: CommittedPluginGeneration | undefined,
): GenerationCommitRecord<TSnapshot> | undefined {
  if (selected?.generationRecord === undefined) return undefined
  if (!isGenerationCommitRecord<TSnapshot>(selected.generationRecord)) {
    throw new Error("Durable plugin generation commit record is invalid.")
  }
  const record = selected.generationRecord
  if (
    record.commitId !== selected.commitId
    || record.handoffIdempotencyKey !== selected.handoffIdempotencyKey
    || record.generationId !== selected.generationId
  ) {
    throw new Error("Durable plugin generation selection is inconsistent.")
  }
  return structuredClone(record)
}

function sameRecord<TSnapshot>(
  left: GenerationCommitRecord<TSnapshot>,
  right: GenerationCommitRecord<TSnapshot>,
): boolean {
  return serializedRecord(left) === serializedRecord(right)
}

/**
 * Adapts the unified plugin control journal to the runner cutover protocol. The
 * broker's transaction rename is the durable commit point for both settings and
 * generation selection, so an ambiguous callback can be queried by the same
 * handoff key after a crash.
 */
export function createDurableGenerationJournal<TSnapshot>(
  broker: PluginStateBroker,
): DurableGenerationJournal<TSnapshot> {
  return {
    async committed(signal) {
      signal.throwIfAborted()
      const selected = await broker.committedGeneration()
      signal.throwIfAborted()
      return selectedRecord<TSnapshot>(selected)
    },

    async commitDurably(idempotencyKey, record, signal) {
      signal.throwIfAborted()
      if (idempotencyKey !== record.handoffIdempotencyKey) {
        throw new Error(
          "Generation commit key does not match the resource handoff key.",
        )
      }
      const selected = await broker.committedGeneration()
      const existing = selectedRecord<TSnapshot>(selected)
      if (selected?.handoffIdempotencyKey === idempotencyKey) {
        if (!existing || !sameRecord(existing, record)) {
          throw new Error(
            "Generation handoff key was reused for a different selection.",
          )
        }
        return "committed"
      }
      signal.throwIfAborted()
      try {
        await broker.commitGeneration({
          commitId: record.commitId,
          handoffIdempotencyKey: idempotencyKey,
          generationId: record.generationId,
          inventoryDigest: recordDigest(record),
          baseEpoch: record.fence.epoch,
          pluginRevisions: record.fence.settingsRevisions,
          generationRecord: record,
        })
        return "committed"
      } catch (error) {
        if (!isPluginSettingsConflictError(error)) throw error
        const raced = await broker.committedGeneration()
        const racedRecord = selectedRecord<TSnapshot>(raced)
        if (raced?.handoffIdempotencyKey !== idempotencyKey)
          return "not-committed"
        if (!racedRecord || !sameRecord(racedRecord, record)) {
          throw new Error(
            "Generation handoff key was reused for a different selection.",
          )
        }
        return "committed"
      }
    },

    async queryDurableCommit(idempotencyKey, signal) {
      signal.throwIfAborted()
      const selected = await broker.committedGeneration()
      signal.throwIfAborted()
      const state: DurableCommitState =
        selected?.handoffIdempotencyKey === idempotencyKey ?
          "committed"
        : "not-committed"
      return state
    },

    async markInstalled(commitId, signal) {
      signal.throwIfAborted()
      await broker.markGenerationInstalled(commitId)
    },

    async markPublished(commitId, signal) {
      signal.throwIfAborted()
      await broker.markGenerationPublished(commitId)
    },
  }
}
