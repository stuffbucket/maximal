# Pi model-name and price display

Optional, display-only Pi extension for the model picker shared by Herdr's CLI
and desktop terminals. Both use Pi's ordinary agent directory; there is no
separate Herdr model database to update.

The extension changes the existing `/model` and Ctrl+L picker, not the model
transport or your default selection. The list area becomes a table:

```text
  Model                  Provider  Context  Input   Output   Cache rd   Cache wr
────────────────────────────────────────────────────────────────────────────────
✓ GPT-6.1 Sol  default   maximal     1.05M  $2.00*  $10.00*    $0.10*     $2.50*
  Claude Opus 5.5        maximal        1M  $4.00   $20.00     $0.20      $5.00
  GPT-6 Luna             maximal        1M  $0.10*   $0.50*    $0.01*     $0.125*
────────────────────────────────────────────────────────────────────────────────
  GPT-6.1 Sol   maximal/gpt-6.1-sol   current · default for new sessions
  1.05M context · 128K max output · reasoning · images
  USD / 1M tokens   Input  Output  Cache read  Cache write
  Up to 272K input  $2.00  $10.00       $0.10        $2.50
  Above 272K input  $4.00  $15.00       $0.20        $5.00
```

- The active row has a full-width background: the theme's `selectedBg` tinted
  toward its accent, so it stays visible on dark and translucent terminals,
  plus a bold accent name; there is no cursor glyph. Names start in the same
  column as the search text after Pi's `> ` prompt.
- One status mark: `✓` for the current model. The default model gets a quiet
  `default` word after its name; both are spelled out in the details.
- Readable model names; the API ID appears only in the selected-model details.
- The model column is as wide as the longest name, not the terminal, so prices
  sit next to names on large screens without clipping any name. Only narrow
  terminals shorten names (ending in `…`); the details show the full name and
  search still matches full names and IDs.
- Prices align on the decimal point. `*` (long-context rates apply) sits in
  trailing space and never shifts digits; base rates are shown in the list and
  every tier in the details. Published precision is kept (`$0.125`, `$0.0015`).
- `—` means unknown, not free. Explicitly published zero prices remain `$0.00`.
- Narrow terminals drop cache, provider, then context columns before shrinking
  names; prices are the last to go.
- Native search (names and IDs), scopes, default saving, refresh status/errors,
  navigation and cancellation remain in Pi's implementation.

## Install for both Herdr frontends

Refresh the existing Maximal provider using the account type you use:

```sh
bun run pi:sync --account-type enterprise --write
```

This backs up `models.json` and updates only `providers.maximal.models`.
Then copy `index.ts` and `renderer.ts` from this folder into
`~/.pi/agent/extensions/maximal-model-picker/` (or the same location under
`PI_CODING_AGENT_DIR`). No npm dependencies or settings edits are needed.

In existing Pi sessions in **each** Herdr frontend, run `/reload`, then reopen
`/model` or Ctrl+L. New sessions load it automatically. Reload does not replace
an older Pi executable: start a new Pi session when upgrading Pi itself. Do not
restart Herdr or terminate other sessions just to install this display change.

This extension performs no network requests and changes no credentials, models,
defaults, settings, inference parameters or audio behavior. The sync above is a
**one-shot** catalog update, not background synchronization. For automatic catalog
updates use Maximal's managed Pi integration on a proxy version supporting it;
see [Pi integration](../../docs/dev/pi-integration.md).

## Compatibility and removal

Verified against Pi 1.5.0 and 1.5.2. The exported `ModelSelectorComponent` has no
public row-renderer hook, so this adapter wraps its internal `updateList` method
and, after the native update, replaces the list container's contents with one
table component built from the selector's state (filtered models, selection,
current/default model, error and refresh messages). That
small, version-sensitive seam is deliberate: it avoids replacing the compiled Pi
binary or reimplementing selection/auth/refresh. Missing methods produce a warning;
an unexpected type for any of that state retains the native list. Recheck after Pi upgrades.

Shutdown and `/reload` restore the previous method only if this extension still
owns it. To remove, delete this extension directory and run `/reload` in affected
sessions. Catalog rollback is separate: the sync command prints the private backup
path; restore it only after checking for subsequent user edits.

## Tests

```sh
bun test tests/pi-model-picker.test.ts tests/pi-models.test.ts
```

The renderer tests are host-independent, with no global Pi module mocks. The
extension entry point imports host-provided Pi packages and is tested inside the
installed Pi runtime rather than through Maximal's dependency graph. Validate
narrow/wide terminals, search, scopes, selection/cancellation, default saving and
reload in an isolated agent home when changing the adapter.
