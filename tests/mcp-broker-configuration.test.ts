import { describe, expect, it } from "bun:test"

import {
  BrokerConfigurationError,
  brokerExecutableCandidates,
  brokerProcessEnvironment,
  resolveBrokerConfiguration,
} from "~/lib/mcp-broker/configuration"

describe("brokerProcessEnvironment", () => {
  it("copies only the platform baseline", () => {
    const environment = brokerProcessEnvironment({
      HOME: "/tmp/home",
      PATH: "/bin",
      GITHUB_TOKEN: "must-not-leak",
      MAXIMAL_SHELL_KEY: "must-not-leak",
    })

    expect<string | undefined>(environment.HOME).toBe(
      process.platform === "win32" ? undefined : "/tmp/home",
    )
    expect(environment.PATH).toBe("/bin")
    expect(environment.GITHUB_TOKEN).toBeUndefined()
    expect(environment.MAXIMAL_SHELL_KEY).toBeUndefined()
  })
})

describe("brokerExecutableCandidates", () => {
  it("prefers the broker installed beside the primary executable", () => {
    const candidates = brokerExecutableCandidates(
      undefined,
      "/opt/maximal/maximal",
    )

    expect(candidates[0]).toBe(
      `/opt/maximal/maximal-mcp-broker${process.platform === "win32" ? ".exe" : ""}`,
    )
  })
})

describe("resolveBrokerConfiguration", () => {
  it("builds a resolved endpoint from explicit non-secret environment", () => {
    const result = resolveBrokerConfiguration(
      {
        limits: { httpBodyBytes: 4096 },
        supervision: { heartbeatIntervalMs: 3_000 },
        servers: [
          {
            id: "fixture",
            label: "Fixture",
            transport: { type: "stdio", command: "fixture", args: ["serve"] },
            environment: {
              inherit: ["HOME"],
              values: { FIXTURE_MODE: "safe" },
            },
          },
        ],
      },
      { HOME: "/tmp/home", GITHUB_TOKEN: "must-not-leak" },
    )

    expect(result).toEqual({
      endpoints: [
        {
          id: "fixture",
          label: "Fixture",
          command: "fixture",
          args: ["serve"],
          environment: { HOME: "/tmp/home", FIXTURE_MODE: "safe" },
          protocol: "auto",
          interaction: "auto",
          ownership: "auto",
          initializeTimeoutMs: 30_000,
          callTimeoutMs: 120_000,
          shutdownTimeoutMs: 2_000,
        },
      ],
      httpBodyBytes: 4096,
      heartbeatIntervalMs: 3_000,
    })
  })

  it("omits disabled endpoints", () => {
    expect(
      resolveBrokerConfiguration({
        servers: [
          {
            id: "disabled",
            label: "Disabled",
            enabled: false,
            transport: { type: "stdio", command: "disabled" },
          },
        ],
      }).endpoints,
    ).toEqual([])
  })

  it("never sends the endpoint client key to the broker", () => {
    const result = resolveBrokerConfiguration({
      servers: [
        {
          id: "keyed",
          label: "Keyed",
          apiKey: "client-key-must-stay-in-sidecar",
          transport: { type: "stdio", command: "keyed" },
        },
      ],
    })

    expect(JSON.stringify(result)).not.toContain(
      "client-key-must-stay-in-sidecar",
    )
  })

  it("rejects inherited provider credentials", () => {
    expect(() =>
      resolveBrokerConfiguration(
        {
          servers: [
            {
              id: "unsafe",
              label: "Unsafe",
              transport: { type: "stdio", command: "unsafe" },
              environment: { inherit: ["GITHUB_TOKEN"] },
            },
          ],
        },
        { GITHUB_TOKEN: "secret" },
      ),
    ).toThrow(BrokerConfigurationError)
  })

  it("rejects fixed values that appear to contain credentials", () => {
    for (const name of [
      "SERVICE_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "LOGIN_COOKIE",
    ]) {
      expect(() =>
        resolveBrokerConfiguration({
          servers: [
            {
              id: "unsafe",
              label: "Unsafe",
              transport: { type: "stdio", command: "unsafe" },
              environment: { values: { [name]: "secret" } },
            },
          ],
        }),
      ).toThrow(BrokerConfigurationError)
    }
  })

  it("fails closed until secret references have a secure resolver", () => {
    expect(() =>
      resolveBrokerConfiguration({
        servers: [
          {
            id: "future-secret",
            label: "Future secret",
            transport: { type: "stdio", command: "server" },
            environment: { secretRefs: { SERVICE_TOKEN: "stored-token" } },
          },
        ],
      }),
    ).toThrow(BrokerConfigurationError)
  })
})
