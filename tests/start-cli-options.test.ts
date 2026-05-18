/**
 * `maximal start` CLI argument schema — exhaustive coverage of the
 * citty `defineCommand` config object.
 *
 * Why this matters: ~60% of the surviving mutants on src/start.ts are
 * StringLiteral mutations inside the `args:` block (flag keys,
 * defaults, descriptions) and the `args["<flag>"]` lookups in `run()`.
 * If `"github-token"` is silently renamed to `""`, the CLI flag
 * vanishes and nothing else in the suite notices. These assertions
 * pin every flag key, default, type, alias, and description that
 * users (and downstream callers like the Tauri shell) rely on.
 *
 * Inspection-only — no subprocess, no port binding, no auth flow.
 */
import { describe, expect, test } from "bun:test"

import { start } from "~/start"

interface ArgConfig {
  alias?: string
  type: string
  default?: unknown
  description?: string
}

// The `args` field is typed as a record of ArgsDef in citty; tighten
// to our known shape for assertions.
const args = (start.args ?? {}) as Record<string, ArgConfig>

describe("start command meta", () => {
  test("command is named 'start'", () => {
    const meta = start.meta as { name?: string; description?: string }
    expect(meta.name).toBe("start")
  })

  test("description mentions Copilot API", () => {
    const meta = start.meta as { name?: string; description?: string }
    expect(meta.description).toBe("Start the Copilot API server")
  })
})

describe("start command CLI args — exact key set", () => {
  test("declares exactly the expected flag keys", () => {
    expect(Object.keys(args).sort()).toEqual(
      [
        "account-type",
        "claude-code",
        "github-token",
        "manual",
        "port",
        "proxy-env",
        "rate-limit",
        "show-token",
        "verbose",
        "wait",
      ].sort(),
    )
  })
})

describe("start command CLI args — port", () => {
  test("alias is -p", () => {
    expect(args.port.alias).toBe("p")
  })
  test("type is string (citty parses then we Number.parseInt)", () => {
    expect(args.port.type).toBe("string")
  })
  test("default is '4141'", () => {
    expect(args.port.default).toBe("4141")
  })
  test("description is human-readable", () => {
    expect(args.port.description).toBe("Port to listen on")
  })
})

describe("start command CLI args — verbose", () => {
  test("alias is -v", () => {
    expect(args.verbose.alias).toBe("v")
  })
  test("type is boolean", () => {
    expect(args.verbose.type).toBe("boolean")
  })
  test("default is false", () => {
    expect(args.verbose.default).toBe(false)
  })
  test("description is 'Enable verbose logging'", () => {
    expect(args.verbose.description).toBe("Enable verbose logging")
  })
})

describe("start command CLI args — account-type", () => {
  test("alias is -a", () => {
    expect(args["account-type"].alias).toBe("a")
  })
  test("type is string", () => {
    expect(args["account-type"].type).toBe("string")
  })
  test("default is 'individual'", () => {
    expect(args["account-type"].default).toBe("individual")
  })
  test("description lists the three valid options", () => {
    expect(args["account-type"].description).toBe(
      "Account type to use (individual, business, enterprise)",
    )
  })
})

describe("start command CLI args — manual", () => {
  test("type is boolean", () => {
    expect(args.manual.type).toBe("boolean")
  })
  test("default is false", () => {
    expect(args.manual.default).toBe(false)
  })
  test("description is 'Enable manual request approval'", () => {
    expect(args.manual.description).toBe("Enable manual request approval")
  })
  test("has no short alias (manual is rare; explicit only)", () => {
    expect(args.manual.alias).toBeUndefined()
  })
})

describe("start command CLI args — rate-limit", () => {
  test("alias is -r", () => {
    expect(args["rate-limit"].alias).toBe("r")
  })
  test("type is string (parsed via Number.parseInt)", () => {
    expect(args["rate-limit"].type).toBe("string")
  })
  test("description mentions seconds", () => {
    expect(args["rate-limit"].description).toBe(
      "Rate limit in seconds between requests",
    )
  })
})

describe("start command CLI args — wait", () => {
  test("alias is -w", () => {
    expect(args.wait.alias).toBe("w")
  })
  test("type is boolean", () => {
    expect(args.wait.type).toBe("boolean")
  })
  test("default is false", () => {
    expect(args.wait.default).toBe(false)
  })
  test("description explains rate-limit dependency", () => {
    expect(args.wait.description).toBe(
      "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    )
  })
})

describe("start command CLI args — github-token", () => {
  test("alias is -g", () => {
    expect(args["github-token"].alias).toBe("g")
  })
  test("type is string", () => {
    expect(args["github-token"].type).toBe("string")
  })
  test("has no default (override only)", () => {
    expect(args["github-token"].default).toBeUndefined()
  })
  test("description directs the user to the `auth` subcommand", () => {
    expect(args["github-token"].description).toBe(
      "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    )
  })
})

describe("start command CLI args — claude-code", () => {
  test("alias is -c", () => {
    expect(args["claude-code"].alias).toBe("c")
  })
  test("type is boolean", () => {
    expect(args["claude-code"].type).toBe("boolean")
  })
  test("default is false", () => {
    expect(args["claude-code"].default).toBe(false)
  })
  test("description mentions Claude Code launch helper", () => {
    expect(args["claude-code"].description).toBe(
      "Generate a command to launch Claude Code with Copilot API config",
    )
  })
})

describe("start command CLI args — show-token", () => {
  test("type is boolean", () => {
    expect(args["show-token"].type).toBe("boolean")
  })
  test("default is false (we don't leak tokens by default)", () => {
    expect(args["show-token"].default).toBe(false)
  })
  test("description is the operator-grep-friendly form", () => {
    expect(args["show-token"].description).toBe(
      "Show GitHub and Copilot tokens on fetch and refresh",
    )
  })
})

describe("start command CLI args — proxy-env", () => {
  test("type is boolean", () => {
    expect(args["proxy-env"].type).toBe("boolean")
  })
  test("default is false", () => {
    expect(args["proxy-env"].default).toBe(false)
  })
  test("description mentions environment variables", () => {
    expect(args["proxy-env"].description).toBe(
      "Initialize proxy from environment variables",
    )
  })
})
