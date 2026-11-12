import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"

const readRepoFile = (path: string): Promise<string> =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8")

const readWorkflow = (name: string): Promise<string> =>
  readRepoFile(`.github/workflows/${name}`)

const workflowJob = (workflow: string, name: string): string => {
  const start = workflow.indexOf(`\n  ${name}:`)
  expect(start).toBeGreaterThan(-1)
  const rest = workflow.slice(start + 1)
  const next = rest.search(/\n {2}[a-z][\w-]*:\n/u)
  return next === -1 ?
      workflow.slice(start)
    : workflow.slice(start, start + 1 + next)
}

const macosDmgJob = (workflow: string): string =>
  workflow.slice(
    workflow.indexOf("\n  macos-dmg:"),
    workflow.indexOf("\n  windows-installer:"),
  )

describe("release workflow authentication", () => {
  test("active release workflows use no REPOMAN app token", async () => {
    const workflows = await Promise.all([
      readWorkflow("release-please.yml"),
      readWorkflow("release.yml"),
    ])

    for (const workflow of workflows) {
      expect(workflow).not.toContain("REPOMAN_APP_ID")
      expect(workflow).not.toContain("REPOMAN_APP_PRIVATE_KEY")
    }
  })

  test("release-please mints no app token", async () => {
    expect(await readWorkflow("release-please.yml")).not.toContain(
      "actions/create-github-app-token",
    )
  })

  test("no workflow references the old builder PAT", async () => {
    const dir = new URL("../.github/workflows/", import.meta.url)
    const names = (await readdir(dir)).filter((name) => /\.ya?ml$/u.test(name))

    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(await readWorkflow(name)).not.toContain("MACOS_BUILDER_PAT")
    }
  })

  test("macos-dmg starts the builder with an app-repoman token from the release environment", async () => {
    const workflow = await readWorkflow("release.yml")
    const job = macosDmgJob(workflow)

    expect(workflow.match(/actions\/create-github-app-token@/gu)).toHaveLength(
      1,
    )
    expect(job).toMatch(/^ {4}environment: release$/mu)
    expect(job).toContain("app-id: ${{ vars.APP_ID }}")
    expect(job).toContain("private-key: ${{ secrets.APP_PRIVATE_KEY }}")
    expect(job).toContain("owner: stuffbucket")
    expect(job).toContain("repositories: macos-builder")
    expect(job).toContain("permission-actions: write")
    expect(job).toContain(
      "BUILDER_TOKEN: ${{ steps.builder-token.outputs.token }}",
    )
  })

  test("the token and the dispatch are skipped when the builder files are already on the draft", async () => {
    const job = macosDmgJob(await readWorkflow("release.yml"))
    const skipped = "if: steps.builder-files.outputs.built != 'true'"

    expect(job).toContain('echo "built=true" >> "$GITHUB_OUTPUT"')
    expect(job.match(new RegExp(skipped, "gu"))).toHaveLength(2)
    expect(job.indexOf(skipped)).toBeLessThan(job.indexOf("gh workflow run"))
  })
})

describe("release publication contract", () => {
  test("active release paths do not publish to npm", async () => {
    const files = await Promise.all([
      readWorkflow("release.yml"),
      readRepoFile("package.json"),
      readRepoFile("docs/commands.md"),
      readRepoFile("docs/release-runbook.md"),
    ])

    for (const file of files) {
      expect(file).not.toContain("npm publish")
      expect(file).not.toContain("bun publish")
      expect(file).not.toContain("npm_tag")
      expect(file).not.toContain("NPM_TAG")
    }
  })
})

