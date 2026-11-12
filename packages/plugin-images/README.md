# @stuffbucket/maximal-plugin-images

The images capability plugin for maximal (`kind: "model"`, on by default).

## What it serves

- `images.generations` and `images.edits` (`/v1/images/generations`,
  `/v1/images/edits`), relayed unchanged to the bound provider model
  (default: `gpt-image-2.5-flare` on Copilot). JSON or multipart edits.
- Two Claude Code **server tools**, offered on every agent turn of Claude Code
  (hidden from the client, fixed descriptions so the prompt cache holds):

| Tool | Input | Does |
|---|---|---|
| `generate_image` | `prompt`, `size` (WxH, default `1024x1024`, clamped to the model's rules), `quality` (`low` default, `medium`, `high`), `n` (1 to 4), `output_format` (`png` default, `jpeg`, `webp`) | generates, saves, returns paths |
| `edit_image` | the same, plus `images`: 1 to 4 absolute paths of `.png` / `.jpg` / `.webp` files | edits or combines them, saves the result as a new file, returns paths |

Config: `generateImage` and `editImage` (both on) switch each tool, `outputDir`
overrides the output folder, `bindings` the served models.

## Where files go

`<app dir>/plugins/images/output/` (the plugin's `ctx.storage.dir`, under
`output/`), or `outputDir`. Files are `<yyyyMMdd-HHmmss>-<shortid>.<ext>`,
written atomically with mode 0600 in a 0700 folder. The tool answers with the
paths (text plus `structuredContent`); **no image data goes into the model's
context**. The originals an edit reads are never changed.

## What `edit_image` will read

Only image files: an absolute path, no `..` segment, extension `.png`, `.jpg`,
`.jpeg` or `.webp`, first bytes matching that image type, a regular file of at
most 20 MB, and a symlink only if it stays inside its own folder. This is not
a folder allowlist (that can come later); it keeps a prompt-injected model from
uploading `~/.ssh/id_rsa` or anything else that is not a picture.

## Money

Each call is billed to the provider. The tool declares its operation, quality
and count (`estimate`); the app core holds that estimate (about 0.6 credits for
one low-quality generation, 1.4 for an edit) against every budget limit that
covers it, refuses the call as the tool's result when a limit has no room, and
books what the provider billed (`call.reportSpend`) as usage under the
`images` plugin.

The **first billed call waits for the person's approval**: it is refused with a
plain message for the model to relay, and the plugin raises a notification, a
menu-bar tray item and a Settings action ("Allow image tools"). The approval is
saved in the plugin's storage (`approval.json`) and holds from then on.
