/** The signal's reason as an `Error` (an AbortError when it carries none). */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  return new DOMException(
    typeof reason === "string" ? reason : "The operation was aborted.",
    "AbortError",
  )
}

/** Race `promise` against `signal`; the promise keeps running but its result is dropped. */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(abortReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {})
      reject(abortReason(signal))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- forwards the wrapped promise's own rejection unchanged
        reject(error)
      },
    )
  })
}

/** Abortable delay. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

export const sleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal as AbortSignal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
