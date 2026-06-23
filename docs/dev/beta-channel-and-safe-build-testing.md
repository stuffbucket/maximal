# Beta channel & safe build testing

> **Why this doc exists.** We now use Maximal to develop Maximal. That
> creates two problems that don't exist for a normal app:
>
> 1. **Self-collision.** A dev/test build fights the *host's* running
>    Maximal for `localhost:4141`, shared config, and a shared install
>    slot. Testing a build can take down the proxy you're coding against.
> 2. **No pre-release lane.** Today every shippable change flows
>    `main → v* tag → "Latest"`. There is no way to put a fix in beta
>    testers' hands without disturbing the production "Latest" build.
>
> This doc is the strategy for both. It's split into two independent
> pillars — you can adopt Pillar 1 (safe local testing) without Pillar 2
> (the beta release channel), and vice-versa.

---

## The collision, concretely

Three resources are shared by *any* second Maximal on the same machine.
All three are currently pinned to one value:

| Shared resource | Pinned to | Where |
|---|---|---|
| **Port** | `4141` | `src/lib/start/cli.ts` (`--port` default), `SIDECAR_PORT` in `shell/src-tauri/src/lib.rs`, `app-dev-prepare.ts`. The webview URLs (`/ui/settings/`, `/ui/dashboard/`) and `baseUrl()` in `shell/src/proxy/client.ts` are now **same-origin**, so they follow whatever port `SIDECAR_PORT` opens — no separate pin. |
| **App identity** (install slot, tray, OS app-data) | bundle id `co.stuffbucket.maximal`, productName `Maximal` | `shell/src-tauri/tauri.conf.json` |
| **Config / tokens / logs** | `~/.local/share/maximal` | `src/lib/paths.ts` (`DEFAULT_DIR`, overridable via `COPILOT_API_HOME` / `--api-home`) |

Two extra footguns specific to "Maximal building Maximal":

- **The shell spawns its sidecar with `--replace`** (`lib.rs`), which
  *evicts* whatever is on `:4141`. Launch a same-port test build and it
  kills the host proxy you're developing against.
- **A `dev`/test build that reconfigures Claude Code / Claude Desktop will
  repoint your *real* integration at the dev port.** `PROXY_BASE_URL`
  in `src/lib/claude-code-settings.ts` is hardcoded to `:4141`, and
  `src/lib/claude-desktop-3p-config.ts` defaults its `baseUrl` to
  `http://127.0.0.1:4141`. The `dev` channel runs on `4242`, so it must
  **not** write those integration files (or must write them to a separate
  profile) — otherwise it points your client at the dev sidecar. This is
  the single most dangerous interaction — it silently breaks the host's
  day-to-day setup. (Beta is safe here: it shares `4141`, so the URL it
  would write matches stable anyway.)

The good news: the override seams already exist (`--port`, `--api-home` /
`COPILOT_API_HOME`, Tauri's per-identifier app-data; the webview is
same-origin so it follows the sidecar port automatically). The work is
threading **one channel switch** through them instead of overriding each
by hand.

---

## Pillar 1 — Safe local & test builds

Isolate along all three axes at once, driven by a single
`MAXIMAL_CHANNEL` selector so there's one source of truth.

### The channel abstraction

| `MAXIMAL_CHANNEL` | Port | Bundle id | Product name | `COPILOT_API_HOME` | Writes Claude integration? |
|---|---|---|---|---|---|
| `stable` (default) | 4141 | `co.stuffbucket.maximal` | Maximal | `~/.local/share/maximal` | yes |
| `beta` | 4141\* | `co.stuffbucket.maximal.beta` | Maximal Beta | `~/.local/share/maximal-beta` | **no** (opt-in only) |
| `dev` (inner loop) | 4242\*\* | n/a (run from source) | n/a | `~/.local/share/maximal-dev` | no |

\* **`beta` shares `4141` with `stable` on purpose.** There is no use
case for running a beta build *and* the production build at the same time
— you run one or the other. Launching beta therefore evicts stable via
the existing `--replace` (and vice-versa); they never coexist, so beta
needs **no** port isolation. Beta still keeps a distinct bundle id and
`~/.local/share/maximal-beta` so its tokens/config can't corrupt stable's.

\*\* **`dev` gets the distinct port (`4242`), not beta.** The common case
is editing Maximal *while your installed stable build keeps serving Claude
on `4141`*. If `dev` bound `4141` it would evict that stable proxy
(`app-dev-prepare.ts` does so *gracefully* today, but it still takes it
down). Moving `dev` to `4242` lets `bun run app:dev` run **alongside**
stable without touching it. `dev` must not write the Claude integration
files (it would repoint your real client at `4242`).

