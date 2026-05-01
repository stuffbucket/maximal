# Notice

## Vendored sources

### vendor/copilot-api/

Vendored verbatim from [caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api)
at commit `6db9538` (version 1.9.2, branch `dev`), pulled 2026-05-01.

Licensed under MIT — see `vendor/copilot-api/LICENSE`. Original copyright:
Erick Christian Purwanto, Cao Zhiyuan, and other contributors.

Vendored (rather than forked) so the entire dependency surface is in-tree
and auditable from this repo's CI / vulnerability scanners.

To refresh from upstream:

```sh
git clone --depth 1 -b dev https://github.com/caozhiyuan/copilot-api /tmp/caozhiyuan-clone
rsync -a --delete --exclude='.git' /tmp/caozhiyuan-clone/ vendor/copilot-api/
git diff vendor/copilot-api/   # review before committing
```

## Reference sources

`contrib/` contains read-only reference snapshots from related upstream
projects (ollama, opencode, ericc-ch/copilot-api). See `contrib/README.md`
for the architecture rationale and what each subdirectory is for. Nothing
in `contrib/` is built or shipped — it's documentation.
