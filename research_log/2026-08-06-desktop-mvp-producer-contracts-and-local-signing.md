# Desktop MVP: producer contracts, local signing, and release mechanics

Spike output: a working session across `stuffbucket/maximal` (the `client/`
Electron app), sibling `stuffbucket/maximal-core`, and `stuffbucket/maximal-electron`,
driven by a recurring "check for producer updates, work toward a complete MVP" loop.
The loop itself found little — producers were static for five consecutive passes —
so most of the value came from turning the idle passes onto our own tree and then
onto the build pipeline.

Method: read-only inspection of the three repos plus the private
`stuffbucket/macos-builder`; measurement rather than inference wherever a claim was
checkable; one real end-to-end signed build executed locally. Every finding below
was verified against an artifact, an API response, or committed source. Three of my
own earlier conclusions were wrong and are corrected inline rather than quietly
dropped — they are marked **CORRECTION**.

Blow-by-blow chronology lives in
`.superpowers/sdd/2026-08-06-usable-desktop-mvp/progress.md`.

---

## Executive summary

- **The macOS signed build does not need a GitHub runner.** Proven, not argued: a
  signed 169 MB `Maximal.dmg` was produced end to end on a developer Mac. The
  producer script was already runner-agnostic; nobody had noticed.
- **Task 20's real gate is now closed.** The signed Bun/JavaScriptCore sidecar was
  executed from a relocated bundle outside the repository and returned cleanly.
  Everything that existed before was *static* signature verification, which proves
  nothing about whether the thing runs.
- **The client is further from the plan than the plan assumes.** It pins an Electron
  shell 69 commits behind the release it is documented as using — predating the
  `runMain` seam two tasks depend on — has zero CI coverage, and its preload
  implements the *opposite* of the required security boundary, per a standing ADR.
- **Release mechanics moved a lot, and broke in an instructive way.** A two-phase
  release flow landed, immediately followed by a defect where the tag gate never
  checked that the tagged commit was the release commit. A publish was cancelled
  mid-flight and left a tag stranded — then recovered by re-dispatch, without
  burning the version.
- **`rcodesign` cannot fully containerize this.** It replaces `codesign` and
  `notarytool` on Linux, but cannot build a DMG by explicit design. Recommendation
  is to keep it off the MVP critical path.

---

## 1. Local signing: the runner was never required

### 1.1 What was already true

`.macos-builder/build.sh` has **no GitHub Actions dependency**. Its entire declared
interface is six environment variables — `TAG`, `ARCH`, `SIGN_IDENTITY`,
`ENTITLEMENTS_DIR`, `BUN_INSTALL`, `CARGO_HOME` — plus an already-unlocked keychain.
Its only GitHub-isms are `::error::` / `::group::` annotations, which degrade to
harmless plain text. The builder's tail, `lib/package-macos.sh`, is likewise entirely
stock macOS tooling: `codesign`, `hdiutil`, `notarytool`, `stapler`, `shasum`.

The self-hosted runner is a convenience wrapper around tools every developer Mac has.

### 1.2 What the host supplies

| Need | Found |
| --- | --- |
| Developer ID Application cert | `Brian Scott Stucker (N298D99R2X)`, valid in login keychain |
| Bun | `1.3.11` at `~/.bun/bin` — exactly the `.bun-version` pin |
| Node / npm | v26.0.0 / 11.12.1 |
| Architecture | arm64, the only supported target |
| `codesign`, `hdiutil`, `shasum` | base macOS |
| `notarytool`, `stapler` | Command Line Tools — **full Xcode not required** |

### 1.3 Why the builder's tail could not be reused

`lib/package-macos.sh` hard-requires `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID`
at lines 140–142 via `${VAR:?}` and exits before doing anything. Those exist only as
**write-only GitHub secrets** in `stuffbucket/macos-builder` (confirmed present, set
2026-06-09; values unreadable by anyone, including their owner). So the local script
reimplements step 2 — top-level sign, no `--deep` — and the dmg/checksum tail with the
identical `codesign` incantation, and skips notarize + staple.

