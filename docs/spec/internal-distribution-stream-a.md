# Stream A — CI/CD + signed binaries

Working notes for the agent (me) owning Stream A. Symmetric to
`internal-distribution-stream-b.md`. Read the parent PRD
(`internal-distribution.md`) for full context.

## State at handoff

| Item | Status | Notes |
|---|---|---|
| **A1** Internal repo migration | open — coordination, not code | Block on first internal release |
| **A2** CI on push/PR | ✅ already exists at `.github/workflows/ci.yml` | Verify after A1 — secrets/cache may need rename |
| **A3** Per-arch `bun --compile` | ✅ scaffolded — added `binaries` + `checksums` jobs to `release.yml` (this commit) | Codesign/notarize gated `if: false` until A4 |
| **A4** Signing + notarization | **deferred for v1** | Stubs left as `if: false`-gated `[DEFERRED A4]` steps. Flip after v1 if user feedback / compliance demands it |
| **A5** SBOM + license scan | open | `bun pm ls --json` → SPDX, `license-checker` |
| **A6** Smoke test on clean image | open | Download artifact, run `copilot-api debug --json`, assert shape |

## Vendored actions policy

Internal MS GitHub Actions environments reject non-MS/GitHub-sourced
actions. This repo follows a strict allowlist: any `uses:` reference
must resolve to either an `actions/*`-namespaced GitHub-published
action or a path-prefixed local composite under `.github/actions/`.

Currently vendored as local composites:

| Replaces | Local path | Notes |
|---|---|---|
| `oven-sh/setup-bun@v2` | `./.github/actions/setup-bun` | Composite; runs the official bun.sh install script. Swap to an internal mirror if supply-chain policy tightens |
| `softprops/action-gh-release@v2` | `./.github/actions/upload-release-asset` | Composite; shells to `gh release upload` (preinstalled on runners) |

**Disabled** (would otherwise pull non-MS/GitHub actions):

- `release-docker.yml` — depends on `docker/*` + `sigstore/cosign-installer`; trigger removed (manual `workflow_dispatch` only). v1 ships binaries + DMG/MSI, not Docker images.

**Adding a new third-party action is not allowed.** Either:
1. Replace with shell + `gh` CLI inside an existing step.
2. Vendor as a new composite under `.github/actions/<name>/`.

## A3 — what's wired now

`.github/workflows/release.yml` was extended with two new jobs that
run after the existing `release` job (npm publish):

- **`binaries`** — matrix `(macos-14, macos-13, windows-2022)` ×
  `(bun-darwin-arm64, bun-darwin-x64, bun-windows-x64)`. Builds via
  `bun build --compile --minify --sourcemap --target=…`. Packages
  as `tar.gz` (mac) or `zip` (win). Generates per-file SHA-256.
  Attaches both to the GitHub release using
  `softprops/action-gh-release@v2`.
- **`checksums`** — runs after `binaries`. Fetches every `.sha256`
  from the release, concatenates into a sorted `SHA256SUMS`,
  re-uploads.

Codesign / notarize / signtool steps are present but `if: false` so
the workflow stays green pre-A4. Flip them on once cred plumbing
lands.

The **artifact-naming contract** with Stream B is documented in a
comment block at the top of the `binaries` job. Don't change it
without coordinating.

## A4 — what's still needed

Need three credential sets:

1. **Apple Developer notarization** — Apple ID, app-specific password,
   Team ID. Existing internal MS tooling has these; ask the parent
   issue for the secret names to use. Then flip the `if: false` on
   the macOS `Codesign` and `Notarize` steps.
2. **Microsoft Apple Developer ID Application cert** — for `codesign`.
   Stored in the GitHub Actions secret store (or a managed cert
   keychain on a self-hosted runner; check what the rest of the org's
   Mac tools use).
3. **Authenticode / Microsoft signing service** — Windows. Usually
   HSM-backed and requires a specific runner pool. The
   `Sign (Windows)` step is currently a `Write-Host` stub.

After A4 lands, repeat the smoke test (A6) on a clean managed device
and confirm Gatekeeper / SmartScreen don't prompt.

## A5 — SBOM + license scan

Two pieces:

```yaml
- name: Generate SBOM
  run: |
    npx @cyclonedx/cyclonedx-npm --output-format JSON --output-file SBOM.cdx.json
    # or: bun x @cyclonedx/cyclonedx-npm ...
    # SPDX variant: npx spdx-sbom-generator -o ./

- name: License scan
  run: npx license-checker --production --onlyAllow 'MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;Unlicense;CC0-1.0' --excludePrivatePackages
```

Both attach to the release via `softprops/action-gh-release@v2`. Pick
SPDX over CycloneDX if internal compliance prefers it (TBD; ask).

License threshold list above is conservative. Loosen only if a
specific dep needs an exception, and document it.

## A6 — smoke test

Add a `smoke` job dependent on `binaries`:

```yaml
smoke:
  needs: binaries
  strategy:
    matrix:
      include:
        - { os: macos-14, artifact: darwin-arm64, ext: tar.gz }
        - { os: windows-2022, artifact: windows-x64, ext: zip }
  runs-on: ${{ matrix.os }}
  steps:
    - name: Download artifact
      run: gh release download "${{ github.ref_name }}" --pattern "copilot-api-v*-${{ matrix.artifact }}.${{ matrix.ext }}"
    - name: Unpack
      shell: bash
      run: |
        if [[ "${{ matrix.ext }}" == "zip" ]]; then 7z x ./*.zip; else tar -xzf ./*.tar.gz; fi
    - name: Run debug --json
      shell: bash
      run: |
        BIN=copilot-api
        if [[ "${{ matrix.artifact }}" == windows-* ]]; then BIN="copilot-api.exe"; fi
        ./$BIN debug --json | tee debug.json
        # Assert shape: top-level keys exist
        jq -e '.version and .git and .runtime and .config and .secrets and .executor' debug.json
```

Catches static-link / missing-dep bugs the build itself misses.

## Open questions for the team

1. **Internal repo URL.** Where does the repo land on the MS GitHub
   org? Need this to update `THIRD-PARTY-LICENSE` references and the
   Stream B Homebrew formula.
2. **Cert / cred set names** for Apple Developer and Authenticode in
   GitHub Actions secrets.
3. **SPDX vs CycloneDX** preference for internal compliance.
4. **Self-hosted runners?** If the Authenticode signing service
   requires a specific pool, configure `runs-on: [self-hosted, …]`
   in the matrix.

## Coordination with Stream B

Stream B starts on B5 (`setup` subcommand) immediately — no Stream A
dependency there. They wait for A3's first signed release before
working on B1 (Homebrew), B2 (.pkg), B3a/b (Windows installers).

When the first **unsigned** release publishes (now possible with this
commit), ping Agent B so they can validate the artifact-naming
contract end-to-end against B1's formula skeleton — even if signing
isn't done yet, the URL/SHA shape is final.
