import { describe, expect, test } from "bun:test"

import { detectGhCli, type GhRunner } from "~/services/gh-cli"

// Build a runner that returns canned results keyed by the gh subcommand, so
// the parser is exercised without a real `gh` binary.
type Canned = {
  stdout?: string
  stderr?: string
  code?: number
  notFound?: boolean
}
function runner(map: { version?: Canned; status?: Canned }): GhRunner {
  return (args) => {
    const isVersion = args[0] === "--version"
    const c = (isVersion ? map.version : map.status) ?? {}
    return Promise.resolve({
      stdout: c.stdout ?? "",
      stderr: c.stderr ?? "",
      code: c.code ?? 0,
      notFound: c.notFound ?? false,
    })
  }
}

const VERSION_OUT =
  "gh version 2.92.0 (2026-04-28)\nhttps://github.com/cli/cli\n"

const STATUS_JSON = JSON.stringify({
  hosts: {
    "github.com": [
      {
        state: "success",
        active: true,
        host: "github.com",
        login: "alice",
        scopes: "gist, read:org, repo, workflow",
      },
      {
        state: "success",
        active: false,
        host: "github.com",
        login: "bob",
        scopes: "repo",
      },
    ],
  },
})

describe("detectGhCli", () => {
  test("not installed → installed:false, no accounts", async () => {
    const status = await detectGhCli(runner({ version: { notFound: true } }))
    expect(status).toEqual({ installed: false, version: null, accounts: [] })
  })

  test("installed + multiple accounts → parsed version, accounts, active flag, scopes", async () => {
    const status = await detectGhCli(
      runner({
        version: { stdout: VERSION_OUT },
        status: { stdout: STATUS_JSON },
      }),
    )
    expect(status.installed).toBe(true)
    expect(status.version).toBe("2.92.0")
    expect(status.accounts).toEqual([
      {
        login: "alice",
        host: "github.com",
        active: true,
        scopes: ["gist", "read:org", "repo", "workflow"],
      },
      { login: "bob", host: "github.com", active: false, scopes: ["repo"] },
    ])
  })

  test("installed but not signed in (auth status non-zero) → installed:true, accounts:[]", async () => {
    const status = await detectGhCli(
      runner({
        version: { stdout: VERSION_OUT },
        status: { code: 1, stderr: "not logged in" },
      }),
    )
    expect(status.installed).toBe(true)
    expect(status.version).toBe("2.92.0")
    expect(status.accounts).toEqual([])
  })

  test("gh too old for --json (non-zero, no JSON) → accounts:[] (graceful)", async () => {
    const status = await detectGhCli(
      runner({
        version: { stdout: "gh version 2.20.0 (2023-01-01)\n" },
        status: { code: 1, stderr: "unknown flag: --json" },
      }),
    )
    expect(status.installed).toBe(true)
    expect(status.version).toBe("2.20.0")
    expect(status.accounts).toEqual([])
  })

  test("malformed status JSON → accounts:[] (never throws)", async () => {
    const status = await detectGhCli(
      runner({
        version: { stdout: VERSION_OUT },
        status: { stdout: "not json {" },
      }),
    )
    expect(status.installed).toBe(true)
    expect(status.accounts).toEqual([])
  })

  test("unparseable version string → version:null, still installed", async () => {
    const status = await detectGhCli(
      runner({
        version: { stdout: "weird output" },
        status: { stdout: STATUS_JSON },
      }),
    )
    expect(status.installed).toBe(true)
    expect(status.version).toBeNull()
    expect(status.accounts).toHaveLength(2)
  })

  test("skips non-success entries and entries without a login", async () => {
    const json = JSON.stringify({
      hosts: {
        "github.com": [
          { state: "timeout", active: false, login: "ghost" },
          {
            state: "success",
            active: true,
            host: "github.com",
            scopes: "repo",
          }, // no login
          {
            state: "success",
            active: false,
            host: "github.com",
            login: "carol",
            scopes: "",
          },
        ],
      },
    })
    const status = await detectGhCli(
      runner({ version: { stdout: VERSION_OUT }, status: { stdout: json } }),
    )
    expect(status.accounts).toEqual([
      { login: "carol", host: "github.com", active: false, scopes: [] },
    ])
  })
})
