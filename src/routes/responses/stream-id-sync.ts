/**
 * Stream ID Synchronization for @ai-sdk/openai compatibility
 *
 * GitHub Copilot's Responses API can return different IDs for the same item in
 * `added` and `done` events. OpenAI-compatible clients expect one stable ID.
 * Malformed frames pass through unchanged because this runs in the native
 * Responses stream and must not terminate it.
 */

interface StreamIdTracker {
  outputItems: Map<number, string>
}

interface OutputItemFrame {
  item: { id?: string }
  output_index?: unknown
}

const asOutputItemFrame = (value: unknown): OutputItemFrame | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const item = (value as { item?: unknown }).item
  if (typeof item !== "object" || item === null) return undefined
  return value as OutputItemFrame
}

const readOutputIndex = (frame: {
  output_index?: unknown
}): number | undefined =>
  typeof frame.output_index === "number" ? frame.output_index : undefined

export const createStreamIdTracker = (): StreamIdTracker => ({
  outputItems: new Map(),
})

export const fixStreamIds = (
  data: string,
  event: string | undefined,
  tracker: StreamIdTracker,
): string => {
  if (!data) return data

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return data
  }

  switch (event) {
    case "response.output_item.added": {
      const frame = asOutputItemFrame(parsed)
      return frame ? handleOutputItemAdded(frame, tracker) : data
    }
    case "response.output_item.done": {
      const frame = asOutputItemFrame(parsed)
      return frame ? handleOutputItemDone(frame, tracker) : data
    }
    default: {
      if (typeof parsed !== "object" || parsed === null) return data
      return handleItemId(parsed as Record<string, unknown>, tracker)
    }
  }
}

const handleOutputItemAdded = (
  parsed: OutputItemFrame,
  tracker: StreamIdTracker,
): string => {
  if (!parsed.item.id) {
    let randomSuffix = ""
    while (randomSuffix.length < 16) {
      randomSuffix += Math.random().toString(36).slice(2)
    }
    parsed.item.id = `oi_${String(parsed.output_index)}_${randomSuffix.slice(0, 16)}`
  }

  const outputIndex = readOutputIndex(parsed)
  if (outputIndex !== undefined) {
    tracker.outputItems.set(outputIndex, parsed.item.id)
  }
  return JSON.stringify(parsed)
}

const handleOutputItemDone = (
  parsed: OutputItemFrame,
  tracker: StreamIdTracker,
): string => {
  const outputIndex = readOutputIndex(parsed)
  const originalId =
    outputIndex === undefined ? undefined : tracker.outputItems.get(outputIndex)
  if (originalId) {
    parsed.item.id = originalId
  }
  return JSON.stringify(parsed)
}

const handleItemId = (
  parsed: Record<string, unknown>,
  tracker: StreamIdTracker,
): string => {
  const outputIndex = readOutputIndex(parsed)
  if (outputIndex !== undefined) {
    const itemId = tracker.outputItems.get(outputIndex)
    if (itemId) {
      parsed.item_id = itemId
    }
  }
  return JSON.stringify(parsed)
}
