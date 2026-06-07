# Research: Desktop Shell Architecture for Maximal (Tauri 2 + Bun Sidecar vs Alternatives)
Started: 2026-05-09T13:06:27-07:00 | Status: complete | Ended: 2026-05-09T14:00:00-07:00

## Problem
Maximal is a Bun + Hono local proxy. The team wants to wrap it in a cross-platform (macOS, Windows, Linux) menubar/tray app with native notifications, signed installers (.dmg drag-to-Applications on macOS, one-click .exe on Windows), and auto-update. The candidate plan is Tauri 2.x as the shell with the Bun compiled binary as a sidecar. Apple Developer ID and Authenticode certs are already in hand. The question is whether that plan holds under scrutiny, and what the top risks are.

## Awesome Lists Checked
- awesome-tauri (github.com/tauri-apps/awesome-tauri) — not fetched directly; covered via official Tauri 2 docs and GitHub issues
- Tauri official docs v2.tauri.app — primary source for sidecar, updater, signing, tray, single-instance, notification plugins

## Searches
- Search 1: "Tauri 2 sidecar external binary Bun Node 2025 2026" | fresh: none | 2026-05-09 | findings: active official docs + community tutorial confirming Bun sidecar pattern works
- Search 2: "bun build compile cross-platform single binary signing notarization 2025" | fresh: py | 2026-05-09 | findings: 8 cross-compile targets supported; code-signing docs exist since Bun v1.2.4; binary size acknowledged as "too big"
- Search 3: "Ollama desktop macOS Windows architecture sidecar tray 2025" | fresh: none | 2026-05-09 | findings: v0.10.0 (July 2025) native GUI; Go server + webview shell; Cocoa/ObjC on macOS, Inno Setup on Windows
- Search 4: "Tauri 2 tray notification single-instance autostart updater plugin Linux GNOME StatusNotifierItem 2025" | fresh: py | 2026-05-09 | findings: all plugins exist; notification broken on Ubuntu 24.04 Wayland
- Search 5: "Electron child process Bun binary sidecar desktop app 2025" | fresh: py | 2026-05-09 | findings: Electrobun emerges as third option; no established Electron+Bun sidecar pattern
- Search 6: "Tauri 2 DMG notarization Windows NSIS MSI signing workflow 2025" | fresh: py | 2026-05-09 | findings: well-documented CI/CD path; EV cert needed for SmartScreen-free Windows
- Search 7: "bun signal handling Windows SIGTERM graceful shutdown daemon service 2025" | fresh: py | 2026-05-09 | findings: SIGTERM issue was old (Bun 0.4.0); Bun does not support Windows named pipes; no native Windows service support
- Search 8: "Hono SSE streaming memory leak cancellation issues 2025" | fresh: pm | 2026-05-09 | findings: two active issues: Bun 1.1.27 fetch streaming regression + CLOSE_WAIT onAbort never fires
- Search 9: "Tauri 2 macOS universal binary codesign notarization sidecar entitlements hardened runtime 2025" | fresh: py | 2026-05-09 | findings: open bug #11992 — sidecar + notarization fails with "invalid signature"
- Search 10: "Electrobun desktop framework Bun webview tray 2025 production apps" | fresh: py | 2026-05-09 | findings: 12-14 MB bundles, Bun runtime, production apps shipping; framework young
- Search 11: "Bun single instance file lock named pipe Windows process guard 2025" | fresh: py | 2026-05-09 | findings: named pipe support unimplemented in Bun on Windows (issue #13042, PR exists)
- Search 12: "Tauri 2 vs Electron real world comparison bundle size memory startup 2025" | fresh: py | 2026-05-09 | findings: Tauri 8.6 MB vs Electron 244 MB; memory 172 MB vs 409 MB at 6 windows; build time 81 s vs 16 s
- Search 13: "Hono Bun performance SSE long-lived connections production benchmark 2025" | fresh: py | 2026-05-09 | findings: Hono+Bun 43% better throughput vs Express+Node in real production; P99 67ms→44ms
- Search 14: "Electron builder forge macOS notarization Authenticode signing 2025 maturity" | fresh: py | 2026-05-09 | findings: very mature; EV cert now mandatory for Windows (since June 2023)
- Search 15: "auto-update homebrew cask installed app conflict skip updater detection pattern 2025" | fresh: py | 2026-05-09 | findings: `auto_updates true` cask flag; no standard detection mechanism; Linux-style "blessed binary" doesn't exist on macOS
- Search 16: "Bun launchd Windows service NSSM integration daemon long-running process 2025" | fresh: py | 2026-05-09 | findings: no native Windows service support in Bun compiled binaries (open issue #25824); NSSM abandoned; WinSW/Shawl as alternatives

## Sources

[1] Tauri v2 — Embedding External Binaries
https://v2.tauri.app/develop/sidecar/ | 2026-05-09 | official docs | high quality
- externalBin array in tauri.conf.json; path relative to src-tauri/
- Binary must be named `{name}-{rustc-target-triple}`
- Shell plugin exposes Rust and JS APIs to spawn and read stdout/stderr
- Arguments must be whitelisted in capabilities JSON (static or regex-validated)
- Shutdown/signal handling NOT documented; no official lifecycle API
- Tauri core does kill child processes on App drop (commit 4bdc406) but zombie children of sidecars are a known gap

[2] Bun — Single-file Executables
https://bun.com/docs/bundler/executables | 2026-05-09 | official docs | high quality
- 8 cross-compile targets: linux-x64/arm64 (+ musl), windows-x64/arm64, darwin-x64/arm64
- Windows icon + metadata flags cannot be used when cross-compiling (Windows API dependency)
- Code-signing: `codesign --deep --force --sign` with JIT entitlements; requires Bun v1.2.4+
- No native FFI section in docs; `.node` native modules require direct require, not pre-gyp
- "Binary is still way too big" — acknowledged upstream; ~60 MB uncompressed

[3] Tauri v2 — Single-Instance Plugin
https://v2.tauri.app/plugin/single-instance/ | 2026-05-09 | official docs | high quality
- Linux: DBus service `org.{id}.SingleInstance`; second instance notifies first then exits
- macOS/Windows: not documented; "supported" label only
- Snap/Flatpak: requires explicit DBus permissions
- No JavaScript API; Rust only

[4] Tauri v2 — Notification Plugin / Ubuntu 24.04 Bug
https://github.com/tauri-apps/tauri/issues/14095 | 2026-05-09 | GitHub issue | medium quality
- Notifications silently succeed but never appear on Ubuntu 24.04 Wayland
- `notify-send` works, ruling out system daemon issue
- Closed as duplicate of plugins-workspace#2566; unresolved as of fetch date
- Workaround: fall back to `notify-send` system command

[5] Tauri v2 — Windows Code Signing
https://v2.tauri.app/distribute/sign/windows/ | 2026-05-09 | official docs | high quality
- EV cert = instant SmartScreen reputation; OV = warning period + manual Microsoft review
- Only OV certs issued before June 1, 2023 have simplified workflow (new OV must be EV-tier for SmartScreen bypass)
- CI: base64 .pfx → import to Windows cert store → tauri build signs automatically
- Requires Windows runner (cross-compile signing not supported)

[6] Tauri macOS sidecar + notarization bug
https://github.com/tauri-apps/tauri/issues/11992 | 2026-05-09 | GitHub bug | medium quality
- Open bug (filed December 2024): "invalid signature" error from Apple notarization when externalBin is present
- Tauri correctly signs both sidecar and main binary but Apple rejects the main binary's signature
- No merged fix; no documented workaround other than removing externalBin
- Note: "needs triage" label; may be environment-specific

[7] Tauri 2 macOS signing walkthrough
https://dev.to/0xmassi/shipping-a-production-macos-app-with-tauri-20-code-signing-notarization-and-homebrew-mc3 | 2026-05-09 | engineering blog | medium quality
- Required entitlements: allow-jit, allow-unsigned-executable-memory, allow-dyld-environment-variables
- Tauri does NOT build universal (fat) binaries for sidecars; developer must supply both arch variants
- Homebrew tap distribution works; `auto_updates true` is the cask convention
- Notarization: 2–20 min via tauri-action; apple-action staples ticket to DMG

[8] Tauri v2 — Updater Plugin
https://v2.tauri.app/plugin/updater/ | 2026-05-09 | official docs | high quality
- Signature mandatory; uses Ed25519 (not minisign — earlier docs said minisign; current docs say Ed25519 via `tauri signer`)
- Private key loss = cannot push updates to existing installs
- Windows: app forcibly exits during MSI/NSIS install; on_before_exit hook for cleanup
- Linux: AppImage + .sig; no .deb/.rpm update path
- No homebrew conflict handling documented; standard pattern is `auto_updates true` in cask

[9] Ollama desktop architecture
https://deepwiki.com/ollama/ollama/8.4-desktop-application-development | 2026-05-09 | community docs | medium quality
- macOS: Cocoa/ObjC shell (`app_darwin.m`) + React/Vite webview; Go server as integrated component
- Windows: Inno Setup installer; existing-instance detection built in
- UI server reverse-proxies to Ollama API; TypeScript types generated from Go structs via tscriptify
- v0.10.0 (July 2025): first native GUI release; previously terminal-only

[10] Bun + Tauri sidecar tutorial (community)
https://codeforreal.com/blogs/using-bun-or-deno-as-a-web-server-in-tauri/ | 2026-05-09 | engineering blog | medium quality
- Bun single-file executable ~60 MB; compressed Tauri macOS app ~29 MB
- Dynamic port: Rust picks free port, passes via env var to Bun
- Token auth pattern for IPC security between Rust and Bun
- v2 approach: kkrpc over stdin/stdout for bidirectional typed RPC
- "Tauri requires its own HTTP client library" — annoying for webview-to-sidecar fetches without capability workarounds

[11] Tauri sidecar zombie process / lifecycle gap
https://github.com/tauri-apps/plugins-workspace/issues/3062 | 2026-05-09 | GitHub issue | medium quality
- Open feature request (Oct 2025): tauri-plugin-sidecar-lifecycle proposal
- Problems currently requiring manual Rust code: crash detection, auto-restart, backoff, health checks, graceful shutdown, cross-platform signal differences
- Not yet implemented; unassigned

[12] Hono SSE CLOSE_WAIT memory leak
https://github.com/anomalyco/opencode/issues/22198 | 2026-05-09 | GitHub issue | high quality
- TCP CLOSE_WAIT → stream.onAbort() never fires → heartbeat timers + Bus subscriptions + AsyncQueue never cleaned
- 14.5 MB/sec growth with 66+ zombie connections
- Reported April 2026; PR #22552 associated; fix not confirmed merged
- Bun 1.1.27+ also has separate fetch streaming regression (issue #18488; open)

[13] Tauri vs Electron — real-world comparison (Hopp)
https://www.gethopp.app/blog/tauri-vs-electron | 2026-05-09 | engineering blog | high quality
- Tauri: 8.6 MB bundle / ~172 MB RAM (6 windows) / Rust build 81 s cold
- Electron: 244 MB bundle / ~409 MB RAM (6 windows) / 16 s build
- Cross-platform webview parity: "browser-specific quirks can appear" on different OS WebViews
- macOS universal binary: Tauri confirmed broken for multi-arch codesigning in Nov 2025 writeup
- Startup difference described as "negligible" in subjective perception

[14] DoltHub — Electron vs Tauri (Nov 2025)
https://www.dolthub.com/blog/2025-11-13-electron-vs-tauri/ | 2026-05-09 | engineering blog | high quality
- Staying with Electron due to Windows .appx/.msix limitations and macOS universal binary codesigning issues in Tauri
- Tauri JS APIs "more natural" than Electron IPC for simple cases
- Tauri viewed positively; team plans to revisit

[15] Bun named pipe Windows gap
https://github.com/oven-sh/bun/issues/13042 | 2026-05-09 | GitHub issue | high quality
- Named pipes throw ENOENT on Windows in Bun; PR #13838 open
- Single-instance on Windows in Bun requires workaround (TCP port probe, mutex via FFI, or Rust-side detection)

[16] Bun Windows service gap
https://github.com/oven-sh/bun/issues/25824 | search result | medium quality
- Open issue: compiled Bun executables cannot be registered as Windows SCM services natively
- NSSM abandoned (2017); WinSW (2023) and Shawl (Rust, 2025) are viable wrappers

[17] Homebrew auto-update cask pattern
https://github.com/orgs/Homebrew/discussions/4849 | 2026-05-09 | GitHub discussion | medium quality
- `auto_updates true` in cask definition tells brew upgrade to skip version check
- No detection mechanism for apps to know they were brew-installed
- Linux-style vendor-blessed package manager channel (disabling in-app updates) does not exist on macOS
- Pattern used by mature apps (Chrome, Firefox): ship same binary everywhere; accept dual-update scenario

## Approaches

### Approach A: Tauri 2.x shell + Bun sidecar (the current plan)

**Pros:**
- ~8-10 MB installer vs ~250+ MB for Electron (source [13])
- ~30-40 MB idle memory vs 200-400 MB for Electron (source [13])
- All five required plugins exist: tray-icon, notification, single-instance, autostart, updater (source [3][8])
- Official sidecar/externalBin API exactly matches the "bundle Bun binary" use case (source [1])
- Tauri CI/CD for macOS DMG notarization + Windows NSIS/MSI signing is well-documented with GitHub Actions (source [5][7])
- Community precedent exists: codeforreal tutorial + tauri-bun GitHub repo (source [10])
- Rust shell owns process lifecycle; Bun proxy keeps doing exactly what it does today

**Cons:**
- Open bug #11992: sidecar + macOS notarization fails with "invalid signature" (source [6]) — this is the single biggest blocker risk
- Sidecar lifecycle not fully managed by Tauri core: crash detection, auto-restart, graceful shutdown all require custom Rust code (source [11])
- Windows sidecar shutdown relies on Tauri's App drop killing child; nested children (Bun spawning sub-processes) can zombie (source [11])
- Linux notifications broken on Ubuntu 24.04 Wayland (source [4])
- Tauri does NOT build universal binaries for sidecars; CI must cross-compile two Bun binaries (darwin-x64, darwin-arm64) and place them correctly (source [7])
- Rust compile time ~81 s cold adds CI overhead (source [13])
- Cross-platform WebView parity issues (WebKitGTK on Linux is worst) mean the settings UI must be carefully tested across three engines

**Complexity:** High — Rust + Bun + TypeScript + three platform targets + signing pipelines

**Best scenario:** Team wants minimal install footprint, has Rust capacity, and is willing to prototype the notarization path first.

---

### Approach B: Electron shell + Bun child process

**Pros:**
- Electron's macOS notarization + Windows Authenticode signing pipeline is a decade old and genuinely "boring" (source [14])
- Child processes in Electron work exactly as in Node.js: `child_process.spawn()` of the Bun binary — no exotic API
- electron-builder and electron-forge handle signing, notarization, NSIS, DMG, auto-update (Squirrel/NSIS) without a custom Rust layer
- DoltHub explicitly chose Electron over Tauri for signing reliability (source [14])
- No WebView parity issues: Chromium is identical on all platforms

**Cons:**
- 100-250 MB installer; 200-400 MB RAM at runtime (source [13])
- Shipping Bun binary + Chromium = the worst of both sizes
- No official or precedent for Electron + Bun sidecar (the pattern exists conceptually; no community reference found)
- `child_process.spawn` lifecycle management is manual — same problem as Tauri but in JavaScript
- SmartScreen still requires EV cert for OV-signed .exe (source [5], same rule applies to electron-builder)

**Complexity:** Medium — mature toolchain, familiar JS ecosystem, but large artifact

**Best scenario:** Team has zero Rust capacity, values signing reliability above all, and can accept the payload size.

---

### Approach C: Electrobun shell + Bun process (emerging option)

**Pros:**
- Pure TypeScript/Bun runtime throughout; no Rust layer to learn
- 12-14 MB bundle; Bun as main process runtime (source [10 via search])
- Differential updates as small as 14 KB via bsdiff on S3 (source [search])
- Native tray, context menu, and app menu APIs exist (source [search])
- System WebView like Tauri (WebKit/WebView2/WebKitGTK); avoids Chromium cost

**Cons:**
- Framework very young; documentation and ecosystem still developing (source [search])
- Production readiness unproven at scale; community small
- No well-documented signing pipeline for 3-platform production distribution
- macOS-only support documented today; Windows/Linux maturity unclear
- Zero precedent for the exact maximal use case

**Complexity:** Low in principle; High in practice due to immaturity

**Best scenario:** Greenfield project, team is TypeScript-native, timeline allows framework risk.

---

## Recommendation

**Proceed with Tauri 2 + Bun sidecar, but treat the macOS notarization bug as a go/no-go gate for phase 7.a.**

The plan is architecturally sound and has the best long-term properties for this use case (small footprint, native feel, signed installers). The three things that could derail it are concrete and prototypable early:

1. **Notarization bug (issue #11992)**: This is the hardest unknown. Before writing any Tauri UI code, build the minimum sidecar app (Tauri shell + Bun --compile binary in externalBin) and run `tauri build --target universal-apple-darwin` through the full notarization pipeline. If Apple still rejects it, the workaround is to sign the sidecar binary manually with `codesign` before `tauri build`, or to file a separate notarization of the sidecar binary pre-bundle. This is resolvable but must be confirmed working before committing to the plan.

2. **Linux notification on Wayland (issue #14095)**: For a local proxy tray app, notifications are informational not critical. Acceptable mitigation: detect Wayland and fall back to `notify-send` shell command. Don't block the plan on this.

3. **Sidecar lifecycle management**: Tauri kills the sidecar process on App drop, but crash detection and auto-restart require ~50 lines of Rust in the setup hook. This is standard Rust, not exotic. The SSE CLOSE_WAIT memory leak in Hono+Bun (issue #22198) is a separate problem — mitigate with an idle connection timeout in the Hono layer, not in the Tauri layer.

**Do not switch to Electron** unless the notarization bug is unresolvable. The size and memory cost of shipping Chromium alongside Bun is hard to justify for a tray app that serves localhost API traffic. The signing pipeline is marginally smoother in Electron but not enough to overcome a 30x bundle size difference for a dev-tool product where users care about resource consumption.

**Do not adopt Electrobun yet.** Its size and TypeScript-native story are attractive, but the production signing pipeline is undocumented and the framework is too young for a commitment of this scope.

---

## Implementation

### Phase 7.a (prototype, go/no-go gate)
1. Create minimal Tauri 2 shell: tray icon, single notification, spawn Bun sidecar
2. Use `bun build --compile --target bun-darwin-arm64` and `bun-darwin-x64` in CI; place both in `src-tauri/binaries/` with correct target-triple suffixes
3. Run full notarization pipeline on macOS (GitHub Actions runner + Apple credentials)
4. Confirm or deny bug #11992 is present for this project's binary; document the workaround if needed
5. Test Windows NSIS build with EV cert signing
6. Test Linux AppImage; confirm notification on Ubuntu 24.04 Wayland; add notify-send fallback

### Phase 7.b+ (if 7.a passes)
- Implement sidecar lifecycle in `src-tauri/src/main.rs`: spawn on setup, watch CommandEvent::Terminated, restart with exponential backoff
- Implement dynamic port allocation (random TCP port → env var to Bun)
- Add in-app updater with Ed25519 key pair; set `auto_updates true` in Homebrew cask
- For single-instance: Tauri's plugin handles macOS/Linux; Windows needs additional mutex or TCP probe in Rust

### Hono/SSE mitigation (regardless of shell choice)
- Add an idle timeout on SSE connections in the Hono layer (server-side heartbeat with a write-failure detector)
- Pin Bun version in Dockerfile/CI until fetch streaming regression (#18488) is confirmed fixed

---

## Risks

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Tauri sidecar notarization bug #11992 blocks macOS release | High | Medium | Pre-sign sidecar binary before tauri build; prototype in 7.a |
| Bun SSE CLOSE_WAIT memory leak grows unbounded under load | High | Medium | Add idle timeout + write-failure detection in Hono streamSSE handlers |
| Linux notifications silently fail on Ubuntu 24.04 Wayland | Medium | High | notify-send shell fallback; not a blocking issue for a dev tool |
| Windows sidecar cleanup leaves zombie Bun process after app exit | Medium | Medium | Store CommandChild in Arc<Mutex<...>>; call child.kill() in on_close_requested hook |
| Tauri WebKitGTK on Linux renders settings UI incorrectly | Low | Medium | Target WebKit-safe CSS; test on Ubuntu 22.04 + 24.04 in CI |
| Homebrew cask + in-app updater dual-update confusion | Low | Low | Ship with `auto_updates true` in cask; document that brew manages updates for brew-installed users |
| Bun binary size (~60 MB uncompressed) surprises users | Low | Low | DMG includes compressed content; installed footprint acceptable; document expected size |

---

METRICS: searches=16 fetches=15 high_quality=7 ratio=0.94
CHECKS: [x] freshness [x] went_deep [x] found_outlier [x] checked_awesome

## Feedback
usefulness: | implemented: | result: | notes:
