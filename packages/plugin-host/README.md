# @stuffbucket/maximal-plugin-host

The cordis-backed implementation of `PluginGateway`
(`@stuffbucket/maximal-plugin-sdk/gateway`). Only the composition root
(`src/lib/plugins/compose.ts`) imports this package; the rest of the app sees
the cordis-free gateway seam. Plugins are trusted in-process code: cordis
scopes their resources but does not sandbox them.

```ts
import { createPluginHost } from "@stuffbucket/maximal-plugin-host"
import * as workiq from "@stuffbucket/maximal-plugin-workiq"

const gateway = createPluginHost({
  plugins: [workiq],                                   // static first-party set
  services: { host: { openExternal, logger, appVersion }, storageRoot: path.join(appDir, "plugins") },
})
await gateway.reconcile(config.plugins)               // start what is enabled
// … on settings change: await gateway.reconcile(next.plugins)
// … on shutdown:        await gateway.dispose()
```

## Behaviour

- **Construction** validates every module (shape, id pattern, duplicate ids,
  `inject` ⊆ `tools`/`surface`/`storage`/`host`) and throws
  `PluginContractError` on a bad list. Everything starts `disabled`.
- **`reconcile(settings)`** is serialised. Per plugin: `enabled !== true` ⇒
  stop (fiber disposed; tools, actions, status vanish). Enabled ⇒ validate
  `config ?? {}` against `Config` (Standard Schema, sync or async); invalid ⇒
  `failed` with path-qualified `error` (`workiq.endpoint: Invalid URL`);
  otherwise `starting` → `ctx.plugin()` → `active`, or `failed` if `apply`
  throws (partial contributions withdrawn). A changed config (compared as
  key-sorted JSON) reloads the plugin; an unchanged one is left alone, even
  when `failed` — toggle `enabled` to retry. Failures never affect other
  plugins. Unknown ids in settings are ignored.
- **Tools**: `listTools` / `callTool` reach only `active` plugins. The call
  signal also aborts when the plugin stops. A throwing tool resolves to
  `{ isError: true, content: [{ type: "text", text: message }] }`.
- **Errors**: `PluginGatewayError` with `code` `unknown-plugin`,
  `plugin-inactive`, `unknown-tool`, or `unknown-action`.
- **Events**: `subscribe` delivers `{ type: "lifecycle" | "status" | "tools", pluginId }`;
  listener exceptions are logged and contained.
- **Storage**: `<storageRoot>/<id>/` created 0700 on first write; files
  written to a temp file with mode 0600 and renamed into place.
- **Logging**: cordis-reported failures (apply, disposers) and invalid
  configs go to `services.host.logger`.
- **`dispose()`** stops every plugin and the root context; idempotent; later
  `reconcile` calls are no-ops.

Writing a plugin: see the SDK README.
