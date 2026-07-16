# In-place self-updater

> **Why this doc exists.** Maximal now has *two* independent update
> surfaces that are easy to conflate. This doc pins down which is which,
> how the in-place install path verifies and swaps the bundle, and the
> config + test seams around it. It's the Tauri-updater half of Phase 6
> (`docs/spec/phase-6-self-update.md`) — the notify half is already shipped.

The wiring described here lives in:

- `shell/src-tauri/tauri.conf.json` — `plugins.updater` block + `bundle.createUpdaterArtifacts`.
- `shell/src-tauri/Cargo.toml` — the `tauri-plugin-updater` dependency.
- `shell/src-tauri/src/lib.rs` — `handle_upgrade`, `check_inplace_update`,
  `prompt_and_install`, `open_update_url`, plugin registration, and the
  `MAXIMAL_UPDATE_ENDPOINT` seam.
- `src/lib/update/update-check.ts` — the **separate** notify-only path.

---

## Two surfaces, not one

There are two distinct mechanisms. They talk to two different JSON
documents at two different URLs and do two completely different things.

| | **Notify** | **In-place install** |
|---|---|---|
| Lives in | `src/lib/update/update-check.ts` (the sidecar, TypeScript) | `shell/src-tauri/src/lib.rs` (the Tauri shell, Rust) |
| Manifest | `https://mxml.sh/updates/manifest.json` | `https://mxml.sh/updates/latest.json` |
| Schema | `{ channels: { stable: { version } } }` (channel-keyed, **no** download URL) | Tauri updater `latest.json` (version + per-target signed-artifact URL + `signature`) |
| What it does | Compares the published version to `BUILD_VERSION`; makes the tray **"Upgrade to v…"** item and a one-shot OS notification appear | Downloads the signed `.app.tar.gz`, verifies its signature, swaps the bundle, relaunches |
| Trigger | The shell's periodic poll of the sidecar's `/settings/api/update-status` (which reads the manifest) | The user *clicking* the tray "Upgrade to v…" item |

The notify path only ever tells you an update **exists** — it deliberately
never carries a download URL (a tampered manifest can at most misreport a
version, never redirect you to a malicious download; the human-facing
download destination is pinned as the `DOWNLOAD_URL` constant). The
in-place path is what actually fetches, verifies, and installs.

So: **notify → `manifest.json` → the tray item appears. Install →
`latest.json` → the download+verify+install runs when that item is
clicked.**

---

## End-to-end flow

```
tray "Upgrade to v…" click
  │  (handle_menu_event → menu_id::UPGRADE → handle_upgrade)
  ▼
check_inplace_update           app.updater_builder().build().check()
  │                            reads plugins.updater.{endpoints,pubkey}
  │                            → GET latest.json (or MAXIMAL_UPDATE_ENDPOINT)
  ├─ Ok(Some(update)) ─────▶ prompt_and_install
  │                            │
  │                            ▼
  │                          native confirm dialog  (tauri-plugin-dialog)
  │                            │  user confirms
  │                            ▼
  │                          update.download_and_install()
  │                            · download signed .app.tar.gz
  │                            · verify Ed25519/minisign sig vs `pubkey`
  │                            · swap the bundle in place
  │                            │
  │                            ▼
  │                          app.restart()
  │                            → RunEvent::ExitRequested → kill_sidecar
  │                              (SIGTERM → 3s → SIGKILL)
  │                            → fresh shell relaunches
  │                            → spawn_sidecar with `start --replace --port 4141`
  │                              (SIDECAR_PORT = 4141; --replace evicts any
  │                               stale listener on the port)
  │
  ├─ Ok(None)  ────────────▶ open_update_url  (nothing installable → browser)
  └─ Err(_)    ────────────▶ open_update_url  (dev build / unreachable / etc.)
```

