/**
 * Claude Desktop config-library profiles: list / current / select
 * (src/apps/claude-desktop/profile-library.ts, profile-cli.ts).
 *
 * Every fixture is a temp directory with fabricated ids, names and "keys";
 * nothing here reads or writes a real Claude or Maximal configuration.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { parseArgs } from "citty"
import consola from "consola"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

import { claudeDesktopCli } from "~/apps/claude-desktop/cli"
import {
  PROFILE_ARGS,
  profileCliRequested,
  runProfileCli,
} from "~/apps/claude-desktop/profile-cli"
import {
  applyProfileSelection,
  planProfileSelection,
  ProfileLibraryError,
  type ProfileLibraryErrorCode,
  readProfileLibrary,
} from "~/apps/claude-desktop/profile-library"
import { parseJsonText } from "~/lib/platform/json-text"

const ID_A = "11111111-1111-4111-8111-111111111111"
const ID_B = "22222222-2222-4222-8222-222222222222"
const ID_C = "33333333-3333-4333-8333-333333333333"
/** U+FEFF, written by Notepad and Windows PowerShell 5. */
const BOM = String.fromCodePoint(0xfeff)
const FAKE_KEY = "FAKE-SECRET-SENTINEL-do-not-leak"

let dir: string
let lib: string

function metaPath(): string {
  return path.join(lib, "_meta.json")
}

function writeProfile(id: string, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(lib, `${id}.json`),
    JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayApiKey: FAKE_KEY,
      ...extra,
    }),
  )
}

/** `_meta.json` as parsed JSON, key order kept. */
function metaJson(): Record<string, unknown> {
  return z
    .record(z.string(), z.unknown())
    .parse(parseJsonText(fs.readFileSync(metaPath(), "utf8")))
}

function writeMeta(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  fs.writeFileSync(metaPath(), text)
  return text
}

function standardMeta(appliedId = ID_A): Record<string, unknown> {
  return {
    appliedId,
    entries: [
      { id: ID_A, name: "alpha" },
      { id: ID_B, name: "beta" },
    ],
  }
}

function seed(appliedId = ID_A): void {
  writeProfile(ID_A)
  writeProfile(ID_B)
  writeMeta(standardMeta(appliedId))
}

function digestOf(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function snapshotProfiles(): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(lib)
      .filter((name) => name !== "_meta.json")
      .sort()
      .map((name) => [name, digestOf(path.join(lib, name))]),
  )
}

function refusal(fn: () => unknown): ProfileLibraryError {
  try {
    fn()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ProfileLibraryError)
    return error as ProfileLibraryError
  }
  throw new Error("expected a ProfileLibraryError")
}

