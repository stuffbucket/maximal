# Translation catalogs

Twelve locales, rescued from `shell/src/i18n/` when the Tauri shell was
retired. The translation work is the asset here; the shell that consumed it
is gone.

## Why they sit at the repository root

They are maximal-specific UI strings, so they do not belong in the generic
Electron shell — that repository is deliberately maximal-agnostic. They also
have no consumer yet: the maximal client that will render them is still being
built. The root is the neutral place to hold them until it exists.

## What was not kept

`apply.ts`, `index.ts` and `ui/i18n/useT.ts` were left behind on purpose. They
were DOM- and Tauri-coupled loader wiring, not translations, and a client on
another shell needs its own. The catalogs are plain JSON and carry no such
coupling.

`en.json` is the source catalog every other file is keyed against.
`en-GB.json`, `es-ES.json` and `es-MX.json` are regional overlays and hold only
the keys that differ from their base locale, which is why they are small.

## Before wiring these up

Read [`docs/dev/i18n.md`](../docs/dev/i18n.md), and ask the i18n expert named
in [`CONTRIBUTORS.md`](../CONTRIBUTORS.md). The catalog-parity test that used
to guard key drift between locales went with the shell; a client that consumes
these should bring an equivalent back.
