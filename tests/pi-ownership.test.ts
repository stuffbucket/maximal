import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { parse } from "jsonc-parser"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applyPiProvider,
  inspectPiProvider,
  PiOwnershipError,
  revertPiProvider,
  type PiTarget,
} from "~/apps/pi/ownership"

const provider = {
  baseUrl: "http://127.0.0.1:4141/v1",
  apiKey: "!private-helper",
  models: [{ id: "test-model", name: "Test Model" }],
}

function contents(target: PiTarget): string {
  return fs.readFileSync(target.filePath, "utf8")
}
function parsed(target: PiTarget): unknown {
  return parse(contents(target))
}

let directory: string
let target: PiTarget
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ownership-"))
  target = {
    filePath: path.join(directory, "pi", "models.json"),
    journalPath: path.join(directory, "maximal", "pi-routing.json"),
    profileId: "a".repeat(64),
  }
})
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})
function write(text: string) {
  fs.mkdirSync(path.dirname(target.filePath), { recursive: true })
  fs.writeFileSync(target.filePath, text)
}

describe("Pi provider ownership", () => {
  test("inspection is read-only and a fresh installation is reversible", () => {
    expect(inspectPiProvider(target)).toEqual({
      enabled: false,
      conflict: null,
    })
    expect(fs.readdirSync(directory)).toEqual([])
    expect(applyPiProvider(target, provider, { claim: true })).toBe(true)
    expect(inspectPiProvider(target)).toEqual({ enabled: true, conflict: null })
    expect(parsed(target)).toMatchObject({ providers: { maximal: provider } })
    expect(fs.statSync(target.filePath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(target.journalPath).mode & 0o777).toBe(0o600)
    expect(applyPiProvider(target, provider)).toBe(false)
    expect(revertPiProvider(target)).toBe(true)
    expect(fs.existsSync(target.filePath)).toBe(false)
    expect(fs.existsSync(target.journalPath)).toBe(false)
  })

  test("an existing provider requires explicit adoption, and restores byte-for-byte after refreshes", () => {
    const original =
      '\ufeff{\r\n\t// user comment\r\n\t"providers": {"other": {"models": []}, "maximal": { /* original */ "baseUrl": "http://old/v1", "apiKey": "!old-helper",},},\r\n}\r\n'
    write(original)
    expect(inspectPiProvider(target).conflict).toBe("existing-provider")
    expect(() => applyPiProvider(target, provider, { claim: true })).toThrow(
      PiOwnershipError,
    )
    expect(contents(target)).toBe(original)
    applyPiProvider(target, provider, { claim: true, adoptExisting: true })
    applyPiProvider(target, { ...provider, models: [{ id: "new-model" }] })
    expect(parsed(target)).toMatchObject({
      providers: {
        maximal: { models: [{ id: "new-model" }] },
        other: { models: [] },
      },
    })
    expect(contents(target)).toContain("// user comment")
    revertPiProvider(target)
    expect(contents(target)).toBe(original)
  })

  test("unrelated external changes and comments survive disable", () => {
    write(
      '{\n  // untouched\n  "providers": {"other": {"apiKey": "keep"}},\n  "custom": "before"\n}\n',
    )
    applyPiProvider(target, provider, { claim: true })
    write(contents(target).replace('"before"', '"after"'))
    expect(inspectPiProvider(target).enabled).toBe(true)
    // A later catalog refresh must not make disable restore an older, pre-edit snapshot.
    applyPiProvider(target, { ...provider, models: [{ id: "updated-model" }] })
    revertPiProvider(target)
    expect(contents(target)).toContain("// untouched")
    expect(parsed(target)).toEqual({
      providers: { other: { apiKey: "keep" } },
      custom: "after",
    })
  })

  test("comments inside an adopted provider survive unrelated external edits", () => {
    write(
      '{"custom":1, "providers":{"maximal":{ /* keep inside */ "apiKey":"old"}}}',
    )
    applyPiProvider(target, provider, { claim: true, adoptExisting: true })
    write(contents(target).replace('"custom":1', '"custom":2'))
    revertPiProvider(target)
    expect(contents(target)).toContain("/* keep inside */")
    expect(parsed(target)).toMatchObject({
      custom: 2,
      providers: { maximal: { apiKey: "old" } },
    })
  })

  test("external edits to managed data win, even with adoption or override requested", () => {
    applyPiProvider(target, provider, { claim: true })
    write(contents(target).replace("test-model", "user-choice"))
    const edited = contents(target)
    expect(inspectPiProvider(target)).toEqual({
      enabled: false,
      conflict: "cleanup-required",
    })
    expect(() =>
      applyPiProvider(target, provider, {
        claim: true,
        adoptExisting: true,
        overrideOtherMaximal: true,
      }),
    ).toThrow(PiOwnershipError)
    expect(() => revertPiProvider(target)).toThrow(PiOwnershipError)
    expect(contents(target)).toBe(edited)
  })

  test("catalog reconciliation never recreates a deleted provider or missing file", () => {
    applyPiProvider(target, provider, { claim: true })
    fs.unlinkSync(target.filePath)
    expect(() => applyPiProvider(target, provider)).toThrow(PiOwnershipError)
    expect(fs.existsSync(target.filePath)).toBe(false)
    expect(revertPiProvider(target)).toBe(false)
    expect(fs.existsSync(target.journalPath)).toBe(false)
    expect(() => applyPiProvider(target, provider)).toThrow(PiOwnershipError)
    applyPiProvider(target, provider, { claim: true })
    expect(inspectPiProvider(target).enabled).toBe(true)
  })

  test("ownership transfer requires confirmation and carries the original user's provider", () => {
    write('{"providers":{"maximal":{"apiKey":"original"}}}')
    applyPiProvider(target, provider, { claim: true, adoptExisting: true })
    const other = {
      ...target,
      profileId: "b".repeat(64),
      journalPath: path.join(directory, "other-journal.json"),
    }
    expect(inspectPiProvider(other).conflict).toBe("other-maximal-config")
    expect(() =>
      applyPiProvider(other, provider, { claim: true, adoptExisting: true }),
    ).toThrow(PiOwnershipError)
    applyPiProvider(other, provider, {
      claim: true,
      overrideOtherMaximal: true,
    })
    expect(inspectPiProvider(other).enabled).toBe(true)
    expect(() => applyPiProvider(target, provider)).toThrow(PiOwnershipError)
    expect(() => revertPiProvider(target)).toThrow(PiOwnershipError)
    revertPiProvider(other)
    expect(parsed(target)).toEqual({
      providers: { maximal: { apiKey: "original" } },
    })
    expect(() => applyPiProvider(target, provider)).toThrow(PiOwnershipError)
  })

  test("malformed JSON, duplicate keys, invalid shapes, and damaged markers are never overwritten", () => {
    for (const original of [
      "{broken",
      '{"providers":{},"providers":{}}',
      '{"providers":[]}',
      '{"providers":{"maximal":null}}',
      '{"providers":{"maximal":{"_maximal":{}}}}',
    ]) {
      write(original)
      expect(inspectPiProvider(target).conflict).toBe("cleanup-required")
      expect(() =>
        applyPiProvider(target, provider, { claim: true, adoptExisting: true }),
      ).toThrow(PiOwnershipError)
      expect(contents(target)).toBe(original)
    }
  })

  test("a missing journal still allows safe marker-based cleanup", () => {
    write('{"custom": true, "providers":{"maximal":{"apiKey":"original"}}}')
    applyPiProvider(target, provider, { claim: true, adoptExisting: true })
    fs.unlinkSync(target.journalPath)
    revertPiProvider(target)
    expect(parsed(target)).toEqual({
      custom: true,
      providers: { maximal: { apiKey: "original" } },
    })
  })

  test("an edited but syntactically valid journal cannot replace the original configuration", () => {
    applyPiProvider(target, provider, { claim: true })
    const original = contents(target)
    const journal = fs
      .readFileSync(target.journalPath, "utf8")
      .replace('"before": null', '"before": "{}"')
    fs.writeFileSync(target.journalPath, journal)
    expect(inspectPiProvider(target).conflict).toBe("cleanup-required")
    expect(() => revertPiProvider(target)).toThrow(PiOwnershipError)
    expect(contents(target)).toBe(original)
  })

  test("cleanup cannot delete the journal belonging to a different target", () => {
    applyPiProvider(target, provider, { claim: true })
    expect(() =>
      revertPiProvider({
        ...target,
        filePath: path.join(directory, "different.json"),
      }),
    ).toThrow(PiOwnershipError)
    expect(fs.existsSync(target.journalPath)).toBe(true)
    expect(inspectPiProvider(target).enabled).toBe(true)
  })

  test("explicit disable forgets the journal but preserves a provider the user has replaced", () => {
    applyPiProvider(target, provider, { claim: true })
    const manual = '{"providers":{"maximal":{"apiKey":"user-owned"}}}'
    write(manual)
    expect(revertPiProvider(target)).toBe(false)
    expect(contents(target)).toBe(manual)
    expect(fs.existsSync(target.journalPath)).toBe(false)
  })

  test("a damaged journal prevents changes and a symlink is never replaced", () => {
    applyPiProvider(target, provider, { claim: true })
    fs.writeFileSync(target.journalPath, "invalid")
    const original = contents(target)
    expect(inspectPiProvider(target).conflict).toBe("cleanup-required")
    expect(() => applyPiProvider(target, provider)).toThrow(PiOwnershipError)
    expect(contents(target)).toBe(original)
    fs.unlinkSync(target.filePath)
    const external = path.join(directory, "external.json")
    fs.writeFileSync(external, "{}")
    fs.symlinkSync(external, target.filePath)
    expect(inspectPiProvider(target).conflict).toBe("cleanup-required")
    expect(() => applyPiProvider(target, provider, { claim: true })).toThrow(
      PiOwnershipError,
    )
    expect(fs.readFileSync(external, "utf8")).toBe("{}")
  })
})
