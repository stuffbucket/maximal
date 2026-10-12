# Codex CLI and desktop routing

Settings → Apps → Codex CLI and Desktop uses the same **On/Off toggle** as the other Maximal integrations for both clients. Connecting configures task routing and native automatic permission reviews through Copilot together. Existing connections that need the catalog configuration or a refresh show **Update connection**.
It detects the CLI on PATH and in common install locations, as well as supported
macOS desktop installs. Install either client and connect your account in Maximal
before configuring routing. Apps uses the model saved in your Codex
configuration without displaying or changing it. If that model is missing or
unsupported, configure a supported model in Codex and try again.

Connect checks the command-backed key helper and sends short, non-stored
Responses requests for the task model and Astra reviewer through `http://127.0.0.1:4141/v1`. These checks can consume
Copilot quota. Only completed responses allow the config write. Failure
leaves Codex's config unchanged. Start a new Codex session after toggling;
running sessions retain their configuration.

The integration is also registered as `maximal app codex` (status),
`maximal app codex --enable`, and `maximal app codex --disable`. CLI enable
uses the configured model and the same verification as Settings. Uninstall
calls the same ownership-aware removal. Routing remains configured while
Maximal is stopped; switch it off before using Codex without Maximal.

## Desktop

The combined entry detects macOS installs of `Codex.app` and
`ChatGPT.app` in `/Applications` and `~/Applications`. A ChatGPT install must
contain the bundled Codex executable; older chat-only apps do not qualify.
Desktop detection on Windows and Linux is not implemented.

Desktop and CLI share the same user configuration and therefore the same
routing state. One configuration controls both and lists their detected install paths.
Enabling uses the same verification, authentication helper, and restoration metadata. Disabling
restores the settings from before the first enable; it does not save a second
backup of already-routed settings. Restart the desktop app and create a new
local chat after toggling. Existing chats can retain their provider and model;
remote/cloud chats and explicit overrides are outside this toggle.

`maximal app codex --enable` and `--disable` expose the same behavior.
The earlier desktop API endpoint remains compatible, but the Apps list and CLI
command list expose only the combined integration.
The integration uses the shared `codex` API client key. Maximal and the desktop
app must use the same `CODEX_HOME` (normally `~/.codex`); a custom environment
setting in a terminal does not change an app launched from Finder.

## Configuration and ownership

- Respects `CODEX_HOME`, falling back to `~/.codex/config.toml`.
- Sets the effective `model_provider` to an available managed provider name,
  starting with `maximal-app` and using a numbered suffix when necessary.
  Existing provider definitions and references are preserved. If the default profile
  explicitly selects a provider, that profile's setting is changed; otherwise
  the root setting is changed. Other profiles are preserved. Explicit CLI
  overrides, alternate profiles, and project/admin configuration can still
  override the user configuration; the check verifies the user-level route.
- Settings and CLI toggles leave `model` untouched. The API also accepts an
  explicit model override; those changes use the same reversible edits.
- Adds a marked provider section with `wire_api = "responses"` and
  command-backed `auth`. A manually configured `model_providers.maximal`
  can coexist with the integration. Disabling restores the prior provider
  selection; it may still route through Maximal if that was the prior setup.
  Earlier marked integrations using the `maximal` name remain reversible.
- The helper invokes the current Maximal executable with `api codex` and an
  explicit `--api-home` after the client subcommand (`api codex --api-home …`).
  Stable symlinks to that executable are preferred;
  development launches include the absolute Bun entrypoint. Keys stay in
  Maximal's key store and travel through captured stdout to Codex. No API key
  or environment-variable requirement is written into Codex configuration.
- The marked block contains restoration metadata for only the changed scalar
  statements. Comments, whitespace, unrelated tables, and credentials remain
  outside these edits. Writes use a private temporary file and atomic rename,
  with a reread immediately before committing to reject concurrent edits.
- Disable restores a scalar only if its current statement exactly matches
  the one Maximal wrote. Later user edits survive. The provider is removed
  only if it is unchanged and no remaining profile references it; otherwise
  its content is preserved and ownership markers are removed. When routing
  has drifted, Apps offers “Remove Maximal settings” for cleanup.
- Invalid TOML, damaged ownership metadata, symlinked config files, and
  layouts that cannot be edited without changing unrelated parsed values
  fail without rewriting the file. Ordinary root keys and profile tables,
  including multiline TOML elsewhere in the document, are supported.

The toggle is serialized within the Maximal process. Repeated enable/disable
does not duplicate config or replace the original restoration metadata. An
already-enabled connection with current catalog metadata does not send another verification request.

## Authentication reference

Codex's [official configuration reference](https://developers.openai.com/codex/config-reference/)
documents `model_providers.<id>.auth.command`, `auth.args`, `auth.timeout_ms`,
and `auth.refresh_interval_ms`. Command auth must not be combined with
`env_key`, `experimental_bearer_token`, or `requires_openai_auth`. The
integration writes none of these competing authentication settings. Tasks and
reviewer requests both use command authentication and the normal `/v1` endpoint.

## Validation scope