describe("release DAG", () => {
  test("gates every release lane on exact-SHA CI evidence instead of rerunning generic CI", async () => {
    const workflow = await readWorkflow("release.yml")
    const preflight = workflowJob(workflow, "preflight")
    const release = workflowJob(workflow, "release")

    expect(preflight).toContain("actions: read")
    expect(preflight).toContain("bun scripts/verify-release-source.ts")
    expect(preflight).toContain("timeout-minutes: 35")
    expect(preflight).toContain('CI_EVIDENCE_WAIT_SECONDS: "1800"')
    expect(release).toContain("needs: preflight")
    for (const command of [
      "bun run lint:all",
      "bun run typecheck",
      "bun test",
      "bun run build",
      "pnpm test",
    ]) {
      expect(release).not.toContain(command)
    }
  })

  test("builds platform-neutral UI once and transports raw binaries as workflow artifacts", async () => {
    const workflow = await readWorkflow("release.yml")
    const ui = workflowJob(workflow, "ui")
    const binaries = workflowJob(workflow, "binaries")
    const rawAssets = workflowJob(workflow, "raw-assets")
    const windowsShell = workflowJob(workflow, "windows-shell")
    const linuxDeb = workflowJob(workflow, "linux-deb")

    expect(ui).toContain("bun run build:ui")
    expect(ui).toContain("bun run scripts/gen-ui-embed.ts")
    expect(ui).toContain("name: build-ui")
    expect(binaries).not.toContain("needs: release")
    expect(binaries).not.toContain("bun run build:ui")
    expect(binaries).toContain("name: release-binary-${{ matrix.artifact }}")
    expect(windowsShell).toContain("name: release-binary-windows-x64")
    expect(windowsShell).toContain("name: build-ui")
    expect(linuxDeb).toContain("name: release-binary-${{ matrix.artifact }}")
    expect(linuxDeb).toContain("name: build-ui")
    expect(rawAssets).toContain("uses: actions/checkout@")
    expect(rawAssets).toContain("pattern: release-binary-*")
    expect(rawAssets).toContain("uses: ./.github/actions/upload-release-asset")
    expect(rawAssets).toContain("files: dist-release/*")
  })

  test("seals target-specific built-ins before packaging every raw binary", async () => {
    const binaries = workflowJob(await readWorkflow("release.yml"), "binaries")

    for (const mapping of [
      "bun-darwin-arm64) PLATFORM=darwin; ARCHITECTURE=arm64",
      "bun-windows-x64) PLATFORM=win32; ARCHITECTURE=x64",
      "bun-linux-x64) PLATFORM=linux; ARCHITECTURE=x64",
      "bun-linux-arm64) PLATFORM=linux; ARCHITECTURE=arm64",
    ]) {
      expect(binaries).toContain(mapping)
    }
    expect(binaries).toContain("bun run scripts/build-plugin-builtins.ts")
    expect(binaries).toContain("--output=dist-bin/plugin-builtins")
    expect(binaries).toContain('--runtime="bun:$(bun --version)"')
    expect(binaries).toContain('--platform="$PLATFORM"')
    expect(binaries).toContain('--architecture="$ARCHITECTURE"')
    expect(binaries.indexOf("build-plugin-builtins.ts")).toBeLessThan(
      binaries.indexOf("- name: Package"),
    )
  })

  test("stages and verifies sealed built-ins for Windows desktop and MSI packages", async () => {
    const workflow = await readWorkflow("release.yml")
    const msi = workflowJob(workflow, "windows-msi")
    const shell = workflowJob(workflow, "windows-shell")

    expect(msi).toContain(String.raw`plugin-builtins\committed.json`)
    expect(msi).toContain("-bindpath staging")
    expect(shell).toContain("plugin-builtins/committed.json")
    expect(shell).toContain(String.raw`shell\src-tauri\plugin-builtins`)
  })

  test("aggregates checksums only after every checksum-producing lane", async () => {
    const checksums = workflowJob(
      await readWorkflow("release.yml"),
      "checksums",
    )

    for (const producer of [
      "raw-assets",
      "linux-deb",
      "windows-installer",
      "windows-msi",
      "windows-shell",
      "macos-dmg",
    ]) {
      expect(checksums).toContain(`- ${producer}\n`)
    }
  })

  test("reuses release assets only when every companion file is present", async () => {
    const workflow = await readWorkflow("release.yml")
    const installer = workflowJob(workflow, "windows-installer")
    const msi = workflowJob(workflow, "windows-msi")
    const shell = workflowJob(workflow, "windows-shell")
    const dmg = workflowJob(workflow, "macos-dmg")

    expect(installer).toContain('grep -Fxq "install.ps1.sha256"')
    expect(msi).toContain('grep -Fxq "$MSI.sha256"')
    expect(shell).toContain('grep -Fxq "$SETUP.sha256"')
    expect(shell).toContain('grep -Fxq "$SETUP.sig"')
    expect(dmg).toContain('has "maximal-${TAG}-darwin-arm64.dmg.sha256"')
    expect(dmg).toContain('grep -Fxq "$DST.sha256" <<<"$assets"')
  })
})

