/**
 * Read-only diagnostics page (spec §1.7) — the safe browser debug affordance.
 *
 * A standalone, **mutation-free** page served under the unauthenticated `/ui`
 * prefix. CSRF-safe *by construction*: it renders `buildDebugState()` (the same
 * data as `maximal debug --json` / `GET /_debug/state`) as static server-rendered
 * HTML with no forms, no fetch, and no client JS — there is nothing to protect.
 * It shows secret **sources** (never values, guaranteed by `collectSecretStatuses`),
 * runtime/health, config summary, executor, caches, version, and the raw state
 * tree. Free to open in any browser; it does NOT join the tray/WS-registry flow.
 */
import type { buildDebugState } from "~/routes/debug/route"

type DebugState = ReturnType<typeof buildDebugState>

/** Escape a value for safe interpolation into HTML text/attributes. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

/** Render the secret-source table — names + `<source>` tags, never values. */
function renderSecrets(secrets: DebugState["secrets"]): string {
  const rows = secrets
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.name)}</td><td><code>&lt;${escapeHtml(
          s.source,
        )}&gt;</code></td></tr>`,
    )
    .join("")
  return `<table><thead><tr><th>secret</th><th>source</th></tr></thead><tbody>${rows}</tbody></table>`
}

/**
 * Render the full read-only diagnostics document. Pure: state in → HTML string
 * out, every interpolated value escaped. The raw state tree is pretty-printed
 * into an escaped `<pre>` (the debug view removed from Usage, §4).
 */
export function renderDiagnosticsPage(data: DebugState): string {
  const version =
    data.git.branch ? `${data.git.sha} (${data.git.branch})` : data.git.sha
  const rawTree = escapeHtml(JSON.stringify(data, null, 2))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Maximal diagnostics</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem; max-width: 60rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
  p.sub { margin: 0 0 1.5rem; opacity: 0.7; }
  h2 { font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; margin: 1.5rem 0 0.5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.25rem 0.75rem 0.25rem 0; }
  th { opacity: 0.6; font-weight: 600; }
  code { font-family: ui-monospace, monospace; }
  pre { overflow: auto; padding: 1rem; border-radius: 8px; background: rgba(127,127,127,0.12); }
</style>
</head>
<body>
<h1>Maximal diagnostics</h1>
<p class="sub">Read-only. Version <code>${escapeHtml(version)}</code>. Secret values are never shown — only their source.</p>

<h2>Runtime</h2>
<pre>${escapeHtml(JSON.stringify(data.runtime, null, 2))}</pre>

<h2>Executor</h2>
<pre>${escapeHtml(JSON.stringify(data.executor, null, 2))}</pre>

<h2>Secret sources</h2>
${renderSecrets(data.secrets)}

<h2>Raw state</h2>
<pre>${rawTree}</pre>
</body>
</html>`
}