Desktop detection is tested with temporary app bundles. Routing restoration
tests use in-memory TOML, including repeated enable and user edits made while
routing is active. The live routing check runs when enabling the integration;
development checks do not change the developer's Codex configuration.

## Automatic approval compatibility

**Connect Codex includes native Copilot reviewer configuration.** There is no
separate review setup or ChatGPT connection. Maximal does not enable automatic
approvals: choose that in Codex's existing approval settings. It leaves
`approval_policy`, `approvals_reviewer`, sandbox settings, `review_model`, and
Codex's native review policy untouched.

Codex CLI 0.157.1 supports `auto_review_model_override` on task-model metadata
loaded at startup with `model_catalog_json`. Connect sets this field to
`gpt-6-astra` on **every catalog entry currently supported by Copilot's Responses
API**, including Luna, Sol, and Astra when available. Switching between those
models therefore keeps reviewer routing. Maximal never aliases `codex-auto-review`,
invents a review decision, or substitutes another reviewer after a failure.
A model absent from the native/custom catalog cannot be connected until suitable
Codex metadata is available; Maximal does not fabricate model instructions.

### Catalog discovery and verification

Connect reads each detected CLI/Desktop binary's version and its offline
`codex debug models --bundled` catalog in an isolated temporary Codex home and
workspace. It uses the newest installed client's bundle as the base. It then
asks **every detected client** to load the proposed `model_catalog_json` with
an unauthenticated local provider and checks that the native output retains
all expected reviewer overrides. These checks neither load user credentials
nor contact ChatGPT. An old or incompatible binary, invalid catalog, unavailable
Astra reviewer, or failed task/reviewer connectivity check stops configuration
before the user's settings change.

This metadata field is version-dependent, not a stable public configuration
contract. Connect validates actual client support rather than assuming that a
version number guarantees it. A client binary change, changed custom catalog,
or newly supported model missing an override makes Settings offer **Update
connection**. Updating rebuilds and revalidates the snapshot; it never rewrites
settings in the background. If a Codex update is incompatible, the previous
configuration is retained and the error requests an updated compatible client.

### Ownership, custom catalogs, and restoration

- A complete catalog copy is saved privately under
  `$CODEX_HOME/maximal-catalogs/<content-hash>.json`. The config points to its
  absolute path. Each snapshot is immutable; new content gets a new file.
- Existing custom catalogs, including manually installed review catalogs, are
  read and copied, never rewritten. Custom root fields and per-model metadata
  take precedence over the bundled values; new bundled entries and missing
  fields are retained. The reviewer field is changed only for supported task
  entries. Custom nested values remain intact rather than being reconstructed.
  On refresh, the original custom source remains authoritative; users maintain
  intentional custom policy/instruction overrides when updating Codex.
- A separate marked block records the exact original catalog statement,
  snapshot digest, original custom source, client fingerprints, and covered
  task models. Repeated connection updates keep the first restore point.
- Later edits to the selected catalog path or generated snapshot are not
  overwritten. Disconnect removes ownership while retaining an edited selection
  or edited snapshot. Otherwise it restores the exact original catalog statement
  (or removes the setting if none existed), together with the existing provider
  restoration rules. A manually installed catalog is therefore
  restored on disconnect.
- Snapshots are retained after refresh/disconnect because another profile or a
  running client may still reference them. Failed commits can leave an unused
  private snapshot, but never a config pointer to a partial file. Publication
  refuses existing mismatched files and symlinks. Config writes are atomic and
  reject concurrent edits; custom sources and client fingerprints are checked
  again immediately before commit.

### Existing installations and API compatibility

An intact older command-auth connection can be updated directly, retaining
its original disconnect restore point. Edited providers are not adopted.
Authentication files and the Maximal key store are not rewritten. New
connections use the existing `maximal-app` provider name and `/v1` endpoint.

The Settings API accepts `{ enabled: true, model?: string }`. The old
`automaticReview` flag is accepted but ignored for compatibility: every connect
configures native reviews; approval preference belongs to Codex. Responses
include `routing.automatic_review` (configuration readiness, not permission to
auto-approve), `review_update_required`, and mutation-only `restart_required`.
The Codex CLI command uses the same connection implementation.

**Restart Codex and start a new local chat after connecting, updating, or
disconnecting.** Settings and the CLI show restart guidance
when the connection changes. A running chat can retain its startup catalog,
provider, and model. A successful connection check establishes connectivity,
not a completed automatic approval decision.

### Validation

Development checks use temporary configuration and test credentials:

```sh
bun test tests/codex-connect.test.ts tests/codex-desktop.test.ts tests/apps-route.test.ts tests/apps-cli.test.ts tests/i18n-catalog-parity.test.ts
bun test ./shell/src/ui/features/apps/AppCard.test.tsx
MAXIMAL_TEST_CODEX_EXECUTABLE=/absolute/path/to/codex bun test tests/codex-catalog-runtime.test.ts
```

The optional native check loads the actual installed client's catalog offline
in a temporary home, without changing user configuration or sending a live
review. Building this source does not update the installed Maximal app.