function expectRefusal(
  fn: () => unknown,
  code: ProfileLibraryErrorCode,
): ProfileLibraryError {
  const error = refusal(fn)
  expect(error.code).toBe(code)
  // Messages never carry file content.
  expect(error.message).not.toContain(FAKE_KEY)
  return error
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-profile-lib-"))
  lib = path.join(dir, "configLibrary")
  fs.mkdirSync(lib)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("readProfileLibrary (list / current)", () => {
  test("lists entries in index order and marks the applied one", () => {
    seed(ID_B)
    const view = readProfileLibrary(dir)
    expect(view.indexPresent).toBe(true)
    expect(view.appliedId).toBe(ID_B)
    expect(view.appliedKnown).toBe(true)
    expect(view.hybridPointer).toBe(false)
    expect(view.profiles).toEqual([
      { id: ID_A, name: "alpha", applied: false, validId: true, file: "ok" },
      { id: ID_B, name: "beta", applied: true, validId: true, file: "ok" },
    ])
  })

  test("a library that doesn't exist yet is an empty one", () => {
    fs.rmSync(lib, { recursive: true })
    const view = readProfileLibrary(dir)
    expect(view.indexPresent).toBe(false)
    expect(view.profiles).toEqual([])
  })

  test("a directory without an index is an empty library", () => {
    expect(readProfileLibrary(dir).indexPresent).toBe(false)
  })

  test("no applied id is reported, not an error", () => {
    seed("")
    const view = readProfileLibrary(dir)
    expect(view.appliedKnown).toBe(false)
    expect(view.profiles.every((profile) => !profile.applied)).toBe(true)
  })

  test("an applied id missing from the index is dangling", () => {
    seed(ID_C)
    const view = readProfileLibrary(dir)
    expect(view.appliedId).toBe(ID_C)
    expect(view.appliedKnown).toBe(false)
  })

  test("reports each profile file's state without reading its content", () => {
    writeProfile(ID_A)
    fs.writeFileSync(
      path.join(lib, `${ID_B}.json`),
      `{"truncated": "${FAKE_KEY}`,
    )
    writeMeta({
      appliedId: ID_A,
      entries: [
        { id: ID_A, name: "ok" },
        { id: ID_B, name: "bad" },
        { id: ID_C, name: "gone" },
      ],
    })
    expect(readProfileLibrary(dir).profiles.map((p) => p.file)).toEqual([
      "ok",
      "unreadable",
      "missing",
    ])
  })

  test("a symlinked profile file is reported as a symlink", () => {
    const target = path.join(dir, "outside.json")
    fs.writeFileSync(target, "{}")
    fs.symlinkSync(target, path.join(lib, `${ID_A}.json`))
    writeMeta({ appliedId: "", entries: [{ id: ID_A, name: "linked" }] })
    expect(readProfileLibrary(dir).profiles[0]?.file).toBe("symlink")
  })

  test("an entry with an unsafe id is listed but never addressed", () => {
    // A file the traversal id would reach if it were used as a path.
    fs.writeFileSync(path.join(dir, "outside.json"), "{}")
    writeMeta({
      appliedId: "",
      entries: [{ id: "../outside", name: "traversal" }],
    })
    const [profile] = readProfileLibrary(dir).profiles
    expect(profile.validId).toBe(false)
    expect(profile.file).toBe("unreadable")
  })

  test("a leading byte order mark is ignored", () => {
    seed()
    fs.writeFileSync(metaPath(), `${BOM}${JSON.stringify(standardMeta(ID_B))}`)
    expect(readProfileLibrary(dir).appliedId).toBe(ID_B)
  })

  test("reports hybridPointer", () => {
    seed()
    writeMeta({ ...standardMeta(), hybridPointer: { bootstrapUrl: "x" } })
    expect(readProfileLibrary(dir).hybridPointer).toBe(true)
  })

  test("never modifies anything", () => {
    seed()
    const before = digestOf(metaPath())
    const profiles = snapshotProfiles()
    readProfileLibrary(dir)
    expect(digestOf(metaPath())).toBe(before)
    expect(snapshotProfiles()).toEqual(profiles)
  })
})

describe("malformed, unreadable and linked state is refused", () => {
  const malformed: Array<[string, string]> = [
    ["invalid JSON", `{"appliedId": "${FAKE_KEY}`],
    ["a JSON array", "[]"],
    ["a JSON string", JSON.stringify(FAKE_KEY)],
    ["null", "null"],
    ["a missing appliedId", JSON.stringify({ entries: [] })],
    ["a non-string appliedId", JSON.stringify({ appliedId: 7, entries: [] })],
    ["missing entries", JSON.stringify({ appliedId: "" })],
    [
      "entries that aren't an array",
      JSON.stringify({ appliedId: "", entries: { [ID_A]: FAKE_KEY } }),
    ],
    [
      "an entry without a name",
      JSON.stringify({ appliedId: "", entries: [{ id: ID_A }] }),
    ],
    [
      "an entry with a non-string id",
      JSON.stringify({ appliedId: "", entries: [{ id: 1, name: "n" }] }),
    ],
    [
      "a duplicate id",
      JSON.stringify({
        appliedId: "",
        entries: [
          { id: ID_A, name: "a" },
          { id: ID_A, name: "b" },
        ],
      }),
    ],
  ]

  for (const [label, text] of malformed) {
    test(`${label}: list and select refuse, bytes untouched`, () => {
      writeProfile(ID_A)
      writeMeta(text)
      const before = fs.readFileSync(metaPath(), "utf8")
      expectRefusal(() => readProfileLibrary(dir), "malformed")
      expectRefusal(() => planProfileSelection(dir, ID_A), "malformed")
      expect(fs.readFileSync(metaPath(), "utf8")).toBe(before)
    })
  }

  test("a symlinked _meta.json is refused", () => {
    seed()
    const real = path.join(dir, "real-meta.json")
    fs.renameSync(metaPath(), real)
    fs.symlinkSync(real, metaPath())
    expectRefusal(() => readProfileLibrary(dir), "symlink")
    expectRefusal(() => planProfileSelection(dir, ID_B), "symlink")
    expect(fs.lstatSync(metaPath()).isSymbolicLink()).toBe(true)
  })

  test("a symlinked configLibrary directory is refused", () => {
    seed()
    const real = path.join(dir, "real-lib")
    fs.renameSync(lib, real)
    fs.symlinkSync(real, lib)
    expectRefusal(() => readProfileLibrary(dir), "symlink")
    expectRefusal(() => planProfileSelection(dir, ID_B), "symlink")
  })

  test("an unreadable _meta.json (a directory) is refused, not mistaken for empty", () => {
    fs.mkdirSync(metaPath())
    expectRefusal(() => readProfileLibrary(dir), "unreadable")
  })

  test("a configLibrary that is a file is refused", () => {
    fs.rmSync(lib, { recursive: true })
    fs.writeFileSync(lib, "")
    expectRefusal(() => readProfileLibrary(dir), "malformed")
  })
})

describe("planProfileSelection / applyProfileSelection", () => {
  test("selects by changing only appliedId", () => {
    seed(ID_A)
    const plan = planProfileSelection(dir, ID_B)
    expect(plan).toMatchObject({
      id: ID_B,
      name: "beta",
      unchanged: false,
      previousAppliedId: ID_A,
    })
    // Planning wrote nothing.
    expect(metaJson()).toEqual(standardMeta(ID_A))
    expect(applyProfileSelection(plan)).toBe(true)
    expect(metaJson()).toEqual(standardMeta(ID_B))
    expect(readProfileLibrary(dir).appliedId).toBe(ID_B)
  })

  test("preserves unknown top-level and entry fields, nested values and key order", () => {
    writeProfile(ID_A)
    writeProfile(ID_B)
    writeMeta({
      futureTopLevel: { nested: [1, { deep: true }], note: "kept" },
      appliedId: ID_A,
      entries: [
        { id: ID_A, name: "alpha", provider: "gateway", note: "n", extra: [1] },
        { id: ID_B, name: "beta", surprise: { a: null } },
      ],
      trailing: 42,
    })
    const before = metaJson()
    applyProfileSelection(planProfileSelection(dir, ID_B))
    const after = metaJson()
    expect(Object.keys(after)).toEqual(Object.keys(before))
    expect(after).toEqual({ ...before, appliedId: ID_B })
  })

  test("leaves every profile file byte-identical and creates none", () => {
    seed(ID_A)
    const files = fs.readdirSync(lib).sort()
    const profiles = snapshotProfiles()
    applyProfileSelection(planProfileSelection(dir, ID_B))
    expect(snapshotProfiles()).toEqual(profiles)
    // Only _meta.json is rewritten: no temp file left, no new profile.
    expect(fs.readdirSync(lib).sort()).toEqual(files)
  })

  test("the rewritten index is private (0600)", () => {
    if (process.platform === "win32") return
    seed(ID_A)
    applyProfileSelection(planProfileSelection(dir, ID_B))
    expect(fs.statSync(metaPath()).mode & 0o777).toBe(0o600)
  })

  test("selecting an unlisted id is refused", () => {
    seed()
    const before = digestOf(metaPath())
    expectRefusal(() => planProfileSelection(dir, ID_C), "unknown-profile")
    expect(digestOf(metaPath())).toBe(before)
  })

  test("a profile file on disk that the index doesn't list is not selectable", () => {
    seed()
    writeProfile(ID_C)
    expectRefusal(() => planProfileSelection(dir, ID_C), "unknown-profile")
  })

  const unsafe: Array<[string, string]> = [
    ["empty", ""],
    ["traversal", "../../etc/passwd"],
    ["a separator", `${ID_A.slice(0, 10)}/${ID_A.slice(11)}`],
    ["a backslash", `${ID_A.slice(0, 10)}\\${ID_A.slice(11)}`],
    ["uppercase", "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF"],
    ["too short", ID_A.slice(0, 35)],
    ["too long", `${ID_A}0`],
    ["a NUL", `${ID_A.slice(0, 35)}\0`],
    ["a newline", `${ID_A.slice(0, 35)}\n`],
    ["a dot", `.${ID_A.slice(1)}`],
  ]
  for (const [label, id] of unsafe) {
    test(`rejects an unsafe id (${label}) before touching the filesystem`, () => {
      // No library at all: an unsafe id must fail on the id, not the lookup.
      fs.rmSync(lib, { recursive: true })
      expectRefusal(() => planProfileSelection(dir, id), "unsafe-id")
    })
  }

  test("an index entry with an unsafe id can't be selected", () => {
    fs.writeFileSync(path.join(dir, "outside.json"), "{}")
    writeMeta({ appliedId: "", entries: [{ id: "../outside", name: "x" }] })
    expectRefusal(() => planProfileSelection(dir, "../outside"), "unsafe-id")
  })

  test("selecting with no index is refused", () => {
    expectRefusal(() => planProfileSelection(dir, ID_A), "no-index")
    expect(fs.existsSync(metaPath())).toBe(false)
  })

  test("refuses a missing, unreadable or symlinked profile file", () => {
    writeMeta({
      appliedId: ID_A,
      entries: [
        { id: ID_A, name: "alpha" },
        { id: ID_B, name: "missing" },
        { id: ID_C, name: "bad" },
      ],
    })
    writeProfile(ID_A)
    fs.writeFileSync(path.join(lib, `${ID_C}.json`), "[]")
    expectRefusal(() => planProfileSelection(dir, ID_B), "profile-unusable")
    expectRefusal(() => planProfileSelection(dir, ID_C), "profile-unusable")

    fs.rmSync(path.join(lib, `${ID_C}.json`))
    const target = path.join(dir, "outside.json")
    fs.writeFileSync(target, "{}")
    fs.symlinkSync(target, path.join(lib, `${ID_C}.json`))
    expectRefusal(() => planProfileSelection(dir, ID_C), "profile-unusable")
    expect(readProfileLibrary(dir).appliedId).toBe(ID_A)
  })

  test("refuses while hybridPointer is set, and leaves it intact", () => {
    for (const pointer of [{ bootstrapUrl: "https://x.example" }, null, ""]) {
      writeProfile(ID_A)
      writeProfile(ID_B)
      const text = writeMeta({ ...standardMeta(), hybridPointer: pointer })
      expectRefusal(() => planProfileSelection(dir, ID_B), "hybrid-pointer")
      expect(fs.readFileSync(metaPath(), "utf8")).toBe(text)
    }
  })

  test("is idempotent: re-selecting writes nothing, whatever the formatting", () => {
    writeProfile(ID_A)
    writeProfile(ID_B)
    // Desktop's own formatting: indented, no trailing newline.
    const text = JSON.stringify(standardMeta(ID_A), null, 2)
    writeMeta(text)
    const before = fs.statSync(metaPath())
    const plan = planProfileSelection(dir, ID_A)
    expect(plan.unchanged).toBe(true)
    expect(applyProfileSelection(plan)).toBe(false)
    const after = fs.statSync(metaPath())
    expect(fs.readFileSync(metaPath(), "utf8")).toBe(text)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.ino).toBe(before.ino)
  })

  test("selecting twice: the second is a no-op", () => {
    seed(ID_A)
    expect(applyProfileSelection(planProfileSelection(dir, ID_B))).toBe(true)
    const bytes = fs.readFileSync(metaPath(), "utf8")
    const plan = planProfileSelection(dir, ID_B)
    expect(plan.unchanged).toBe(true)
    expect(applyProfileSelection(plan)).toBe(false)
    expect(fs.readFileSync(metaPath(), "utf8")).toBe(bytes)
  })

  test("selecting from an empty applied id works", () => {
    seed("")
    applyProfileSelection(planProfileSelection(dir, ID_A))
    expect(readProfileLibrary(dir).appliedId).toBe(ID_A)
  })

  test("a concurrent edit between plan and write is refused and survives", () => {
    seed(ID_A)
    const plan = planProfileSelection(dir, ID_B)
    // Desktop (or the user) adds a profile after we looked.
    writeProfile(ID_C)
    const concurrent = writeMeta({
      ...standardMeta(ID_A),
      entries: [
        ...(standardMeta().entries as Array<unknown>),
        { id: ID_C, name: "gamma" },
      ],
    })
    expectRefusal(() => applyProfileSelection(plan), "conflict")
    expect(fs.readFileSync(metaPath(), "utf8")).toBe(concurrent)
    expect(fs.readdirSync(lib).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    )
  })

  test("a concurrent reformat with equal meaning is still refused", () => {
    seed(ID_A)
    const plan = planProfileSelection(dir, ID_B)
    fs.writeFileSync(metaPath(), JSON.stringify(standardMeta(ID_A), null, 4))
    expectRefusal(() => applyProfileSelection(plan), "conflict")
  })

  test("a concurrent delete of the index is refused", () => {
    seed(ID_A)
    const plan = planProfileSelection(dir, ID_B)
    fs.rmSync(metaPath())
    expectRefusal(() => applyProfileSelection(plan), "conflict")
    expect(fs.existsSync(metaPath())).toBe(false)
  })

  test("a concurrent swap to a symlink is refused and not followed", () => {
    seed(ID_A)
    const plan = planProfileSelection(dir, ID_B)
    const target = path.join(dir, "elsewhere.json")
    fs.writeFileSync(target, "{}")
    fs.rmSync(metaPath())
    fs.symlinkSync(target, metaPath())
    expect(() => applyProfileSelection(plan)).toThrow()
    expect(fs.readFileSync(target, "utf8")).toBe("{}")
  })

  test("the target profile vanishing after planning is refused", () => {
    seed(ID_A)
    const plan = planProfileSelection(dir, ID_B)
    fs.rmSync(path.join(lib, `${ID_B}.json`))
    const before = digestOf(metaPath())
    expectRefusal(() => applyProfileSelection(plan), "profile-unusable")
    expect(digestOf(metaPath())).toBe(before)
  })
})

