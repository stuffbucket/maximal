/**
 * Preload for the Windows containment test: makes the broker's
 * AssignProcessToJobObject report failure, the way Windows refuses it, while
 * the rest of kernel32 stays real. Test-only; the broker itself has no switch
 * for this.
 *
 *   bun --preload ./refuse-job-preload.ts ../src/main.ts serve ...
 */
import { plugin } from "bun"

const REAL = "export function loadKernel32(): JobObjectApi {"

plugin({
  name: "refuse-job",
  setup(build) {
    build.onLoad({ filter: /windows-job\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text()
      if (!source.includes(REAL)) {
        throw new Error("refuse-job-preload: loadKernel32 not found")
      }
      return {
        loader: "ts",
        contents: source.replace(
          REAL,
          `export function loadKernel32(): JobObjectApi {
  return { ...realKernel32(), assignProcess: () => false }
}
function realKernel32(): JobObjectApi {`,
        ),
      }
    })
  },
})
