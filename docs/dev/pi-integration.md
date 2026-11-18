# Pi integration

Maximal configures Pi through its standard `models.json` custom-provider interface.
No Pi extension, modified Pi installation, or additional GitHub sign-in is needed.
The readable-name and price-column selector changes are separate Pi UI changes;
connectivity does not depend on them.

## Connect

Install Pi normally, sign in to Copilot in Maximal, then open Settings →
Integrations → Harnesses → Pi → Connect. Confirm the connection and open `/model`
in Pi. Choose a model there; Maximal never changes Pi's default model or settings.

The connection dialog keeps the usual directory unless changed under Advanced.
Use the same agent directory Pi uses, not the directory containing its executable.
An existing manually configured `maximal` provider requires explicit adoption.
The confirmation explains that disconnecting restores the original provider.
Changing directories invalidates that consent until the new target is inspected
and confirmed.

The CLI uses the same adapter:

```sh
maximal app pi                         # inspect; no writes or sign-in
maximal app pi --enable                # provision and remember routing intent
maximal app pi --enable --adopt-existing
maximal app pi --enable --config-dir /absolute/path/to/agent
maximal app pi --disable
```

A CLI enable fetches the catalog if it is not cached in that process. Use
`--account-type individual|business|enterprise` when needed. Settings uses the
server's cached catalog and refuses an empty catalog without creating credentials
or configuration. Detection never signs in, enables routing, executes Pi, or sends
an inference request.

## Files and ownership

The default target is `$PI_CODING_AGENT_DIR/models.json`, or
`~/.pi/agent/models.json`. A successfully enabled directory is persisted in
Maximal's `apps.pi.configDirectory`, so subsequent environment changes cannot move
an already-owned integration to another target. Disable before selecting a
different directory. Routing intent is `apps.pi.enabled`.

Maximal owns only `providers.maximal` in this file. It supplies the current local
proxy address, a command-backed Maximal API key, and the projected models. No
GitHub token is copied into Pi. Other providers, root settings, and existing
provider overrides are preserved. JSONC comments, trailing commas, BOMs, and
newline style are supported. Duplicate keys, malformed documents, non-object
providers, and symlink files are refused instead of guessed at.

The provider carries a versioned `_maximal` marker with its owning Maximal profile,
a fingerprint, and the original provider text. A private, checksummed
`pi-routing.json` in that profile's Maximal data directory retains the original
file and last applied text. Both files are written atomically with private
permissions. Unrelated external edits are incorporated into the restoration
snapshot on subsequent catalog refreshes, not overwritten by an older snapshot
on disable.

Disconnect/disable/uninstall restores the adopted provider, or removes a provider
Maximal created. A newly created, otherwise untouched file is removed. An
unchanged pre-existing file is restored byte-for-byte; unrelated subsequent edits
remain. If generated provider content or the restoration journal was edited,
Maximal preserves it and reports `cleanup-required`. Review that configuration
rather than using a force flag. External deletion is not silently recreated by
background synchronization; explicitly enable again to reclaim the target.

An unchanged provider owned by another Maximal profile offers an explicit transfer
in Settings, or `--override-other-maximal` in the CLI. This carries forward the
original user provider. The old profile cannot refresh or remove the transferred
entry. This override never authorizes overwriting damaged markers or user edits.

## Catalog and lifecycle

The projection uses Maximal's normalized in-process Copilot catalog and its
existing catalog-change notifications. It includes tool-capable streaming chat
models with a supported native transport and declared limits. Synthetic Claude
variants and unsupported operations are excluded. API IDs are preserved.

Claude uses native Messages when available; other models prefer Responses and
fall back to Chat Completions. The projection includes context/output limits,
image support, reasoning levels, base/cache rates, and differing long-context
price tiers. AI credits per catalog batch are converted to USD per million using
Maximal's configured `budget.display.creditUsd`, defaulting to $0.01 per credit.
These are catalog estimates, not an individual subscription invoice.

Successful catalog refreshes update an enabled, unchanged provider. Failed or
empty refreshes retain the working configuration. Explicit API-key registry
changes refresh the helper without minting replacement credentials in the
background. Boot rechecks saved intent and the current proxy port. Repeated boot
hooks keep a single catalog subscription; shutdown detaches it.

Unlike integrations that temporarily revert a client on shutdown, Pi keeps its
cached provider across Maximal restarts. It remains selectable offline, but
inference requires Maximal to be running. Only explicit disable or uninstall
removes it. Opening `/model` reloads the file on supported Pi versions; restart
older versions if necessary.

## Detection

Settings probes allowlisted PATH/known installation locations and reads official
Pi package metadata. It follows executable symlinks, recognizes npm and mise
layouts, deduplicates targets, and caches manifest reads by file metadata. It
never invokes a program merely because it is named `pi`, nor runs Windows command
wrappers. Missing or unsupported installation metadata is shown as not installed;
the official Pi website is offered for installation instructions. The explicit
CLI can provision configuration even when conservative discovery cannot identify
a custom installation.

## One-shot refresh

From a source checkout, `bun run pi:sync --account-type enterprise` previews an
existing provider; add `--write` to update it. It supports manually configured and
current-profile managed providers, preserves JSONC, and saves a private backup.
Managed refreshes go through the same fingerprint and journal update as automatic
reconciliation. Another profile's provider or externally edited managed data is
refused. This tool is not first-run provisioning; use Connect or `app pi --enable`
for that.
