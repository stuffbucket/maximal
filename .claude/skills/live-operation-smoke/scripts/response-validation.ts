export type AnswerEvidence = Record<string, string | number>

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function answerEvidence(
  operation: "decisions" | "systemone",
  body: unknown,
): AnswerEvidence | undefined {
  if (!isRecord(body)) return undefined
  if (operation === "decisions") {
    if (!Array.isArray(body.answers)) return undefined
    const answers: ReadonlyArray<unknown> = body.answers
    const answer = answers.find(
      (candidate) =>
        isRecord(candidate)
        && candidate.type === "predicate"
        && candidate.name === "marker_present"
        && typeof candidate.probability === "number"
        && Number.isFinite(candidate.probability),
    )
    if (!isRecord(answer) || typeof answer.probability !== "number") {
      return undefined
    }
    return {
      type: "predicate",
      name: "marker_present",
      probability: answer.probability,
    }
  }

  if (!isRecord(body.answers)) return undefined
  const answer = body.answers.marker_present
  if (
    !isRecord(answer)
    || answer.type !== "noul"
    || typeof answer.noul !== "number"
    || !Number.isFinite(answer.noul)
  ) {
    return undefined
  }
  return { type: "noul", name: "marker_present", noul: answer.noul }
}

export function hasValidAnswers(
  operation: "decisions" | "systemone",
  body: unknown,
): boolean {
  return answerEvidence(operation, body) !== undefined
}

export function decodePng(body: unknown): Buffer {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("Image response has no data array")
  }
  const data: ReadonlyArray<unknown> = body.data
  if (data.length !== 1) {
    throw new Error(`Image response returned ${data.length} items; expected 1`)
  }
  const first = data[0]
  if (!isRecord(first) || typeof first.b64_json !== "string") {
    throw new Error("Image response item has no base64 image")
  }
  const bytes = Buffer.from(first.b64_json, "base64")
  if (
    bytes.length <= PNG_MAGIC.length
    || !bytes.subarray(0, 8).equals(PNG_MAGIC)
  ) {
    throw new Error("Image response is not a non-empty PNG")
  }
  return bytes
}
