# Research: winget support for Maximal

**Bottom line:** yes, this is easy. We already ship the only thing
winget needs (a silent-installable MSI). A first submission is
~1–2 hours; auto-update on every release is another ~1–2 hours of CI
wiring. **Code signing is not required.**

## What winget actually demands

[Source: Microsoft docs](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest), [winget-pkgs repo](https://github.com/microsoft/winget-pkgs)

- Submit YAML manifest(s) via PR to `microsoft/winget-pkgs`.
- For a multi-installer or multi-locale package, three files
  (version, defaultLocale, installer) — that's the standard shape.
- Required fields: `PackageIdentifier` (`Publisher.Package` form),
  `PackageVersion`, `PackageLocale`, `Publisher`, `PackageName`,
  `License`, `ShortDescription`, `Installers[]` (with `Architecture`,
  `InstallerType`, `InstallerUrl`, `InstallerSha256`), `ManifestType`,
  `ManifestVersion`.
- Installer must support silent install. MSI is silent by default
  with `/q` — we already qualify.
- The installer URL must be a stable, public download. GitHub release
  assets work — that's where our MSI already lands per
  `.github/workflows/installers.yml`.

## Things winget does **not** require

- **Code signing / Authenticode.** Not blocking. The community repo
  carries plenty of unsigned MSIs. Users get the SmartScreen prompt
  on first install but the package still installs and `winget`
  recognizes upgrades. (Signing is a separate UX hardening pass we
  already have tracked as A4 in the release runbook.)
- **MSIX format.** Plain MSI is accepted. No store registration.
- **Publisher account.** Anyone with a GitHub account can submit.
  No paid program.
- **Specific build infra.** The artifact just needs a URL + SHA256.

## What we already have that fits

- **MSI artifact.** `windows-msi` job in
  `.github/workflows/installers.yml` produces
  `maximal-<version>-windows-x64.msi` on every release.
- **Stable identity in the MSI.**
  `build/windows/maximal.wxs` declares:
  - `Manufacturer="stuffbucket"`
  - `Name="maximal"`
  - `UpgradeCode="C9E7F4A1-2B3D-4E5F-9A8B-7C6D5E4F3A2B"` (stable
    across versions — required for the winget upgrade story)
  - `MajorUpgrade` — proper in-place upgrade behavior.
- **Silent install.** MSI honors `msiexec /i … /q` out of the box;
  no custom switches needed in the manifest.
- **Public download URL.** GitHub releases attach the MSI with a
  predictable URL (`/releases/download/<tag>/<asset>`).
- **SHA256 sidecar.** The MSI job already emits `.sha256`, so the
  hash that winget requires is already computed.

## Mapping to a winget manifest

PackageIdentifier would be **`Stuffbucket.Maximal`** (the form is
`Publisher.Package` — Microsoft does enforce uniqueness, and the
publisher folder for an existing `Stuffbucket` namespace would be
created on first submission).

Three-file layout in `manifests/s/Stuffbucket/Maximal/<version>/`:

- `Stuffbucket.Maximal.yaml` (version)
- `Stuffbucket.Maximal.locale.en-US.yaml` (defaultLocale)
- `Stuffbucket.Maximal.installer.yaml` (installer)

Approximate installer manifest:

```yaml
PackageIdentifier: Stuffbucket.Maximal
PackageVersion: 0.3.5
InstallerType: wix
Platform:
  - Windows.Desktop
MinimumOSVersion: 10.0.17763.0
Scope: machine
InstallModes:
  - silent
  - silentWithProgress
UpgradeBehavior: install
Installers:
  - Architecture: x64
    InstallerUrl: https://github.com/stuffbucket/maximal/releases/download/v0.3.5/maximal-0.3.5-windows-x64.msi
    InstallerSha256: <sha from .sha256 sidecar>
    ProductCode: '{...from MSI...}'
ManifestType: installer
ManifestVersion: 1.12.0
```

`ProductCode` is the GUID on `<Package Id="...">` in WiX. Our
`maximal.wxs` uses `*` (auto-generated per build), so we'd need
either (a) pin the ProductCode the way `UpgradeCode` is already
pinned, or (b) extract it from each build's MSI and bake it into the
generated manifest at release time. Option (b) is what
`wingetcreate` / `komac` automate.

## Tooling options

- **[`wingetcreate`](https://github.com/microsoft/winget-create)** —
  official Microsoft CLI. `wingetcreate new` prompts through every
  field; `wingetcreate update --urls <new-msi-url>` regenerates the
  manifest for a new version and opens the PR. Recommended for the
  initial submission.
- **[`komac`](https://github.com/russellbanks/Komac)** — community
  Rust CLI. More popular for CI auto-submission because it handles
  release detection, SHA256 calc, and PR creation in one shot. Plays
  well with GitHub Actions; lots of small projects use it.
- **[`vedantmgoyal2009/winget-releaser`](https://github.com/vedantmgoyal2009/winget-releaser)**
  — GitHub Action that wraps komac. Drop into the release workflow
  and every tagged release auto-submits a winget PR.

## Effort breakdown

| Phase                                | Effort      | Notes                                                                   |
| ------------------------------------ | ----------- | ----------------------------------------------------------------------- |
| First manual submission              | 1–2 hours   | `wingetcreate new`, point at the latest release MSI, submit PR          |
| Pin or extract ProductCode           | 15–30 min   | Either swap WiX `Id="*"` for a stable GUID + bump strategy, or let komac scrape it from the MSI each release |
| Wire auto-update into release CI     | 1–2 hours   | Add `winget-releaser` to `.github/workflows/installers.yml` (or new workflow) keyed on release publication |
| Add screenshot + Tags / PackageUrl   | 15 min      | One-time polish on the defaultLocale manifest                           |

**Total:** half a day to ship + automate.

## Things to check before submitting

- **Run the MSI through `winget validate`** against the draft
  manifest. The repo's CI re-runs the same validation; passing
  locally saves a round-trip.
- **Install end-to-end via the manifest in dry-run** with
  `winget install --manifest <dir>` on a clean Windows VM. Catches
  silent-install issues, missing prerequisites, and bad install
  paths.
- **Confirm the MSI uninstalls cleanly** — winget keys upgrade off of
  ProductCode and a broken uninstall surfaces as `winget upgrade`
  failures down the line.
- **Pick a stable PackageIdentifier** — once published, renaming is
  user-hostile. `Stuffbucket.Maximal` is the natural choice; verify
  no clash in the existing publisher folder (none today).
- **Add `Tags`, `PackageUrl`, `License`, `LicenseUrl`** —
  discoverability via `winget search`. We have all of these in
  `package.json` and the repo root already; mechanical copy.

## Open question

- **PATH side effect.** `maximal.wxs:104` writes the install dir to
  the `PATH` env var. winget is fine with this, but worth confirming
  the entry survives upgrade (the WiX `MajorUpgrade` should preserve
  it). If it doesn't, `winget upgrade` will repeatedly nuke + restore
  the PATH entry, which is fine but worth checking on the first
  upgrade cycle.

## Recommendation

1. Submit a manual first version via `wingetcreate new` against the
   current `v0.3.5` MSI. Get the publisher folder created and the
   PR-review process unblocked.
2. Once merged, add `vedantmgoyal2009/winget-releaser` to the release
   workflow so every tag → automatic winget PR.
3. Defer code signing as already planned (A4). It improves first-run
   UX but does not block winget distribution.
