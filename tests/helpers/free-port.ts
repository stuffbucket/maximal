/**
 * A port the OS just reported free, for tests that spawn a real server.
 *
 * Guessing a port in a fixed range collides with dev and preview servers, and
 * with the same test running in another checkout. A process already listening
 * there answers the readiness probe, and the test then talks to the wrong
 * server.
 */
export async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe
  await probe.stop(true)
  if (port === undefined) throw new Error("The OS did not assign a port.")
  return port
}
