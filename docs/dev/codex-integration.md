# Codex integration

Maximal supports Codex CLI and Desktop as one app integration. Both surfaces use
Codex's user-level configuration, so one Apps switch controls them together.
The configurator is deliberately narrow: it changes only the provider needed to
send newly started local sessions through Maximal.

The Maximal configurator does not run Codex or issue an inference request during
configuration, detection, enable, disable, reconciliation, or verification.
Detection only inspects expected filesystem artifacts. A `codex.cmd` file can
identify a Windows npm install, but Maximal never executes it.

## Owned Codex settings

Codex reads the user file at `$CODEX_HOME/config.toml`, or
`~/.codex/config.toml` when `CODEX_HOME` is unset. Maximal owns only:

1. the top-level `model_provider` selector; and
2. one uniquely named `[model_providers.<id>]` table plus its `auth` subtable.

The provider points at `http://127.0.0.1:4141/v1`, uses the Responses wire API,
and describes an inert command-backed API-key lookup. Maximal writes that
command and its arguments as data; it does not invoke the helper while
configuring Codex. Codex may invoke Maximal's helper later when it needs a key.

### Never changed

Maximal never changes Codex model, review, reviewer, approval, sandbox, trust,
login, authentication, cloud, MCP, feature, project, or profile settings. It
does not copy, mutate, or depend on Codex's private model catalog or automatic
review mechanism.

The guarantee applies to a newly started **local** Codex session whose effective
provider comes from the user-level default. Restart Codex and start a new local
session after enabling or disabling routing. Explicit command-line, admin,
project, or profile overrides may take precedence. Cloud or remote execution is
outside this integration and may not use the local user configuration.

## Ownership, reversal, and recovery

Maximal records versioned ownership metadata in comments beside the managed
provider. The metadata retains the original top-level selector, the chosen
provider ID, and a semantic fingerprint of the owned values. Apply and revert
preserve unrelated bytes, comments, ordering, quote style, and newline style.
Repeated apply is a no-op when the effective owned state is already current.

On disable or shutdown, Maximal restores the original selector and removes only
provider content that still matches its ownership record. A file created solely
by Maximal is removed after a complete revert. A pre-existing file is restored
byte-for-byte when its owned content has not changed.

If a person or another tool changes or references owned content after setup,
Maximal preserves that content and reports `cleanup-required` instead of
claiming success. Review the user-level `config.toml`, identify the provider ID
inside the `# >>> maximal codex routing` ownership block, and manually remove or
repair only that routing entry. Damaged, partial, or duplicate ownership markers
are a hard conflict: Maximal does not guess which content is safe to remove.

Routing intent is stored in Maximal's validated `config.json` under
`apps.codex.enabled`. Boot reapplies routing only when that intent is true.
Normal shutdown temporarily reverts the owned routing while preserving intent
for the next boot.

## Generic model mappings

`modelMappings` in Maximal's `config.json` aliases requested model IDs before
live model lookup on the root Messages, Responses, Chat Completions, and token
counting ingress routes. This facility is generic and is not tied to Codex.
Provider-scoped routes are excluded, and aliases are not advertised by
`/v1/models`.

Rules are ordered. First match wins, matching is case-sensitive, and resolution
is one pass: a mapped target is not mapped again. Exact and glob match the whole
model ID. Glob supports only `*` and `?`. Regex also matches the whole ID and
allows either no flags or the `u` flag.

A config missing `modelMappings` is backfilled with this editable default:

```json
{
  "modelMappings": [
    {
      "match": {
        "type": "exact",
        "value": "codex-auto-review"
      },
      "target": "gpt-5.6-luna"
    }
  ]
}
```

An explicit array replaces the default; an explicit `[]` disables mappings. A
matched target must exist in the live catalog, be enabled, and support the
incoming endpoint. If it does not, Maximal returns a structured local HTTP 400
and does not send the alias or target upstream.
