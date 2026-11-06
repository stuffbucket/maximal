import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const SCRIPT = resolve(import.meta.dir, "../scripts/find-casts.ts")
const directories: Array<string> = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function runCheck(source: string): ReturnType<typeof Bun.spawnSync> {
  const directory = mkdtempSync(join(tmpdir(), "maximal-find-casts-"))
  directories.push(directory)
  mkdirSync(join(directory, "src"))
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        noEmit: true,
        strict: true,
        target: "ESNext",
      },
      include: ["src/**/*"],
    }),
  )
  writeFileSync(join(directory, "src/input.ts"), source)

  return Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, "--check"],
    cwd: directory,
    stderr: "pipe",
    stdout: "pipe",
  })
}

const output = (bytes: Uint8Array | undefined): string =>
  new TextDecoder().decode(bytes)

describe("find-casts", () => {
  test("rejects an unexplained any-to-concrete assertion", () => {
    const result = runCheck(
      'const parsed = JSON.parse("{}") as { required: string }\nvoid parsed\n',
    )

    expect(result.exitCode).toBe(1)
    expect(output(result.stderr)).toContain(
      "1 unjustified any→concrete boundary cast",
    )
  })

  test("allows a defensive assertion with only optional unknown fields", () => {
    const result = runCheck(
      'const parsed = JSON.parse("{}") as { optional?: unknown }\nvoid parsed\n',
    )

    expect(result.exitCode).toBe(0)
    expect(output(result.stdout)).toContain("0 unjustified")
  })

  test("allows a nullable defensive assertion", () => {
    const result = runCheck(
      'const parsed = JSON.parse("{}") as { optional?: unknown } | null\nvoid parsed\n',
    )

    expect(result.exitCode).toBe(0)
    expect(output(result.stdout)).toContain("0 unjustified")
  })

  test("allows a defensive unknown-valued record assertion", () => {
    const result = runCheck(
      'const parsed = JSON.parse("{}") as Record<string, unknown>\nvoid parsed\n',
    )

    expect(result.exitCode).toBe(0)
    expect(output(result.stdout)).toContain("0 unjustified")
  })

  test("requires a reason when an any-to-concrete assertion is retained", () => {
    const result = runCheck(
      '// casts-keep: fixture models a trusted runtime contract\nconst parsed = JSON.parse("{}") as { required: string }\nvoid parsed\n',
    )

    expect(result.exitCode).toBe(0)
    expect(output(result.stdout)).toContain(
      "KEPT   src/input.ts:2  — fixture models a trusted runtime contract",
    )
  })

  test("does not gate assertions from unknown", () => {
    const result = runCheck(
      "const value: unknown = {}\nconst parsed = value as { required: string }\nvoid parsed\n",
    )

    expect(result.exitCode).toBe(0)
    expect(output(result.stdout)).toContain("0 unjustified")
  })
})