The restart is the load-bearing interaction with the sidecar. `app.restart()`
routes through `RunEvent::ExitRequested`, which is the sole `kill_sidecar`
site for a real shutdown — the old sidecar gets a graceful SIGTERM (3s grace,
then SIGKILL). The relaunched shell then spawns a fresh sidecar with
`start --replace --port 4141`, so `--replace` gracefully evicts anything still
holding `:4141` (`SIDECAR_PORT`) before the new proxy binds. This is the same
`--replace` handoff the shell always uses; the updater just triggers it via a
full process restart.

---

## The signature format (the non-obvious part)

A Tauri updater signature is **not** raw minisign. The `signature` field in
`latest.json` (and the `pubkey` in `tauri.conf.json`) is a **base64-wrapped
minisign structure**. To verify a downloaded artifact by hand:

```sh
# The .sig and the pubkey line are each base64 — decode first.
base64 -d < artifact.app.tar.gz.sig > artifact.sig.minisign
echo "<PUBKEY-LINE-FROM-tauri.conf.json>" | base64 -d > pubkey.minisign

# Then it's a plain minisign verification against the tarball.
minisign -Vm artifact.app.tar.gz -x artifact.sig.minisign -P "<decoded-pubkey-line>"
```

The underlying primitive is Ed25519 (minisign's signing algorithm). The
plugin does this base64-unwrap-then-minisign-verify internally on
`download_and_install`; the manual recipe above is only for debugging "why
did verification fail."

---

## Config: `plugins.updater`

In `shell/src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6…",
    "endpoints": [
      "https://mxml.sh/updates/latest.json"
    ]
  }
}
```

- **`endpoints`** — where the plugin fetches `latest.json`. Tauri expands
  `{{target}}` / `{{arch}}` / `{{current_version}}` placeholders here if
  present; ours is a single static URL that serves a multi-target manifest.
- **`pubkey`** — the **public** verification key (minisign key id
  `BF65715BAE1C1F9F`). It is public by design and **commit-safe** (it verifies
  signatures; it can't produce them), so the real value is committed to
  `tauri.conf.json`. Base64-decode it to see the `untrusted comment: minisign
  public key …` block.

The matching **private** key is provisioned **privately on the builder
runner** — it never lives in this repo and is out of scope here.

> **Losing the private key strands the install base.** The `pubkey` baked
> into a shipped build only trusts artifacts signed with the corresponding
> private key. If that private key is lost, no future release can produce a
> signature the installed base will accept — every client silently falls
> back to the browser download forever, and the only way back to working
> in-place updates is to ship a new build carrying a new `pubkey` (which the
> old install base can't auto-update *to*). Guard the private key
> accordingly.

---

## `createUpdaterArtifacts: false`

`bundle.createUpdaterArtifacts` is set to **`false`** in `tauri.conf.json`.

Normally Tauri's own `tauri build` produces the updater `.app.tar.gz` +
`.sig` for you — but signing them requires the `TAURI_SIGNING_PRIVATE_KEY`
to be present at build time. We deliberately **don't** put the private key on
the generic build machine. Instead, the private **`stuffbucket/macos-builder`**
produces the signed `.app.tar.gz` + `.sig` itself (it already holds the
Apple + signing secrets and does the notarized `.dmg`; see
`docs/release-runbook.md` → the `macos-dmg` job). Setting
`createUpdaterArtifacts: false` keeps `tauri build` from trying to sign
(and failing/erroring for lack of the key), and leaves artifact production
to the one place that has the key.

At a high level: **the private macos-builder signs; this side only
verifies + installs.** Key-provisioning / runner-setup specifics for the
builder are intentionally not documented here.

---

## Isolated end-to-end test seam: `MAXIMAL_UPDATE_ENDPOINT`

`check_inplace_update` honors a `MAXIMAL_UPDATE_ENDPOINT` environment
variable that **overrides** `plugins.updater.endpoints` at runtime. This
lets a build point at a **local** `latest.json` + test bundle and exercise
the *real* download → verify → swap → restart path without shipping a
release or touching production.

High-level recipe:

1. **Throwaway keypair.** Generate a disposable Tauri signing keypair and
   temporarily swap its **public** key into `plugins.updater.pubkey` for the
   *test build only* (the committed production pubkey only trusts artifacts the
   private builder key signed, which you don't have locally). Keep its private
   key local.
2. **Sign a test artifact.** Build a `.app.tar.gz` for a slightly-higher
   version and sign it with the throwaway private key, producing the `.sig`.
3. **Serve a local `latest.json`.** Write a `latest.json` pointing at the
   test `.app.tar.gz` with its base64 `signature`, and serve it plus the
   tarball from a local HTTP server (e.g. `http://127.0.0.1:PORT/latest.json`).
4. **Launch with the override.** Start the *installed* test build with
   `MAXIMAL_UPDATE_ENDPOINT=http://127.0.0.1:PORT/latest.json` and click the
   tray "Upgrade" item.

> **`http` endpoints are rejected unless the build opts in.** Tauri's updater
> refuses any non-`https` endpoint ("The configured updater endpoint must use a
> secure protocol like `https`.") and exposes **no runtime setter** for it — the
> escape hatch is the config flag `plugins.updater.dangerousInsecureTransportProtocol: true`,
> which is baked at build time. So a local **http** `latest.json` only works in a
> test build compiled with that flag (never commit it to the shipped config).
> Alternatively serve the endpoint over **https** with a locally-trusted cert.

> **Must be a real `.app` install, not `cargo run` / dev.** A faithful test
> requires an actually-installed `.app` bundle — the updater swaps a bundle
> on disk and relaunches, which a `cargo run` dev process has no equivalent
> of. Because it installs over a real bundle, run it against a **throwaway /
> beta install so it doesn't disturb a running production copy** (see
> `docs/dev/beta-channel-and-safe-build-testing.md` for the isolated-build
> tiers — a distinct-identity beta install is the right lane for this).

> **✅ Verified end-to-end (2026-07-15).** A base build (v0.4.0, throwaway
> pubkey + `dangerousInsecureTransportProtocol`) installed to `/Applications`,
> pointed via `MAXIMAL_UPDATE_ENDPOINT` at a local http `latest.json` offering a
> throwaway-signed v0.99.0, upgraded in place on the tray click: dialog →
> download → signature verify → bundle swap → `app.restart()` → sidecar
> respawned on `:4141`. Rolled back to the real notarized build via the v0.4.41
> dmg. The signature/verify half was independently confirmed with `minisign -Vm`.

---

## Fallback behavior — the button is never a dead end

Every failure mode of the in-place path falls back to opening the
install-channel-neutral **download page in the browser** (`open_update_url`,
the same URL the OS notification points at). Concretely, that covers:

- a **dev build** (no updater artifacts / no matching signature),
- an **unreachable or absent** updater endpoint,
- **no signed artifact for this platform** yet (`Ok(None)` — endpoint
  reachable but nothing installable),
- a **failed signature verification**,
- a **failed download** after the user confirmed,
- the **user declining** the confirm dialog is simply a no-op.

So the "Upgrade to v…" tray item is *always* useful — worst case it sends the
user to the download page — even on channels the signed-artifact pipeline
doesn't cover yet.

---

## Phase status / TODO

This is wired but **not yet shippable**. Before the in-place path is real:

- [x] **Fill the pubkey.** The real public verification key
      (minisign id `BF65715BAE1C1F9F`) is committed in `tauri.conf.json`; the
      matching private key is provisioned privately on the builder runner.
- [ ] **Publish `latest.json`.** The site must publish
      `https://mxml.sh/updates/latest.json` (the Tauri updater manifest,
      distinct from the existing `manifest.json` the notify path reads),
      pointing at the signed per-target artifacts the macos-builder produces.
- [x] **Full end-to-end install test on real hardware.** Done 2026-07-15
      (see the *Isolated test* callout above): base v0.4.0 → in-place upgrade to
      a throwaway-signed v0.99.0 over a local endpoint — download → verify →
      bundle swap → restart → sidecar respawn all confirmed, then rolled back to
      the real build. Remaining before ship: publish `latest.json` (above) and
      swap the real per-release signed artifact in for the throwaway one.