/** A `consola` log function that prints nothing. */
const silent = Object.assign(() => {}, { raw: () => {} })

function quietLog(method: "info" | "warn" | "error" | "success") {
  return spyOn(consola, method).mockImplementation(silent)
}

type LogSpy = ReturnType<typeof quietLog>

describe("maximal app claude-desktop profile flags", () => {
  let info: LogSpy
  let warn: LogSpy
  let error: LogSpy
  let success: LogSpy

  beforeEach(() => {
    info = quietLog("info")
    warn = quietLog("warn")
    error = quietLog("error")
    success = quietLog("success")
  })

  afterEach(() => {
    info.mockRestore()
    warn.mockRestore()
    error.mockRestore()
    success.mockRestore()
  })

  function said(spy: LogSpy): string {
    return spy.mock.calls.map((call) => String(call[0])).join("\n")
  }

  test("parses the documented syntax", () => {
    const parsed = parseArgs(["--select-profile", ID_B], PROFILE_ARGS)
    expect(parsed["select-profile"]).toBe(ID_B)
    expect(profileCliRequested(parsed)).toBe(true)
    expect(profileCliRequested(parseArgs(["--profiles"], PROFILE_ARGS))).toBe(
      true,
    )
    expect(
      profileCliRequested(parseArgs(["--current-profile"], PROFILE_ARGS)),
    ).toBe(true)
    expect(profileCliRequested(parseArgs([], PROFILE_ARGS))).toBe(false)
  })

  test("the claude-desktop command carries the three flags beside the old ones", () => {
    const extra = claudeDesktopCli.extraArgs ?? {}
    for (const flag of [
      "force",
      "managed",
      "profiles",
      "current-profile",
      "select-profile",
    ]) {
      expect(extra[flag]).toBeDefined()
    }
  })

  test("without a profile flag the hook still falls through", () => {
    expect(claudeDesktopCli.handle?.("status", { profiles: false })).toBe(false)
    expect(claudeDesktopCli.handle?.("disable", {})).toBe(false)
  })

  test("--profiles lists ids and names and marks the applied one", () => {
    seed(ID_B)
    expect(runProfileCli({ profiles: true }, dir)).toBe(0)
    const out = said(info)
    expect(out).toContain(`  ${ID_A}\talpha`)
    expect(out).toContain(`* ${ID_B}\tbeta\t(applied)`)
    // Content is never shown.
    expect(out).not.toContain(FAKE_KEY)
  })

  test("--profiles flags a broken entry", () => {
    writeMeta({ appliedId: "", entries: [{ id: ID_A, name: "x" }] })
    runProfileCli({ profiles: true }, dir)
    expect(said(info)).toContain("file missing")
    expect(said(warn)).toContain("No profile is applied")
  })

  test("--profiles on an absent library says so and succeeds", () => {
    fs.rmSync(lib, { recursive: true })
    expect(runProfileCli({ profiles: true }, dir)).toBe(0)
    expect(said(info)).toContain("no saved profiles")
  })

  test("--current-profile reports the next-launch profile, not a running one", () => {
    seed(ID_B)
    expect(runProfileCli({ "current-profile": true }, dir)).toBe(0)
    const out = said(info)
    expect(out).toContain(ID_B)
    expect(out).toContain("next launch")
    expect(out).toContain("running Claude")
  })

  test("--current-profile warns about hybridPointer", () => {
    seed(ID_A)
    writeMeta({ ...standardMeta(ID_A), hybridPointer: { bootstrapUrl: "x" } })
    expect(runProfileCli({ "current-profile": true }, dir)).toBe(0)
    expect(said(warn)).toContain("hybridPointer")
  })

  test("--select-profile changes the index and says a relaunch is required", () => {
    seed(ID_A)
    expect(runProfileCli({ "select-profile": ID_B }, dir)).toBe(0)
    expect(readProfileLibrary(dir).appliedId).toBe(ID_B)
    expect(said(success)).toContain(`Selected profile ${ID_B} (beta)`)
    const out = said(info)
    expect(out).toContain("quit and relaunch")
    expect(out).toContain("appliedId")
    expect(out).toContain("MDM")
  })

  test("--select-profile warns when Maximal's routing is on, and only then", () => {
    seed(ID_A)
    expect(runProfileCli({ "select-profile": ID_B }, dir)).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    expect(runProfileCli({ "select-profile": ID_A }, dir, true)).toBe(0)
    expect(said(warn)).toContain("routing is on")
    expect(said(warn)).toContain("--disable")
  })

  test("--select-profile of the applied profile is a stated no-op", () => {
    seed(ID_A)
    const before = fs.readFileSync(metaPath(), "utf8")
    expect(runProfileCli({ "select-profile": ID_A }, dir)).toBe(0)
    expect(said(success)).toContain("already selected; nothing written")
    expect(said(info)).toContain("relaunch")
    expect(fs.readFileSync(metaPath(), "utf8")).toBe(before)
  })

  test("a refusal prints why and exits 1", () => {
    seed(ID_A)
    expect(runProfileCli({ "select-profile": ID_C }, dir)).toBe(1)
    expect(said(error)).toContain("No profile with that id")
    expect(runProfileCli({ "select-profile": "../x" }, dir)).toBe(1)
    expect(said(error)).toContain("valid Claude Desktop profile id")
    expect(readProfileLibrary(dir).appliedId).toBe(ID_A)
  })

  test("a bare --select-profile (no id) is refused", () => {
    seed(ID_A)
    expect(runProfileCli({ "select-profile": true }, dir)).toBe(1)
    expect(runProfileCli({ "select-profile": "" }, dir)).toBe(1)
    expect(said(error)).toContain("needs a profile id")
  })

  test("malformed state exits 1 on every profile flag", () => {
    writeMeta("not json")
    expect(runProfileCli({ profiles: true }, dir)).toBe(1)
    expect(runProfileCli({ "current-profile": true }, dir)).toBe(1)
    expect(runProfileCli({ "select-profile": ID_A }, dir)).toBe(1)
    expect(fs.readFileSync(metaPath(), "utf8")).toBe("not json")
  })

  test("more than one profile flag, or one beside enable/disable, is refused", () => {
    seed(ID_A)
    expect(
      runProfileCli({ profiles: true, "current-profile": true }, dir),
    ).toBe(1)
    expect(runProfileCli({ profiles: true, enable: true }, dir)).toBe(1)
    expect(runProfileCli({ "select-profile": ID_B, disable: true }, dir)).toBe(
      1,
    )
    expect(runProfileCli({ profiles: true, managed: true }, dir)).toBe(1)
    expect(runProfileCli({ profiles: true, force: true }, dir)).toBe(1)
    expect(readProfileLibrary(dir).appliedId).toBe(ID_A)
  })
})