`build-local-dmg.sh` in the SDD workspace is that script.

### 1.4 Result, and the evidence

- inside-out `@electron/osx-sign` pass signed the sidecar, four Helper apps,
  Squirrel / ReactiveObjC / Mantle / Electron frameworks, `chrome_crashpad_handler`
- bundle reports `Identifier=co.stuffbucket.maximal`, `flags=0x10000(runtime)`,
  `Authority=Developer ID Application: Brian Scott Stucker (N298D99R2X)`,
  `TeamIdentifier=N298D99R2X`
- top-level sign without `--deep` re-sealed the outer bundle; `--verify --strict` passed
- signed, verified DMG + `.sha256` produced (169 MB)
- bundled sidecar carries exactly `allow-jit`, `allow-unsigned-executable-memory`,
  `disable-library-validation`, `network.client`, `network.server`

**The gate that was actually missing.** The app was copied to `/tmp/maximal-relocated`
— outside the repository and dependency tree, per the isolated-package requirement
inherited from maximal-electron — `codesign --verify --deep --strict` passed there, and:

```
$ /tmp/maximal-relocated/Maximal.app/Contents/Resources/bin/maximal-core --version
0.2.0
exit=0
```

That is the direct proof: the Bun/JavaScriptCore sidecar loads and runs under hardened
runtime with library validation disabled, from a relocated signed bundle. Notarization
does not affect this — it adds a ticket and alters neither signature nor entitlements —
so the finding carries to the notarized artifact.

The printed `0.2.0` is itself a finding: the build consumed the stale
`github:stuffbucket/maximal-core#v0.2.0` pin.

### 1.5 Operational note

`build.sh` stamps the tag version into `client/package.json` **in place**. The local
wrapper backs it up and restores it via an EXIT trap, so the tracked file survives any
outcome. Verified clean afterwards.

### 1.6 Unnotarized artifacts: what actually happens

Host is macOS 26.5. **Quarantine, not signing, is what triggers Gatekeeper.**

- Locally built app, never through a browser → no quarantine xattr → launches silently.
  This is why local verification needs no notarization.
- Distributed unnotarized DMG → since Sequoia the Control-click bypass is **gone**. A
  quarantined unnotarized app shows *"Apple could not verify … free of malware"* with
  only **Move to Trash** and **Cancel**. Recovery is System Settings → Privacy &
  Security → Open Anyway → re-authenticate → relaunch.

So notarization plus stapling are mandatory for distribution — without the staple,
first launch needs network to reach Apple — but are **not** prerequisites for the
Task 20 runtime proof.

---

## 2. Client state versus plan assumptions

### 2.1 CORRECTION — the Electron pin is not v0.0.4

I had recorded that the client "continues pinning the immutable v0.0.4 release
tarball." That was the intended strategy, not the state. `client/package.json` pins
`github:stuffbucket/maximal-electron#fe3ca59…` — a raw commit SHA. Content-immutable,
so not the mutable-branch hazard, but **69 commits behind** the v0.0.4 release commit.
Verified: the v0.0.4 annotated tag `d597b0c` resolves to commit `3068cf9`, and
`fe3ca59…3068cf9` is ahead 69 / behind 0 — a clean ancestor, so moving up is a pure
fast-forward.

