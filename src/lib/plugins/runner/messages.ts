import { z } from "zod"

import type { ParentToRunnerMessage, RunnerToParentMessage } from "./contracts"

import { RUNNER_API_VERSION, RUNNER_PROTOCOL_VERSION } from "./contracts"

const id = z.string().min(1).max(512)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const prepared = z
  .object({
    complete: z.literal(true),
    revision: z.number().int().nonnegative(),
    controlEpoch: z.number().int().nonnegative(),
    generationId: digest,
    manifestSha256: digest,
    inventoryDigest: digest,
    health: z
      .array(
        z
          .object({
            pluginId: id,
            classification: z.enum([
              "healthy",
              "needs-setup",
              "signed-out",
              "existing-failure",
              "waiting-dependency",
              "regression",
              "host-failure",
            ]),
            detail: z.string().max(16_384).optional(),
          })
          .strict(),
      )
      .max(10_000),
    snapshot: z.json(),
  })
  .strict()

const runnerMessage = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("runner.hello"),
      nonce: id,
      protocol: z.literal(RUNNER_PROTOCOL_VERSION),
      pluginApi: z.literal(RUNNER_API_VERSION),
      generationId: digest,
      manifestSha256: digest,
      selectionSeal: digest,
    })
    .strict(),
  z
    .object({
      type: z.literal("runner.state"),
      state: z.enum([
        "spawned",
        "negotiated",
        "preparing",
        "prepared",
        "committing",
        "active",
        "draining",
        "stopping",
        "stopped",
      ]),
      prepared: prepared.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("runner.heartbeat"),
      monotonicMs: z.number().nonnegative(),
      inflight: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ type: z.literal("runner.drained") }).strict(),
  z
    .object({
      type: z.literal("runner.result"),
      callId: id,
      value: z.json().optional(),
      error: z
        .object({
          code: id,
          message: z.string().max(262_144),
          indeterminate: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .refine(
      (value) => (value.value === undefined) !== (value.error === undefined),
    ),
])

const parentMessage = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("supervisor.accept"),
      nonce: id,
      protocol: z.literal(RUNNER_PROTOCOL_VERSION),
      pluginApi: z.literal(RUNNER_API_VERSION),
    })
    .strict(),
  z.object({ type: z.literal("supervisor.activate") }).strict(),
  z
    .object({
      type: z.literal("supervisor.drain"),
      deadlineMs: z.number().int().nonnegative(),
      reason: z.string().max(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal("supervisor.shutdown"),
      graceful: z.boolean(),
      reason: z.string().max(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal("supervisor.dispatch"),
      callId: id,
      method: id,
      params: z.json(),
    })
    .strict(),
  z
    .object({
      type: z.literal("supervisor.cancel"),
      callId: id,
      reason: z.string().max(4096),
    })
    .strict(),
])

export function parseRunnerMessage(input: unknown): RunnerToParentMessage {
  return runnerMessage.parse(input)
}

export function parseParentMessage(input: unknown): ParentToRunnerMessage {
  return parentMessage.parse(input)
}