describe("generated pull request validation", () => {
  test("CI dispatches validate the exact requested SHA", async () => {
    const workflow = await readWorkflow("ci.yml")

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("expected_sha:")
    expect(workflow).toContain("github.sha != inputs.expected_sha")
  })

  test("release automation explicitly dispatches CI for generated PRs", async () => {
    const workflows = await Promise.all([
      readWorkflow("release-please.yml"),
      readWorkflow("release.yml"),
    ])

    for (const workflow of workflows) {
      expect(workflow).toContain("gh workflow run ci.yml")
      expect(workflow).toContain('-f expected_sha="$HEAD_SHA"')
    }
  })
})

describe("release action supply chain", () => {
  test("all external actions use immutable release pins", async () => {
    const workflowDir = new URL("../.github/workflows/", import.meta.url)
    const workflowNames = (await readdir(workflowDir)).filter((name) =>
      /\.ya?ml$/u.test(name),
    )
    const actionDir = new URL("../.github/actions/", import.meta.url)
    const actionNames = (await readdir(actionDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    const sources = await Promise.all([
      ...workflowNames.map(
        async (name) =>
          [`workflows/${name}`, await readWorkflow(name)] as const,
      ),
      ...actionNames.map(
        async (name) =>
          [
            `actions/${name}/action.yml`,
            await readRepoFile(`.github/actions/${name}/action.yml`),
          ] as const,
      ),
    ])
    const violations: Array<string> = []

    for (const [path, source] of sources) {
      for (const [index, line] of source.split("\n").entries()) {
        const actionUse = line.match(/^\s*(?:-\s*)?uses:\s+(\S.*)$/u)?.[1]
        if (!actionUse || actionUse.startsWith("./")) continue
        if (!/^[^@\s]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u.test(actionUse)) {
          violations.push(`${path}:${index + 1}: ${actionUse}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  test("the TruffleHog wrapper and scanner image use the same release", async () => {
    const workflow = await readWorkflow("secret-scan.yml")
    const wrapperVersion = workflow.match(
      /trufflesecurity\/trufflehog@[0-9a-f]{40} # v(\d+\.\d+\.\d+)/u,
    )?.[1]
    const scannerVersion = workflow.match(
      /^\s*version:\s+["']?([^"'\s]+)["']?\s*$/mu,
    )?.[1]

    expect(wrapperVersion).toBeDefined()
    expect(scannerVersion).toBe(wrapperVersion)
  })

  test("workflow project runtimes use the canonical Node pin", async () => {
    const canonicalNode = (await readRepoFile("mise.toml")).match(
      /^node = "([^"]+)"$/mu,
    )?.[1]
    if (!canonicalNode) throw new Error("mise.toml does not pin Node")

    const workflowDir = new URL("../.github/workflows/", import.meta.url)
    const workflowNames = (await readdir(workflowDir)).filter((name) =>
      /\.ya?ml$/u.test(name),
    )
    const configuredVersions = (
      await Promise.all(workflowNames.map((name) => readWorkflow(name)))
    ).flatMap((workflow) =>
      Array.from(
        workflow.matchAll(/^\s*node-version:\s+["']?([^"'\s]+)["']?\s*$/gmu),
        (match) => match[1],
      ),
    )

    expect(configuredVersions.length).toBeGreaterThan(0)
    for (const version of configuredVersions) {
      expect(version).toBe(canonicalNode)
    }
  })

  test("release actions use the expected current releases", async () => {
    const workflow = await readWorkflow("release.yml")
    const externalUses = workflow.split("\n").flatMap((line) => {
      const marker = "uses: "
      const markerIndex = line.indexOf(marker)
      if (markerIndex === -1) return []

      const actionUse = line.slice(markerIndex + marker.length).trim()
      return actionUse.startsWith("./") ? [] : [actionUse]
    })
    const expectedUses = new Map([
      [
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
        15,
      ],
      [
        "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2",
        10,
      ],
      [
        "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2",
        6,
      ],
      [
        "actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0",
        1,
      ],
    ])

    expect(externalUses).toHaveLength(32)
    for (const [expectedUse, count] of expectedUses) {
      expect(
        externalUses.filter((actionUse) => actionUse === expectedUse),
      ).toHaveLength(count)
    }
    for (const actionUse of externalUses) {
      expect(actionUse).toMatch(/^[^@\s]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u)
    }
  })

  test("the local Rust action release.yml uses pins its external actions too", async () => {
    const action = await readRepoFile(
      ".github/actions/setup-rust-windows/action.yml",
    )
    const uses = action
      .split("\n")
      .flatMap((line) => line.match(/uses: (\S.*)$/u)?.[1] ?? [])

    expect(uses).toEqual([
      "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0",
    ])
  })

  test("does not provision Node when the workflow does not invoke it", async () => {
    const workflow = await readWorkflow("release.yml")

    expect(workflow).not.toContain("actions/setup-node")
    expect(workflow).not.toContain("node-version:")
  })

  test("macOS signing is delegated to macos-builder", async () => {
    const workflow = await readWorkflow("release.yml")

    expect(workflow).toContain("--repo stuffbucket/macos-builder")
    expect(workflow).not.toContain("Codesign (macOS)")
    expect(workflow).not.toContain("Notarize (macOS)")
    expect(workflow).not.toContain("MACOS_DEVELOPER_ID")
    expect(workflow).not.toContain("AC_USERNAME")
    expect(workflow).not.toContain("AC_PASSWORD")
    expect(workflow).not.toContain("AC_TEAM_ID")
  })
})

describe("parked MCP broker distribution", () => {
  test("raw release archives carry maximal and its sealed plugin generation", async () => {
    const workflow = await readWorkflow("release.yml")

    expect(workflow).toContain(
      '7z a "../dist-release/${BASE}.zip" maximal.exe plugin-builtins',
    )
    expect(workflow).toContain(
      'tar -czf "../dist-release/${BASE}.tar.gz" maximal plugin-builtins',
    )
    expect(workflow).not.toContain("mcp-broker")
    expect(workflow).not.toContain("pnpm install --frozen-lockfile")
  })

  test("deb and Homebrew packaging do not ship or smoke-test a broker", async () => {
    const [debSmoke, debBuild, formula] = await Promise.all([
      readRepoFile("build/linux/smoke-deb.sh"),
      readRepoFile("build/linux/build-maximal-deb.sh"),
      readRepoFile("build/homebrew/maximal.rb"),
    ])

    expect(debSmoke).toContain("[ ! -e /usr/bin/maximal-mcp-broker ]")
    expect(debSmoke).not.toContain("USAGE")
    expect(debBuild).not.toContain("maximal-mcp-broker")
    expect(formula).not.toContain("maximal-mcp-broker")
  })

  test("macOS signs only the maximal sidecar", async () => {
    const config = await readRepoFile(".macos-builder/config")
    const producer = await readRepoFile(".macos-builder/build.sh")

    expect(config).toContain("Contents/MacOS/maximal:bun-runtime")
    expect(config).not.toContain("maximal-mcp-broker")
    expect(producer).not.toContain("BROKER")
    expect(producer).not.toContain("mcp-broker")
  })

  test("Windows installers don't ship the broker but still clear one from older installs", async () => {
    const [wix, installer, shellWorkflow, installerWorkflow] =
      await Promise.all([
        readRepoFile("build/windows/maximal.wxs"),
        readRepoFile("build/windows/install.ps1"),
        readWorkflow("windows-shell-dev.yml"),
        readWorkflow("windows-installer-dev.yml"),
      ])

    // Not packaged.
    expect(wix).not.toContain('Source="maximal-mcp-broker.exe"')
    expect(wix).toContain(String.raw`<Files Include="plugin-builtins\**" />`)
    expect(shellWorkflow).not.toContain("mcp-broker")
    expect(installerWorkflow).not.toContain("packages/mcp-broker")
    // Upgrade/uninstall still stops and removes a broker an older version left.
    expect(wix).toContain("StopRunningMcpBroker")
    expect(installer).toContain("$BrokerPath")
    expect(installer).toContain("maximal-mcp-broker.exe")
    expect(installer).toContain("Write-Uninstaller")
    expect(installer).toContain("& $BinPath uninstall --force --unattended")
    expect(shellWorkflow).toContain("x86_64-pc-windows-msvc")
    expect(installerWorkflow).toContain(
      "Uninstall through PowerShell ARP helper",
    )
    expect(installerWorkflow).toContain(
      "foreach ($file in @('maximal.exe', 'maximal-mcp-broker.exe', 'uninstall.ps1'))",
    )
  })
})

describe("Linux Rust cache", () => {
  test("separates native architectures and only writes trusted main caches", async () => {
    const [action, workflow, release] = await Promise.all([
      readRepoFile(".github/actions/setup-rust-linux/action.yml"),
      readWorkflow("linux-rust-cache.yml"),
      readWorkflow("release.yml"),
    ])

    expect(action).toContain('base="$os-$arch-cargo-shell-$version"')
    expect(action).toContain("shell/src-tauri/Cargo.lock")
    expect(action).toContain("shell/src-tauri/src/**")
    expect(action).toContain("shell/src-tauri/patches/**")
    expect(action).toContain("actions/cache/restore@")
    expect(action).not.toContain("actions/cache/save@")

    expect(release).toContain("uses: ./.github/actions/setup-rust-linux")
    expect(release).not.toContain("actions/cache/save@")

    expect(workflow).toContain("runner: ubuntu-24.04 }")
    expect(workflow).toContain("runner: ubuntu-24.04-arm }")
    expect(workflow).not.toContain("pull_request:")
    expect(workflow).not.toContain("tags:")

    const saveStep = workflow.slice(
      workflow.indexOf("      - name: Save Cargo registry + target"),
    )
    expect(saveStep).toContain("github.ref == 'refs/heads/main'")
    expect(saveStep).toContain("github.event_name == 'push'")
    expect(saveStep).toContain("github.event_name == 'schedule'")
    expect(saveStep).toContain("github.event_name == 'workflow_dispatch'")
  })

  test("warms the release profile without fake external sidecars", async () => {
    const workflow = await readWorkflow("linux-rust-cache.yml")

    expect(workflow).toContain("tauri build --no-bundle")
    expect(workflow).toContain('"bundle":{"externalBin":[]}')
    expect(workflow).not.toContain(": > src-tauri/binaries/")
  })
})

const windowsShellJob = (workflow: string): string =>
  workflow.slice(
    workflow.indexOf("\n  windows-shell:"),
    workflow.indexOf("\n  publish:"),
  )

describe("Windows desktop lifecycle smoke", () => {
  test("caches Bun downloads and retries transient package-feed failures", async () => {
    const [shellWorkflow, cacheWorkflow, setupBun] = await Promise.all([
      readWorkflow("windows-shell-dev.yml"),
      readWorkflow("windows-rust-cache.yml"),
      readRepoFile(".github/actions/setup-bun/action.yml"),
    ])

    expect(setupBun).toContain("path: ~/.bun/bin")
    expect(setupBun).toContain("path: ~/.bun/install/cache")
    expect(setupBun).toContain("hashFiles('bun.lock', 'shell/bun.lock')")
    expect(setupBun.match(/actions\/cache@55cc8345/gu)).toHaveLength(2)
    expect(shellWorkflow).toContain('cache-dependencies: "true"')
    expect(cacheWorkflow).toContain('cache-dependencies: "true"')
    expect(shellWorkflow.match(/for attempt in 1 2 3;/gu)).toHaveLength(2)
    expect(
      shellWorkflow.match(/sleep "\$\(\(attempt \* 15\)\)"/gu),
    ).toHaveLength(2)
    expect(cacheWorkflow).toContain(
      "retry_install bun install --frozen-lockfile",
    )
    expect(cacheWorkflow).toContain(
      "(cd shell && retry_install bun install --frozen-lockfile)",
    )
  })

  test("tests reinstall, configurator cleanup, and abrupt containment before uninstall", async () => {
    const workflow = await readWorkflow("windows-shell-dev.yml")

    expect(workflow).toContain(
      "cargo test --release --manifest-path shell/src-tauri/Cargo.toml",
    )
    expect(workflow).toContain("name: Launch installed app and verify sidecar")
    expect(
      workflow.match(/\$deadline = \(Get-Date\)\.AddSeconds\(60\)/gu),
    ).toHaveLength(4)
    expect(workflow).toContain("name: Seed isolated app integration fixtures")
    expect(workflow).toContain("COPILOT_API_HOME=$maximalHome")
    expect(workflow).toContain("CLAUDE_CONFIG_DIR=$claudeHome")
    expect(workflow).toContain("CODEX_HOME=$codexHome")
    expect(workflow).toContain(
      "name: Reinstall NSIS app while Maximal is running",
    )
    expect(workflow).toContain(
      "pre-reinstall shell PID $oldShellPid survived NSIS reinstall",
    )
    expect(workflow).toContain(
      "pre-reinstall sidecar PID $oldSidecarPid survived NSIS reinstall",
    )
    expect(workflow).toContain(
      "replacement sidecar did not answer /status within 60 seconds after reinstall",
    )
    expect(workflow).toContain("dist/reinstall-pids.json")
    expect(workflow).toContain(
      "name: Confirm packaged window close and verify bounded app exit",
    )
    expect(workflow).toContain(
      "ordinary startup did not create a minimized taskbar-backed main window",
    )
    expect(workflow).toContain(
      "[MaximalStartupWindowSmoke]::IsIconic($candidate)",
    )
    expect(
      workflow.indexOf("public static class MaximalStartupWindowSmoke"),
    ).toBeLessThan(
      workflow.indexOf(
        "$shellProcess = Start-Process -FilePath $shellPath -PassThru",
      ),
    )
    expect(workflow).toContain("$foregroundBeforeLaunch =")
    expect(workflow).toContain("GetForegroundWindow()")
    expect(workflow).toContain(
      "startup main window was foreground at the minimized snapshot",
    )
    expect(workflow).toContain("activated = $startupDisplacedForeground")
    expect(workflow).not.toContain(
      'throw "startup main window displaced the existing foreground window"',
    )
    expect(workflow).toContain("WS_EX_TOOLWINDOW")
    expect(workflow).toContain("dist/startup-window.json")
    expect(workflow).toContain("-ArgumentList '--maximal-action=dashboard'")
    expect(workflow).toContain("$windowTitle -eq 'Maximal — Dashboard'")
    expect(workflow).toContain("$windowHandle -ne $preActionWindowHandle")
    expect(workflow).toContain("[MaximalWindowSmoke]::PostMessage(")
    expect(workflow).toContain("$windowHandle, 0x0010")
    expect(workflow).toContain("Add-Type -AssemblyName UIAutomationClient")
    expect(workflow).toContain("'Quit Maximal' confirmation button")
    expect(workflow).toContain(
      "shell PID $shellPid exited while quit confirmation was pending",
    )
    expect(workflow).toContain("$invokePattern.Invoke()")
    expect(workflow).not.toContain('/_internal/shutdown"')
    expect(workflow).toContain(
      "sidecar PID $sidecarPid survived bounded graceful shutdown",
    )
    expect(workflow).toContain(
      "shell PID $shellPid survived bounded graceful shutdown",
    )
    expect(workflow).toContain("dist/graceful-shutdown-pids.json")
    expect(workflow).toContain(
      "packaged Claude Code configurator did not apply the active proxy URL",
    )
    expect(workflow).toContain(
      "packaged Codex configurator did not apply the active provider routing",
    )
    expect(workflow).toContain(
      "Claude Code proxy URL survived bounded graceful shutdown",
    )
    expect(workflow).toContain(
      "Codex graceful cleanup did not restore the seeded user config exactly",
    )
    expect(workflow).toContain(
      "graceful cleanup removed durable app routing intent",
    )
    expect(workflow).toContain("dist/configurator-verification.json")
    expect(workflow).toContain("diagnostics/configurator-state.json")
    expect(workflow).toContain(
      "name: Force shell exit and verify sidecar containment",
    )
    expect(workflow).toContain("Stop-Process -Id $shellPid -Force")
    expect(workflow).toContain(
      "sidecar PID $sidecarPid survived forced shell exit",
    )
    expect(workflow).toContain(
      "Get-NetTCPConnection -OwningProcess $sidecarPid",
    )
    expect(workflow).toContain("Get-Process -Name 'maximal-shell', 'maximal'")
    expect(workflow).toContain('"_?=$installRoot"')
    expect(workflow).toContain("$p.WaitForExit(60000)")
    expect(workflow).toContain("uninstaller timed out with Maximal running")
    expect(workflow).toContain("Maximal processes remain after uninstall")
    expect(workflow).toContain("Remove-Item $installRoot -Recurse -Force")
    expect(workflow).toContain("name: Capture Windows lifecycle diagnostics")
    expect(workflow).toContain("diagnostics/processes.json")
    expect(workflow).toContain("@('session-running', 'maximal.pid')")
    expect(workflow).not.toContain(
      "Copy-Item $appData diagnostics/appdata -Recurse",
    )
    expect(workflow).toContain("name: Upload Windows lifecycle diagnostics")
  })
})

describe("in-place desktop updates", () => {
  test("the NSIS build is signed for the updater with the release environment secrets", async () => {
    const job = windowsShellJob(await readWorkflow("release.yml"))

    expect(job).toMatch(/^ {4}environment: release$/mu)

    expect(job).toContain(String.raw`\"createUpdaterArtifacts\":true`)
    expect(job).toContain(
      "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    )
    expect(job).toContain(
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    )
    expect(job).toContain("${{ vars.TAURI_SIGNING_PUBLIC_KEY }}")
    expect(job).not.toMatch(/echo[^\n]*TAURI_SIGNING_PRIVATE_KEY/u)
  })

  test("the installer's signature is verified and attached beside it", async () => {
    const job = windowsShellJob(await readWorkflow("release.yml"))

    expect(job).toContain("bun scripts/verify-updater-signature.ts")
    expect(job.indexOf("bun scripts/verify-updater-signature.ts")).toBeLessThan(
      job.indexOf("Attach Windows shell installer to release"),
    )
    expect(job).toContain('Copy-Item $sig "$dst.sig" -Force')
    expect(job).toContain(
      "dist-release/maximal-${{ env.TAG }}-windows-x64-setup.exe.sig",
    )
  })

  test("macOS asks the builder for the updater bundle, named like the release", async () => {
    const config = await readRepoFile(".macos-builder/config")

    expect(config).toMatch(/^artifact = dmg,updater$/mu)
    expect(config).toMatch(
      /^updater_name = maximal-\{tag\}-darwin-arm64\.app\.tar\.gz$/mu,
    )
  })

  test("macos-dmg waits for the bundle and its signature, then verifies them", async () => {
    const job = macosDmgJob(await readWorkflow("release.yml"))

    expect(job).toContain(
      "TARBALL: maximal-${{ github.ref_name }}-darwin-arm64.app.tar.gz",
    )
    expect(job).toContain(
      'has "$TARBALL" && has "$TARBALL.sig" && has "$TARBALL.sha256"',
    )
    expect(job).toContain('sha256sum -c "$TARBALL.sha256"')
    expect(job).toContain("bun scripts/verify-updater-signature.ts")
    // Every run verifies, even when the files were already on the draft.
    expect(job).not.toMatch(/nothing to do/u)
  })

  test("the manifest PR carries the desktop updater manifest", async () => {
    const workflow = await readWorkflow("release.yml")
    const manifestJob = workflow.slice(workflow.indexOf("\n  manifest:"))

    expect(manifestJob).toContain("git add -A -- site/public/updates")
  })
})

describe("manifest publication", () => {
  test("the manifest job proposes a protected PR instead of pushing main", async () => {
    const workflow = await readWorkflow("release.yml")
    const manifestJob = workflow.slice(workflow.indexOf("\n  manifest:"))

    expect(manifestJob).toContain("pull-requests: write")
    expect(manifestJob).toContain("actions: write")
    expect(manifestJob).toContain("automation/updates-manifest")
    expect(manifestJob).toContain("gh pr create")
    expect(manifestJob).not.toContain("git push origin HEAD:main")
  })

  test("the manifest job installs dependencies before generation and tests", async () => {
    const workflow = await readWorkflow("release.yml")
    const manifestJob = workflow.slice(workflow.indexOf("\n  manifest:"))
    const installIndex = manifestJob.indexOf("bun install --frozen-lockfile")
    const generationIndex = manifestJob.indexOf(
      "bun scripts/write-updates-manifest.ts",
    )
    const testIndex = manifestJob.indexOf("bun test")

    expect(installIndex).toBeGreaterThan(-1)
    expect(generationIndex).toBeGreaterThan(installIndex)
    expect(testIndex).toBeGreaterThan(installIndex)
  })

  test("the manifest job uses tested PR discovery and validates the pushed SHA", async () => {
    const workflow = await readWorkflow("release.yml")
    const manifestJob = workflow.slice(workflow.indexOf("\n  manifest:"))

    expect(
      manifestJob.match(/bun scripts\/list-manifest-prs\.ts/gu),
    ).toHaveLength(2)
    expect(manifestJob).toContain(
      'git ls-remote origin "refs/heads/${HEAD_BRANCH}"',
    )
    expect(manifestJob).toContain('CURRENT_SHA" != "$HEAD_SHA')
    expect(manifestJob).toContain("gh workflow run ci.yml")
    expect(manifestJob).toContain('-f expected_sha="$HEAD_SHA"')
  })
})
