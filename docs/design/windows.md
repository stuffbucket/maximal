# Windows: Electron workspace + legacy shell

The Electron client is maximal's canonical desktop surface. Its renderer owns the
workspace composition; native Electron window management owns titlebar, focus,
position, and secondary-window behavior. The legacy Tauri/proxy-served shell
remains supported during migration, but it no longer defines new window
architecture.

Both implementations consume the same neutral design source. This document
codifies what must remain shared while composition moves incrementally.

## What's shared

- Dark-first with light + system override (`prefers-color-scheme`).
- Crimson `--brand` for identity; warm bronze `--accent` for interactive
  surfaces; cool slate `--link` for prose links.
- Fraunces + Commissioner pairing, with Fraunces rationed to the brand mark and
  one display heading per window.
- One token vocabulary (see [`tokens.md`](tokens.md)), generated from
  [`ui/theme.ts`](../../ui/theme.ts) into both renderer targets.
- One neutral self-hosted font source under `ui/assets/fonts`, packaged by both
  desktop pipelines.

## Electron workspace

The workspace is a desktop tool, not a responsive web dashboard. Its titlebar,
persistent panels, controls, and dialogs use the structural tokens documented in
[`tokens.md`](tokens.md). Layout should feel spatial and task-oriented: panels
exist for durable navigation or inspection, while cards remain reserved for
entities a person can act on.

The desktop titlebar identifies the window. Content headings identify the current
section or task and must not repeat the app/window name.

## Legacy shell during migration

The legacy settings surface continues to consume
`shell/src/ui/styles/tokens.css`; the Electron renderer consumes
`client/src/renderer/styles/tokens.css`. Both files are generated from the same
neutral source and must be regenerated together.

Legacy standalone HTML may still need build-time asset staging because it boots
outside a renderer bundle. Do not create another source copy: package neutral
assets into the legacy runtime location instead. Existing inline-value exceptions
remain migration debt and do not establish precedent for Electron code.