Implementation sketch (Phase 1 below): one small `src/lib/channel.ts`
that reads `MAXIMAL_CHANNEL` and derives `{ port, bundleSuffix,
productName, apiHome }`; the Tauri `SIDECAR_PORT` and identifier read the
same env at build time; the webview `baseUrl()` is same-origin, so it
needs no change — it follows whatever port the sidecar opens.

### Port strategy (stable vs beta)

The port is the highest-drift seam: it is hardcoded **twice and
independently** today — `SIDECAR_PORT = 4141` (Rust const, `lib.rs`) and
`default: "4141"` (TS CLI, `cli.ts`) — plus literal `:4141` in the Claude
integration writers (`claude-code-settings.ts`, `claude-desktop-3p-config.ts`).
That duplication is exactly what caused the historical `4142` drift bug
that broke `app:dev` (PR #119). The strategy is built to kill that bug
class, not just to pick a second number.

1. **Port = `f(MAXIMAL_CHANNEL)`, defined once, derived everywhere.**
   Never write a second port literal. Define the channel→port map in one
   place and have both languages consume it: Rust `SIDECAR_PORT` reads
   `MAXIMAL_CHANNEL` **at build time** (via `build.rs`/env, the same way
   `release.yml` already injects `MAXIMAL_VERSION` / `MAXIMAL_GIT_SHA`);
   the TS `--port` default and `channel.ts` derive from the same env at
   runtime. Single source of truth ⇒ no drift.

2. **Channel→port map: `stable` and `beta` both `4141`; `dev` `4242`.**
   `beta` and `stable` never run at the same time (you use one or the
   other), so they share `4141` and the "replace" semantics below handle
   the handoff — beta needs no port of its own. `dev` is the channel that
   *does* run beside stable, so it gets the distinct port. Use `4242`, not
   `4142`: `4142` is poisoned by the past drift bug; reusing it invites
   confusion and regressions.

3. **Replace vs. coexist — distinct ports make `--replace` self-scoping.**
   The shell spawns `start --port <channel-port> --replace` (`lib.rs`).
   - **stable ↔ beta (shared `4141`):** launching one evicts the other via
     `--replace`. That's the *intended* handoff — they never coexist.
   - **dev (`4242`):** because it's a different port, `bun run app:dev`
     binds `4242` and **never touches** the stable proxy on `4141`. The
     self-collision that motivated this whole doc only existed because dev
     shared stable's port; moving dev off `4141` removes it by
     construction.

4. **Belt-and-suspenders: write the *actual bound* port to a
   channel-scoped runtime file, and discover from it.** A static default
   is fine until someone passes `--port` or the port is already taken. On
   successful bind, write the live port to `$COPILOT_API_HOME/runtime.json`
   (already channel-scoped via `apiHome`). The shell webview/dashboard URL
   and the Claude integration writers then *read* it instead of
   re-hardcoding `:4141`. This permanently removes the hardcode-drift
   class — the port becomes discovered, not assumed. (No such runtime
   file exists today; `replace-running.ts` is the closest seam.)

5. **Optional resilience: ephemeral fallback.** If the channel default is
   busy and `--replace` is not set, bind `:0` (OS-assigned) and rely on
   the runtime file (#4) for discovery — lets N instances coexist with
   zero config.

6. **Non-negotiable guardrail.** The `dev` channel must **not** write the
   Claude integration files (see the channel-abstraction table): on `4242`
   they would repoint your *real* Claude Code / Desktop at the dev sidecar
   and silently break your stable setup. (Beta is less hazardous here since
   it shares `4141`, but it still defaults to not writing them — opt-in
   only, and to a separate profile if ever.)

> **TL;DR** — the only channel that needs its own port is `dev` (`4242`),
> because it runs *beside* stable; `beta` and `stable` share `4141` and use
> `--replace` to hand off (they never coexist). Define the channel→port map
> **once** so there's no second literal to drift (the `4142` bug), and add a
> runtime port file so everything *discovers* the live port.

### Three tiers of isolation — pick by risk

**Tier 0 — inner loop (seconds).** `bun run app:dev` on the `dev` channel
(port `4242`, `~/.local/share/maximal-dev`). Because it's off stable's
`4141`, it runs **alongside** your installed stable Maximal without
evicting it — edit and iterate while your real proxy keeps serving Claude.

**Tier 1 — separate beta install (minutes).** `bun run app:build:beta`
produces "Maximal Beta" with a distinct bundle id, its own tray, and its
own `~/.local/share/maximal-beta`, so the OS installs it *next to*
production Maximal with isolated tokens/config. It **shares port `4141`**,
so you run beta *or* stable at a time (launching one evicts the other via
`--replace`) — which is fine, since there's no reason to run both at once.
This is the default for "does this build actually work when packaged?"

**Tier 2 — full VM isolation (Windows / installer / risky work).** Use
the existing UTM Windows VM — see [`windows-vm-utm.md`](./windows-vm-utm.md)
and `scripts/dev/utm.sh`. Export-baseline + reimport gives a clean revert,
and nothing the installer does can reach the host's `:4141`. This is the
right tier for MSI / scheduled-task / PATH / uninstall work (cf. issues
#3, #132) where a bad installer could corrupt the host environment.

> Rule of thumb: **anything that runs an installer or writes machine
> state → Tier 2 VM. Anything that just runs the app → Tier 1 beta.
> Anything you're editing right now → Tier 0 dev.**

---

## Containers & VMs via bladerunner (Incus)

[`stuffbucket/bladerunner`](https://github.com/stuffbucket/bladerunner) is
our standalone **Incus VM runner for Apple Silicon** (built on Apple
Virtualization.framework). Inside the guest it runs Incus, which hosts
both **Linux system containers** *and* **full VMs**, with per-disk state
slots, `save`/`restore` snapshots, and AirDrop-able "cartridges". It maps
onto the two halves of Maximal very differently — and the distinction is
the whole point.

### Maximal is two halves; only one containerizes

| Half | What it is | Container fit |
|---|---|---|
| **Proxy / sidecar** | headless Bun HTTP server (`src/`, binds `:4141`) | **Excellent.** A Linux container has its own network + filesystem namespace, so `:4141` *inside* the container is not the host's `:4141`. The collision disappears by construction — no `MAXIMAL_CHANNEL` port-threading needed for headless runs. |
| **Tauri shell** | macOS `.app` / Windows `.msi` GUI (`shell/`) | **None.** You can't run a macOS/Windows GUI in a Linux container. This half needs a **VM** — which bladerunner also provides. |

So "use containers" is really two recommendations: **containers for the
proxy, VMs for the GUI/installer.** bladerunner gives you both from one
tool.

### Containerize the proxy (best isolation for the headless half)

A Linux Incus container running the proxy is the *cleanest* answer to the
`:4141` collision for any headless scenario (CI, integration tests, a
`-beta` proxy smoke):

- **Network isolation is free.** The container owns `4141` in its own
  netns; publish it to any host port, or give the container its own
  bridged IP (bladerunner supports bridged networking when signed with
  `com.apple.vm.networking`). The host's production Maximal never notices.
- **Data isolation is free.** The container's filesystem *is* a separate
  `~/.local/share/maximal`; tokens/config/logs can't bleed into the host.
- **It already half-exists.** `README.md` documents `docker compose up -d
  proxy` + `docker compose run --rm claude`. The same image runs under
  Incus. (Note: the compose file referenced there isn't currently in the
  tree — wiring a canonical `Dockerfile` + compose/Incus profile is the
  concrete first step.)

This slots in as a **Tier 1.5** between dev (Tier 0) and the GUI VM (Tier
2): full isolation for the *server*, faster and lighter than a whole VM,
ideal for CI and headless `-beta` validation.

### Use a bladerunner VM for the GUI/installer tier

For the GUI and especially Windows installer work, a bladerunner-managed
VM can **replace the UTM Tier 2 workflow** — and fix its biggest pain.
[`windows-vm-utm.md`](./windows-vm-utm.md) calls out that UTM 4.7.4 has
**no scriptable snapshot/revert**; bladerunner has scriptable
`save`/`restore` and reproducible per-disk slots, plus **cartridges** — a
single AirDrop-able bootable VM image. That means a *golden QA image*
preloaded with a `-beta` build can be packed once and shipped to any Mac
running bladerunner with `br boot ./maximal-beta.dmg`. bladerunner already
ships a `debian-trixie-gui` disk for Linux-GUI testing.

> **Why not a macOS guest instead of Incus?** It's possible on Apple
> Silicon, but it's a *different VZ path*, not "another image URL."
> bladerunner's VM is wired for Linux: `VZEFIBootLoader` +
> `VZGenericPlatformConfiguration` + cloud-init + a Linux-only `br-agent`
> (`internal/vm/vmconfig_darwin.go`). A macOS guest needs
> `VZMacOSBootLoader` + `VZMacPlatformConfiguration` (hardware model,
> machine id, aux/NVRAM storage) and can't boot a downloadable disk — it
> must be **installed from an Apple IPSW** via `VZMacOSInstaller`
> (multi-GB, ~20–40 min, arm64-only). Worth building as a *macOS-disk
> type* though: it's the macOS analog of the Windows VM — a true
> clean-room (fresh Gatekeeper/quarantine, no prior
> `~/.local/share/maximal`, fresh keychain) for `.dmg` install /
> notarization-staple / first-run testing (#132) that Tier 1 side-by-side
> can't give you because it shares the host OS.

### What it does and doesn't buy the beta channel (Pillar 2)

- **Doesn't change the release/gitops story.** You still ship *signed,
  notarized* `.app` / `.msi` to testers; those bundles can't be built in a
  Linux container, and macOS notarization needs a real Mac.
- **Does help the build/test matrix.** bladerunner on the self-hosted Mac
  can host Linux build/smoke agents and run headless `-beta` proxy
  validation without a cloud runner; cartridges give reproducible,
  shareable QA VMs for internal beta sign-off.

### Honest limits

- **Apple-Silicon-mac-only**, macOS 13+, needs codesign entitlements →
  it's a **developer-machine / self-hosted-runner** tool, not a
  GitHub-hosted-runner primitive. GitHub's ubuntu/windows runners still do
  the public CI; bladerunner is for local + self-hosted iteration.
- **Windows guests:** arm64 is the practical path (matches the UTM doc);
  amd64 under Apple Virtualization is slow emulation.
- **Extra layer** (Mac → VM → Incus → container). For a pure GUI inner
  loop, Tier 0 `app:dev` / Tier 1 side-by-side is still faster.
- **The GUI never containerizes** — don't try to force the shell into a
  container; that's what the VM tier is for.

### Revised tier map

| Tier | Mechanism | Isolates | Best for |
|---|---|---|---|
| 0 | `app:dev` (`dev` channel, `:4242`) | port (distinct, runs beside stable) | inner loop |
| 1 | separate `Maximal Beta` bundle (shares `:4141`) | identity + data (run one at a time) | "does the packaged GUI work?" |
| **1.5** | **proxy in an Incus/Docker container** | **full netns + fs** | **CI, headless integration + `-beta` proxy smoke** |
| 2 | bladerunner VM (replaces UTM) | full machine + snapshots | Windows MSI / installer / uninstall (#3, #132) |

---

## Pillar 2 — The beta release channel (gitops)

Goal: ship `vX.Y.Z-beta.N` builds to opt-in testers as GitHub
**pre-releases**, leaving the production "Latest" release untouched.

> ### Current status (as of v0.4.32)
>
> Part of this pillar is **already wired**:
>
> - ✅ **`release.yml` is prerelease-aware.** Its *Detect pre-release*
>   step flags any tag containing `-` (e.g. `v0.4.33-beta.0`) as a
>   prerelease, and the `publish` job runs `gh release edit --draft=false
>   --prerelease` (never `--latest`). So a `-beta.N` tag already publishes
>   a GitHub pre-release that stays off "Latest".
> - ✅ **`homebrew-tap` is gated to stable** (`if:
>   needs.release.outputs.is_prerelease == 'false'`) — a beta tag will
>   *not* bump the stable `maximal.rb` formula.
> - ✅ **`redeploy-site` runs for betas** so the update manifest's
>   `channels.beta` entry refreshes after a beta publish. The landing page
>   is unaffected because it still tracks `releases/latest` (stable only).
> - ✅ **The updater manifest is channel-aware.** `src/lib/update-check.ts`
>   reads the build channel, and `/updates/manifest.json` now emits
>   `channels.beta` when a GitHub pre-release exists.
>
> What's **still missing** before betas are real:
>
> - ❌ **No auto-cut path.** `release-please-config.json` is still
>   single-branch; betas are deliberately manual for now:
>   `git tag vX.Y.Z-beta.N && git push origin vX.Y.Z-beta.N`.
>   YAGNI: no release-please multi-branch auto-cut until manual tags hurt.
> - ❌ **No identity isolation.** There is no `src/lib/channel.ts`; the
>   bundle id and `~/.local/share/maximal` are shared, so a beta
>   `.app`/`.msi` installs *over* stable and shares its tokens/config. Beta
>   needs a distinct bundle id + data dir (it can keep stable's `4141`
>   port). Separately, the `dev` channel needs its own port (`4242`) so it
>   runs beside stable. This is Phase 1 and the bulk of the work.
>
> **Recommended order:** the homebrew/site gates (done) →
> `MAXIMAL_CHANNEL` identity → release-please multi-branch if manual beta
> tags become painful.

### Branch model — promotion flow

A long-lived `beta` branch sits *downstream* of `main` for promotion,
*upstream* of `main` for beta-only hotfixes:

```
feature/* ──▶ main ───────────────▶ vX.Y.Z            (stable, "Latest")
                 │   ▲
       promote   │   │ forward-merge beta-only fixes
        (merge)  ▼   │
                beta ───────────────▶ vX.Y.Z-beta.N    (pre-release)
                 ▲
       hotfix/*  (urgent beta-tester fixes land here first)
```

- **Normal change:** PR → `main`. Periodically merge `main → beta` to
  cut the next beta from the same code that's heading to stable.
- **Beta-only hotfix:** land on `beta`, ship `-beta.N`, then
  forward-merge `beta → main` so the fix isn't lost on the next promote.
- Keep Conventional-Commit hygiene on **both** branches — release-please
  only reacts to `feat:` / `fix:` (see architecture doc → *Release & PR
  conventions*).

### release-please multi-branch config

Switch `release-please-config.json` to the multi-branch form and add a
beta entry (drop the top-level single-package shape):

```jsonc
{
  "branches": [
    { "branch": "main", "release-type": "node", "changelog-path": "CHANGELOG.md" },
    {
      "branch": "beta",
      "release-type": "node",
      "prerelease": true,
      "prerelease-type": "beta",
      "changelog-path": "CHANGELOG-beta.md"
    }
  ]
}
```

Add a `beta` push trigger to the release-please workflow (or a parallel
`release-please-beta.yml`). Beta tags land as `vX.Y.Z-beta.N` and the
GitHub release is flagged **pre-release**, so it never becomes "Latest".

### Build & distribute the beta bundle

- `release.yml` keys the bundle identity off the tag: a `-beta.` tag
  builds with `MAXIMAL_CHANNEL=beta` (suffixed bundle id + "Maximal
  Beta" + distinct icon), so testers can run **stable and beta together**.
- Mark the GitHub release `prerelease: true`.
- **Distribution:** testers grab the pre-release DMG/MSI from the
  Releases page (documented opt-in). The Pages site keeps fetching
  `releases/latest` (which *ignores* prereleases), so public downloads
  stay on stable. Optionally add a `/beta` download page that queries
  `releases` and picks the newest prerelease.

### Immutability caveat

Pre-releases are still covered by GitHub Immutable Releases (see
[release-runbook](../release-runbook.md) → *Immutable releases*). A bad
beta asset can't be `--clobber`-patched after publish — **bump
`-beta.N`**, don't re-cut the same tag.

---

## Phased rollout (lowest risk first)

| Phase | Scope | Code change? | Unblocks |
|---|---|---|---|
| **0** | Document + adopt: Tier 2 VM for Windows/installer work; `--api-home` + manual `--port` for ad-hoc local runs | none | Immediate safe testing, zero risk |
| **1** | `src/lib/channel.ts` + `MAXIMAL_CHANNEL` threading; `dev` on `:4242` (runs beside stable); beta bundle id + product name + icon + own data dir (shares `:4141`); **`dev` must not write Claude integration config** | yes (local only) | `app:dev` beside stable + separate beta installs |
| **2** | `beta` branch + release-please multi-branch prerelease config + beta-aware `release.yml` | yes (CI) | First `vX.Y.Z-beta.N` to testers |
| **3** | *(optional)* Tauri updater with `channels: [stable, beta]` + per-channel `update.json`; gate on cert/signing (release-runbook → *Open questions* A4) | yes | In-app auto-update per channel |

Phase 0 is pure docs and is safe to adopt today. Phases 1–3 are
independent enough to land as separate PRs.

---

## Resources

- Tauri v2 updater **release channels** + side-by-side installs (unique
  bundle id per channel, per-channel update feed):
  <https://v2.tauri.app/plugin/updater/> ·
  discussions [#7617](https://github.com/tauri-apps/tauri/discussions/7617),
  [#8766](https://github.com/tauri-apps/tauri/discussions/8766)
- release-please **multi-branch / prerelease** config:
  <https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md>
- GitHub **pre-releases** (kept off "Latest"):
  <https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases>
- In-repo: [`windows-vm-utm.md`](./windows-vm-utm.md) (Tier 2),
  [`release-runbook.md`](../release-runbook.md) (immutability, jobs),
  architecture doc → *Tauri shell* (sidecar/port wiring).
- [`stuffbucket/bladerunner`](https://github.com/stuffbucket/bladerunner)
  — Incus VM/container runner on Apple Virtualization (Tier 1.5 + Tier 2).