**Tasks 12 and 14 cannot be built against this pin**, because what they are specified
against does not exist in it. Landing in those 69 commits: `runMain(runtime, options)`,
the versioned main-process seam (#95) that the whole `RunMainOptions` /
`collectCrashDumps` line of work rests on; the terminal session manager (#75) and
detachable sessions (#115); "declare no runtime dependencies, so a consumer installs
what it imports" (#107); the git-ref install resolution check (#96); "refuse an install
that carries no build" (#111); packaging guards (#105, #88); and "launch the packaged
application and make it open a shell" (#108), the upstream ancestor of our exact-package
gates.

The pinned commit predates `runMain` entirely.

### 2.2 The bump is source-compatible but install-shape-changing

Source side is clean. The client's whole use of the shell is one import in
`client/src/main/shell.ts`: `createHostWindow` and `HostWindowOptions` from
`stuffbucket-electron/host`. Nothing else in `client/src` touches the package. At
v0.0.4 both symbols still exist and `host-window.ts` imports nothing but `electron`.

Install side needs care. Per #107, v0.0.4 declares **no** runtime dependencies and moves
everything to peers: `electron`, `react`, `react-dom`, `node-pty`, `ghostty-web`,
`lucide-react`, `react-resizable-panels`, four `@radix-ui/*`. Our React 19.2.8 and
Electron 43 satisfy the ranges. The hazard is npm 7+ auto-installing peers, dragging in
`node-pty` and `ghostty-web` — native and heavy — when the one export we import needs
only `electron`. Those peers serve `./renderer` and `./host/terminal`, which we do not
import. `node-pty` is also the module behind the macOS teardown flake observed upstream,
and it materially complicates the packaged native-load gate.

### 2.3 Task 14 reverses a standing ADR

`client/src/preload/index.ts` exposes `getCoreOrigin()`, `getProxyUrl()`,
`openExternal()`. Its header states the intent: *"The bridge exposes ONLY native powers
+ the core control-plane origin. It is NOT a proxy to core: the renderer talks to core's
control plane directly over HTTP + SSE using the injected origin (ADR-0023)."*

That is exactly what the MVP requirement forbids — main owns the private control origin,
renderer never receives it, no `core:origin`. **Removing it contradicts a decision record
and requires superseding ADR-0023**, not a silent deletion. Flagged for adjudication
before Task 14 is dispatched. The rest of the preload is already sound: `contextBridge`,
no raw `ipcRenderer`, no generic `core:call`.

### 2.4 Why the old design was defensible, and when it stops being

`client/src/main/core.ts` sets `proxyBase = controlBase` with an explicit comment: v0.2.0
exposes one listener, so this is a packaging PoC; the product contract is two interfaces.
With a single listener there is no private origin to leak — the control origin *is* the
public one. The moment the client consumes a core exposing two listeners, that stops
being true and the exposure becomes a real leak.

**This is the causal link between Task 3 and Task 14**: the version bump is what makes
the closed bridge both necessary and possible. They cannot be scheduled independently.

### 2.5 The bump's breaking point, precisely

Core's `dist/lib/supervisor.d.ts` defines `readyLineSchema` as
`{v, controlPort, proxyPort, pid}` and `anyReadyLineSchema` as a union that *also*
accepts legacy `{port, pid}`, transforming it to `{v: 0, controlPort, proxyPort, pid}`.
The parser is backward compatible, but the normalized output has **no `port` field**.
`core.ts` reads `ready.port` in two places, so it breaks loudly on the bump — the good
failure mode. The fix is mechanical and retires the temporary hack simultaneously:
control and proxy bases each take their own port.

### 2.6 Task 18's mechanism already exists upstream

The same supervisor contract documents `BOOT_STATUS_MARKER` — *"boot-phase lines relayed
to the splash as live status (so a slow/failed start isn't a blank 'Starting…')"* —
alongside `QUIT_REQUEST_MARKER` and `UPDATE_REQUEST_MARKER`, all gated on the parent-pid
env so CLI users never see them. Task 18 should **consume** this rather than synthesize
status in Electron. `core.ts` currently only console-logs sidecar stdout.

### 2.7 Task 13 and 19 start from zero

`.github/workflows/ci.yml` defines exactly one job, `test`, and does not touch `client/`
— the only occurrence of the string is a comment noting the client is *excluded* from
the root tsconfig. `client/package.json` declares four scripts: `build:core`,
`typecheck`, `start`, `package`. No test script, no runner, no lint, despite the stack
listing Vitest.

Task 19 is titled "restore real-app E2E." There is nothing to restore; it is a first
build. The title is misleading.

### 2.8 Task 3 is a one-line change

`client/package.json` pins `github:stuffbucket/maximal-core#v0.2.0` — a git ref, not the
scoped registry package. So the untested GitHub Packages publication is **not** a
prerequisite for Task 3; bumping the ref suffices. Only `darwin-arm64` appears anywhere
in the path, consistent with Intel macOS and Linux failing explicitly.

---

## 3. Release mechanics

### 3.1 Two-phase release landed, with a hole

Core PR #83 introduced a two-phase flow: `release:prepare` opens a PR titled exactly
`chore: release vX.Y.Z`, and after it merges `release:tag` tags the squash-produced SHA.
The design rationale is sound — nothing reaches `main` outside a PR, and squash merges
rewrite the SHA, so the tag must come after.

Then PR #87 found that `release:tag` **never asserted the tip was the release commit** —
only that the manifest read X.Y.Z, which an ordinary PR does not change. Anything merged
in the review-to-tag window was captured by the tag and absent from the changelog.
Rehearsed on a scratch origin: current `main` tags the unrelated commit; the fix refuses
at exit 1.

maximal-electron #159 is the **identical defect**, filed independently three minutes
apart. Cross-repo corroboration that this is a class of bug in the shared design.

### 3.2 Decoupling tag from publish: validated in production, twice

The argument put to both producers was that a tag push is a one-shot fuse — immutable,
unrepeatable, and if what it ignites doesn't run, the version is spent. This repo's own
history proves the premise: the runbook records that **v0.4.2 shipped with no binaries**
because a leg died on tag push, and *"the tag could not be given assets afterwards."*

Then it happened live. A `workflow_dispatch` of `publish-package.yml` against ref
`v0.4.4` was **cancelled**, leaving `v0.4.4` tagged with no release and no package, with
nothing retrying. Because publishing was dispatched against a *tag ref* rather than fired
by the tag push, the version was **not burned** — a later re-dispatch against the same tag
succeeded, and `@stuffbucket/maximal-core@0.4.4` published at 19:33Z. The same pattern
then repeated benignly for `maximal-electron` v0.0.5.

Three caveats belong with the design:

1. **The retry window is the draft window**, not the tag's lifetime. Immutable releases
   reject assets with HTTP 422 after publish, which is why `release.yml` gates `publish`
   on `macos-dmg`. Dispatch-retry cannot repair an already-published release.
2. **Registry burn is not undone by retry, and "retry until it succeeds" is not
   literally true.** Core's own `publish-package.yml` states a publish *"cannot be
   taken back — a version is burned even if it is unpublished."* Observed directly:
   a re-dispatch against `v0.4.4` at 2026-08-07T00:05Z — after the successful
   publish — failed with

   ```
   409 Conflict: https://npm.pkg.github.com/@stuffbucket%2fmaximal-core
    - Cannot publish over existing version
   ```

   So the operation is **at-most-once with retry-on-failure**, not idempotent. The
   distinction is operational, not pedantic: automation that "retries until success"
   begins hard-failing the moment it succeeds, and any monitor watching publish
   outcomes fires a false alarm on every re-run. Making it genuinely idempotent
   needs a precondition check — query the registry, exit 0 if the version is already
   there. **That pattern is already proven in this family**: `release.yml`'s
   `macos-dmg` job opens with `if has "$DST"; then echo "already on the draft —
   nothing to do."; exit 0; fi`, precisely so a re-run after a partial failure costs
   nothing. The publish path wants the same guard.
3. **Decoupling creates a new invisible state: tagged but never published.** Observed
   for real within the hour. It needs an explicit detector or you trade an anxious ten
   minutes for a silent gap.

#87/#159 and the decoupling are complementary: once publishing is a dispatch against a
tag ref, the dispatch *trusts* the tag, making "what does the tag point at" more
load-bearing, not less.

### 3.3 The signed-artifact path and its ordering constraint

`macos-build.yml` has two runs, last on 2026-06-09 — which looks like a dead trigger but
is `workflow_dispatch`-only **by design**: with immutable releases on, attaching an asset
after publish is rejected with 422, so an `on: release published` trigger would always
fail. The real path is the `macos-dmg` **job inside `release.yml`**, which attaches the
signed, notarized DMG while the release is still a draft, with `publish` gating on it via
`needs:`. Fail-closed: if notarization fails or times out, the release stays a draft.

### 3.4 CORRECTION — the registry namespace

I reported that nothing had ever been published and that a 404 from
`/orgs/stuffbucket/packages/...` was authoritative because the token carried
`write:packages`. **That was wrong.** `stuffbucket` is a **user account, not an
organization**, so every `/orgs/` call 404s regardless of what exists. The inference from
token scope was not evidence.

Correct endpoints: `/users/stuffbucket/packages/npm/<pkg>/versions`, and the registry
itself at `https://npm.pkg.github.com/@stuffbucket%2f<pkg>`.

The consequence was worse than a wrong status line: a monitor built on the org endpoint
**could never have fired on a publish** — the exact false-negative it existed to prevent.
Rebuilt to query the `/users/` namespace *and* independently cross-check the registry, so
a namespace mistake cannot again read as "nothing yet." It then correctly caught
`maximal-electron@0.0.5`.

### 3.5 CORRECTION — two monitor defects worth recording as patterns

- `gh api` writes its JSON **error body to stdout** and exits non-zero. Reading it
  without checking exit status turns "not found" into a fake version string. Guard every
  call on exit status.
- A shell `case " $list " in *" $item "*)` glob matches **space**-delimited items, but
  `gh api --jq '.[].name'` emits **newline**-delimited output. The mismatch flagged
  almost every tag as stranded. Exact-line `grep -Fxq` is the fix. Pulled into a
  separately runnable script and verified against known-good state before trusting it.

### 3.6 triage.yml has never succeeded, in two repos

maximal-electron #153 reports `triage.yml` at 75 runs, 75 failures. Independently
measured in `stuffbucket/maximal`: 41 runs, all sampled are failures, most recent that
day, **every failed run has zero jobs** — the `startup_failure` signature.

Root cause diagnosed here and *not* named in the upstream issue: it is not a bad pin.
`triage-reusable.yml` does exist at repoman's `v1` tag. The cause is **visibility** —
`stuffbucket/maximal` is public and `stuffbucket/repoman` is private, and a public caller
cannot resolve a reusable workflow in a private repo, so the run dies before any job is
created. The stub's header says it mirrors the shape other repoman-managed repos ship;
that shape presumably works there because those callers are private.

Effect: `needs-triage` has never been applied by the event path in this repository. Only
repoman's ~5-minute poll backstop has been doing it — which is also what kept the
breakage invisible.

---

## 4. rcodesign evaluation

Full spike: `.superpowers/sdd/2026-08-06-usable-desktop-mvp/spike-rcodesign.md`.

**Verdict: signing and notarization containerize cleanly; DMG creation does not, by
explicit design.** That single gap decides the architecture.

### 4.1 Credentials are a different shape

`rcodesign` accepts neither a keychain identity nor the Apple-ID pair we use today.

- **Signing**: `.p12` + password file, PEM key+cert, smart card, or **remote signing**
  where the key never reaches the builder. Upstream recommends remote signing for CI
  precisely because *"if GitHub gets hacked, nobody has an offline copy of your signing
  certificate."*
- **Notarization**: App Store Connect API key — Issuer ID (UUID), Key ID, and a `.p8`
  ECDSA private key **downloadable at most once**. Role `Developer` suffices.
  Consolidate with `rcodesign encode-app-store-connect-api-key -o key.json <issuer>
  <keyid> AuthKey.p8`.

This is a *new* credential, not a reuse of the builder's secrets — arguably an
improvement, since API keys are independently scopeable and revocable and minting one
does not disturb the existing runner path.

### 4.2 One real advantage, one real trap

**Advantage:** it *"recursively signs entities by default"* — one invocation handles
nested bundles, frameworks and Mach-O binaries where Apple's `codesign` *"requires N
invocations with N different settings configurations."* That is precisely what
`@electron/osx-sign` orchestrates for our four Helpers, frameworks and sidecar.

**Trap:** `--code-signature-flags runtime` applies to the **primary entity only**.
Nested binaries need path-scoped syntax (`Contents/MacOS/binary:runtime`), and upstream
recommends **configuration files** for complex bundles. Our sidecar's entitlements must
land on exactly the right nested path; getting it wrong is silent until notarization
rejects it — or until the sidecar cannot JIT on a user's machine.

### 4.3 The wall

Upstream, verbatim: *"we can't recursively inspect the files within DMGs and sign
those"* — a DMG holds a nested HFS+ filesystem with no cross-platform read/write
(tracking issue #2). It also **deliberately refuses to shell out to `hdiutil`**. The
documented workaround is the ordering we already use — sign contents, build DMG, sign
DMG — but "build DMG" is `hdiutil`, macOS-only. Flat `.pkg` has the analogous limit,
blocked on Apple's Bill of Materials format (#3).

**Unverified inference, flagged as such:** stapling a DMG writes a ticket *inside* the
image, which is the exact operation upstream says it cannot do cross-platform. Upstream
does not state this explicitly. Test before depending on it.

Linux DMG builders exist — `planetbeing/libdmg-hfsplus` (effectively unmaintained),
`fanquake/libdmg` (Rust port, used in Bitcoin Core's deterministic builds, a real
production reference) — but the Linux kernel is deprecating HFS/HFS+ support, so this
area is getting *less* healthy over time. `electron-builder` cannot produce DMGs on
Linux at all.

### 4.4 Recommendation

**Keep rcodesign off the MVP critical path.** The local macOS build already removes the
GitHub-runner dependency — the actual goal — using the signing path the producer has
always used. rcodesign's prize is removing the *macOS* dependency, which the DMG gap
prevents it from fully delivering, so adopting it now trades a proven pipeline for a
partial one. Upstream itself advises proving your software notarizes with Apple's
tooling first so later failures are attributable; we are now in exactly that position.

Bounded experiment, in order: mint the API key (useful regardless, and the long pole);
`cargo install apple-codesign` and sign a **copy** of the existing `.app`, diffing
`codesign -dvv` and `--verify --deep --strict` against the known-good bundle; container
only after that.

Also note: containerizing means packaging **unsigned** via electron-forge and signing
afterwards, because `@electron/osx-sign` is macOS-only. The inside-out signing guarantee
would move from a proven path to a new one.

---

## 5. Open decisions

1. **ADR-0023 versus Task 14.** Which governs? Task 14 cannot proceed without this.
2. **Electron bump to v0.0.4** — independently actionable, blocks Task 12, needs peer
   installation constrained to what we import.
3. **Core v0.5.0 prerequisites** — #52 (sole open item in the cut milestone) and #87
   (mis-tagging fix); v0.4.4 shipped without #87, so the next cut is exposed to the same
   window it closes.
4. **Client CI from zero** — Tasks 13 and 19.
5. **Notarization credentials** — the builder's secrets are unreadable; local
   notarization needs a fresh app-specific password, or an App Store Connect API key if
   moving toward rcodesign.

---

## Appendix: sources

- [Apple Codesign docs — Getting Started](https://gregoryszorc.com/docs/apple-codesign/stable/apple_codesign_getting_started.html)
- [Signing with `rcodesign sign`](https://gregoryszorc.com/docs/apple-codesign/stable/apple_codesign_rcodesign_signing.html)
- [Notarizing and Stapling with `rcodesign`](https://gregoryszorc.com/docs/apple-codesign/main/apple_codesign_rcodesign_notarizing.html)
- [Known Issues and Limitations](https://gregoryszorc.com/docs/apple-codesign/0.28.0/apple_codesign_quirks.html)
- [Signing and Notarizing with GitHub Actions](https://gregoryszorc.com/docs/apple-codesign/stable/apple_codesign_github_actions.html)
- [indygreg/apple-platform-rs](https://github.com/indygreg/apple-platform-rs/tree/main/apple-codesign)
- [indygreg/apple-code-sign-action](https://github.com/indygreg/apple-code-sign-action)
- [Creating API Keys for App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
- [planetbeing/libdmg-hfsplus](https://github.com/planetbeing/libdmg-hfsplus)
- [fanquake/libdmg](https://github.com/fanquake/libdmg)
- [electron-builder DMG](https://www.electron.build/docs/dmg/)
