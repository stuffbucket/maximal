# Phase 1 — CI hardening

## 30-second context

Three small CI gates that prevent failure modes we've already hit (lockfile
drift, silently-untested code paths) and one supply-chain upgrade that pairs
with the existing CycloneDX SBOM. All first-party actions only. Total
engineering effort: ~1 day. Land as a single PR.

## Goals

1. Fail fast on `bun.lock` ↔ `package.json` drift in PR CI, with a clear
   "commit your bun.lock" message.
2. Add coverage tracking with a threshold gate, so untested paths can't
   regress quietly.
3. Attach SLSA build-provenance attestations to release binaries so downstream
   consumers can verify origin cryptographically.

## Non-goals

- Coverage *increase* — we ratchet up only after thresholds are set at the
  current honest numbers.
- Third-party coverage SaaS (Codecov, Coveralls). Lcov uploaded as workflow
  artifact is enough; we don't have an audience for hosted dashboards.
- Replacing CycloneDX SBOM. The existing flow stays; we add attestation on
  top.

## Design

### 1.1 Lockfile-drift gate

New CI job in `.github/workflows/ci.yml`:

```yaml
lockfile-drift:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/setup-bun
    - run: bun install --lockfile-only
    - run: |
        if ! git diff --exit-code bun.lock; then
          echo "::error::bun.lock is out of sync with package.json."
          echo "::error::Run \`bun install\` locally and commit the updated bun.lock."
          exit 1
        fi
```

Existing `bun install` calls in `release.yml` switch to `--frozen-lockfile`
(currently mixed). One canonical mode, one failure surface.

### 1.2 Coverage gate

`bunfig.toml`:

```toml
[test]
coverage = true
coverageReporter = ["text", "lcov"]
coverageDir = "coverage"
coverageThreshold = { line = 0.78, function = 0.85, statement = 0.78 }
```

Initial thresholds = current values minus 1 percentage point of slack. CI step
in `ci.yml`:

```yaml
- run: bun test --coverage
- uses: actions/upload-artifact@v4
  with:
    name: coverage-lcov
    path: coverage/lcov.info
```

Bun's runner exits non-zero on threshold violation; no parser needed.
Reviewers download the lcov artifact for inspection.

### 1.3 Build-provenance attestation

In `release.yml`, after the `binaries` job uploads tarballs and zips:

```yaml
- uses: actions/attest-build-provenance@v2
  with:
    subject-path: |
      dist-release/maximal-v${{ steps.ver.outputs.version }}-darwin-arm64.tar.gz
      dist-release/maximal-v${{ steps.ver.outputs.version }}-windows-x64.zip
```

Pairs with the existing SBOM (also attestable via `actions/attest-sbom@v2` if
we want to upgrade later). Uses `id-token: write` (already granted) for the
OIDC handshake to Sigstore; no new secrets required.

## Acceptance

- Opening a PR that bumps a dep in `package.json` without committing
  `bun.lock` fails the lockfile-drift job with the documented error message.
- Removing `bun test` of an existing module drops coverage below threshold and
  fails CI.
- A `v*` tag push produces a release with provenance attestations visible at
  `https://github.com/stuffbucket/maximal/attestations/<id>`.

## Estimate

Half a day for the lockfile + coverage gate; another half-day for provenance
+ verification. One PR.

## Open questions

1. Do we want a "ratchet" workflow that auto-increments coverage thresholds on
   green merges? (Out of scope for this PRD.)
2. Should `installers.yml` also produce attestations for the `.app.zip` /
   `.msi` / `install.ps1`? Probably yes; trivial to add as a follow-up.
