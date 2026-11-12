/**
 * The error a promise rejects with. Bun types `expect(p).rejects.*` as
 * returning `void`, so awaiting it is a lint error; assert on the awaited
 * rejection instead.
 */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject.")
}
