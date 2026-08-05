# Design System — maximal

> Category: Developer tooling / local infrastructure
> A local proxy between developer tooling and the GitHub Copilot API. Dark-first, warm, crafted — a tool made by a person, not a corporation.

> **Provenance.** This file is a synthesized, human-readable snapshot of
> maximal's design system for setting overall direction and writing agent
> prompts. **The canonical source of every value is
> [`ui/theme.ts`](ui/theme.ts)**, generated into the legacy shell and Electron
> renderer `tokens.css` files. Component code and the `docs/design/*.md`
> topic files reference tokens **by name, never by value** — do not inline the
> hex/px shown here into a component. When values below and `theme.ts` disagree,
> `theme.ts` wins. The binding rules live in
> [`docs/design/principles.md`](docs/design/principles.md) and
> [`.design-context.md`](.design-context.md).
>
> The committed re-tone is now canonical: warm bronze owns interaction, cool
> slate owns prose links, and crimson remains identity-only. The source values
> were adjusted from the initial visual target only as needed to clear WCAG AA.

## 1. Visual Theme & Atmosphere

maximal's interface is the opposite of a marketing splash — it's a **background utility that respects you**. It sits between your developer tooling and the Copilot API, and its UI exists only for the moments where typing is the wrong tool: first-run auth, the occasional "what's it doing" usage peek, a settings tweak. The design personality is **warm + crafted + considered**: friendly without being playful-cute, confident without being terminal-stark. The brand mark — a brand-crimson rounded square holding a slightly wonky Fraunces "m" — sets the whole tone. It reads as handmade, and the entire system is built to preserve that feeling.

The aesthetic is defined by two acts of discipline, not two acts of excess. First, **restraint over decoration**: layout, type, and spacing carry the feeling; color is one surface, not the only surface. There is no hero gradient, no display type shouting from the rooftop, no pill-everything geometry. Second, a **hard split between identity and interaction**: crimson is brand-only (mark, hero, badging) while a warm bronze accent owns every interactive surface (buttons, switches, focus rings, active nav). This split is the single most important decision in the system — it's what keeps the UI from feeling shouty.

What makes maximal distinctive is its **humanist-powerful** register: dense with capability but never overwhelming. It never pushes machine concerns onto humans (no raw config keys, no JSON dumps in the primary UI) and never pushes human concerns into machine shapes (no chat UI for what should be one button). It's dark-first and editorial in its type pairing (Fraunces + Commissioner). User color controls are planned, with a binding requirement to measure and warn about contrast before those controls ship.

**Key Characteristics:**
- Dark-first surface (`#0a0a0a` base) with a full light theme + `system` default
- **Identity/interaction color split**: crimson `--brand` (`#c8334a`) is identity ONLY; warm bronze `--accent` (`#9c6025`, re-toned off teal) is every interactive surface
- Fraunces (display serif) + Commissioner (humanist sans) editorial pairing — Fraunces rationed to the brand mark + **one** display heading per window
- Restraint over decoration: type, space, and rhythm do the work; no gradients, no shadows-as-decoration
- Canonical accent + surfaces are verified in both themes; future user color controls must compute contrast, warn, and never block
- One humanist accent per window — the brand "m" appears once, near the heading, never on every row
- Comfortable density: line-height ≥ 1.4 for body, generous section gaps, real row padding
- Cards mean *entities you can act on*, never page sectioning (that's typography's job)
- Motion is utility, not delight — 120–200ms ease-out, and `prefers-reduced-motion` is honored literally
- Sentence case everywhere; human-tone copy ("We can't reach the proxy," not "ECONNREFUSED")

## 2. Color Palette & Roles

Four brand/interaction roles are deliberately split so no single color floods the surface. Surface and text roles resolve per theme via `[data-theme]`.

### Primary
- **Brand Crimson** (`#c8334a`, `--brand`): The core identity color. Used **only** for the brand mark, hero moments, badging, and the tray attention dot — **never** for buttons, links, or focus rings. Foreground on brand fill is `--brand-fg` (`#ffffff`).
- **Accent Bronze** (`#9c6025`, `--accent`): Every interactive surface — primary button fill, switch "on" state, focus rings, active sidebar nav. Warm, crafted, and deliberately **not teal** (which reads generic-AI). Hover shifts to `#a56727`. Foreground on both accent fills stays `--accent-fg` (`#ffffff`); both clear AA.
- **Destructive Crimson** (`#b32d3f`, `--accent-destructive`): Destructive actions only (delete/destroy). Crimson-adjacent but deliberately **a hair deeper than `--brand`** so it reads as "caution," not "identity." Foreground `--accent-destructive-foreground` (`#ffffff`).

### Links (cool, distinct from both warm roles, per-theme)
- **Link**: dark `#86adc4` (hover `#a8c8db`) / light `#35617a` (hover `#274f66`) — a muted, low-chroma slate-blue. Prose links only. With the interactive accent now **warm** bronze, links go **cool** on purpose — the old "sister to accent" rule flips to "distinct from *both* warm roles" so an inline prose link never reads as brand identity *or* as a primary action. Every pairing clears WCAG AA against both `--surface-base` and `--surface-card` in its theme.

### Surface (per theme — 3 levels)
| Role | Dark | Light | Use |
|------|------|-------|-----|
| `--surface-base` | `#0a0a0a` | `#fafafa` | Window background (`body`) |
| `--surface-card` | `#161616` | `#ffffff` | Cards, sidebar fill (contrast computed against this) |
| `--surface-control` | `#1f1f1f` | `#f0f0f0` | Form controls, secondary buttons |

Light steps cards *forward* of base; dark steps the same direction. Runtime user overrides are not currently shipped.

### Text (per theme)
| Role | Dark | Light | Use |
|------|------|-------|-----|
| `--text-strong` | `#f5f5f5` | `#0a0a0a` | Headings, primary body |
| `--text-base-color` | `#d4d4d4` | `#2a2a2a` | Body prose |
| `--text-muted` | `#8a8a8a` | `#6a6a6a` | Helpers, captions, group labels |

### Borders (per theme)
- **`--border-subtle`** (dark `#2a2a2a` / light `#e5e5e5`): hairline separators, card borders.
- **`--border-strong`** (dark `#666666` / light `#8a8a8a`): input borders, emphasized rules.

### Status
Each status has a theme-independent solid marker and soft fill. Its `-fg`
pairing changes by theme so semantic text and icons clear AA on the matching
soft fill; use the generated tokens rather than copying a dark-theme value.

### Data-visualization palette (Usage charts, theme-independent on `:root`)
Encodes **token TYPE**, not interactive state — deliberately not `--accent`, never `--brand`. Mid-tone for dual-theme legibility. (With the interactive accent now bronze, `--viz-input` teal is the system's only teal — which is fine: viz color is chart-only and never an interactive surface.) Coarse 3-way split (input / output / cache) plus a finer 4-way cache split for the live tracker and traffic graphs, on a **cool = fresh, warm = cached** scheme:
- **`--viz-input`** `#3f9aa8` (teal, fresh input) · **`--viz-output`** `#7b6fd0` (indigo, fresh output)
- **`--viz-cache`** `#8a8f98` (slate — the calm neutral for aggregated cache in the proportion + per-model bars)
- **`--viz-cache-read`** `#c68a3c` (amber, cached input) · **`--viz-cache-creation`** `#c56b86` (rose, cached output)

### Contrast contract
- **Target WCAG AA (4.5:1)** for text and 3:1 for focus indicators; AAA where reachable.
- The shipped canonical palette is statically verified against both surface levels in both themes.
- Before user color controls ship, they must measure text and focus contrast and **surface a warning chip** near any affected control below threshold.
- **Never block.** Be honest about the consequence, then defer to the user. The brand mark stays crimson in dock/tray regardless — that's identity, not preference.

## 3. Typography Rules

### Font Family
- **Display**: `"Fraunces"`, fallbacks `Georgia, "Times New Roman", serif`
- **Body / UI**: `"Commissioner"`, fallbacks `"Segoe UI", Helvetica, Arial, sans-serif`
- **Mono**: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`

Both Fraunces and Commissioner are **self-hosted** WOFF2 in production (bundled with the Vite output) so the webview never makes an external request — preserving offline operation and the no-telemetry posture.

### Ramp — 16px base, 1.2 ratio

| Token | Size | Role |
|-------|------|------|
| `--text-xs` | 0.75rem (12px) | Caption, footnote, helper text |
| `--text-sm` | 0.875rem (14px) | Inline labels, dense Settings rows, descriptions, button labels |
| `--text-base` | 1rem (16px) | Body, inputs, control labels. **Floor for multi-line prose.** |
| `--text-md` | 1.125rem (18px) | Lead body for single-section windows (Setup, Dashboard) |
| `--text-lg` | 1.25rem (20px) | Subhead, active sidebar-nav item |
| `--text-xl` | 1.5rem (24px) | Section heading inside a window (`h2` / `.h-section`) |
| `--text-2xl` | 2rem (32px) | Window heading (`h1` / `.h-display`) |
| `--text-3xl` | 2.5rem (40px) | Display — onboarding moments only |
| `--text-4xl` | 3rem (48px) | Hero display — rare (e.g. the Welcome state) |

### Weights (by role, not number)
- `--weight-base` **400** — body default
- `--weight-md` **500** — emphasis, button label, active sidebar-nav item
- `--weight-lg` / `--weight-xl` **600** — section headings
- `--weight-2xl` **700** — window headings

**No thin weights (100–300)** — they read thin on dark. **No 900** — too heavy for warm + crafted. If a moment wants either, the answer is a different *size*, not a different weight.

### Leading & tracking
- Leading: `--leading-base` **1.6**, `--leading-lg` **1.4**, `--leading-xl` **1.3**, `--leading-2xl` **1.2**. Pair each `--text-*` with its matching `--weight-*` and `--leading-*` — don't hand-tune.
- Tracking: `--tracking-xl` **-0.01em**, `--tracking-2xl` **-0.015em** (headings tighten slightly); `--tracking-caps` **0.02em** for the rare uppercase micro-label.

### Principles
- **Fraunces is rationed.** It lives in the brand mark and **one** display heading per window — no more. Excess Fraunces is noise; one Fraunces moment is character.
- **Commissioner does the heavy lifting** at 400 for body and 500–600 for emphasis and headings.
- **Sentence case for everything user-facing** — headings, buttons, menu items, labels. **No ALL CAPS** (too marketing). Title Case only for proper nouns ("GitHub Copilot").
- **Mono** (`--font-mono`) is for code samples (the `curl` block), inline API keys, the Setup device code, file paths, and in-place updating numerics. **Always `tabular-nums`** with updating values so columns don't dance.
- **Body floor is `--text-base` (16px)** for multi-line prose; max line length `65ch` on prose containers (code/sample blocks exempt and allowed to scroll).
- **Emphasis is bold *or* italic, never both.** Italics only for a rare phrase or quoted user input, never for UI labels.

## 4. Component Stylings

Where a token exists, component CSS references it by name. Dimensions below that aren't tokenized are canon in [`docs/design/components.md`](docs/design/components.md) — match them exactly.

### Buttons
| Variant | Height | Padding (h) | Font | Weight | Fill / border |
|---------|--------|-------------|------|--------|---------------|
| **Primary** | 36 | 16 | `--text-sm` | 500 | `--accent-fg` on `--accent` |
| **Secondary** | 36 | 16 | `--text-sm` | 500 | `--border-width-thin` outline, transparent fill |
| **Ghost** | 32 | 12 | 13px | 500 | No outline; hover → `--surface-control` |
| **Icon** | 32×32 | — | — | — | 18px icon centered |
| **Small** | 28 | 12 | 13px | 500 | Sparingly; dense rows only |
| **Destructive** | 36 | 16 | `--text-sm` | 500 | `--accent-destructive-foreground` on `--accent-destructive` |

Radius `--radius-input` (6px) on all. **Primary is the bronze `--accent`, never crimson.**

### Inputs & Forms
| Control | Height | Notes |
|---------|--------|-------|
| Text | 36 | `--border-width-thin` border, focus ring offset 2px |
| Textarea | min 96 | Resize vertical only |
| Select | 36 | Right-side chevron 16px |
| Switch | 24×16 | iOS-style; 200ms ease; "on" = `--accent` |
| Checkbox | 16×16 | 2px stroke |

- Surface: `--surface-control`; radius `--radius-input`.
- **Form rows**: min height 48px; label column ~210px (Settings) or ~33% of content elsewhere; control column the remainder. Right-align only visually right-anchored controls (toggles, dropdowns); left-align text inputs.

### Cards & Containers
- **A card means one discrete entity you can act on as a unit** (a provider, an API-key row, a connected account) — not a page section.
- Padding `--space-4` × `--space-5` (16 × 20); gap between stacked cards `--space-4` (16); internal row gap `--space-3`/`--space-4`.
- Background `--surface-card`; border `--border-width-thin` solid `--border-subtle`; radius `--radius-card` (8px); shadow `--elevation-card` **in light mode only** (dark relies on the surface step).
- **Card nesting is forbidden.** Collapse the inner to a list-row, or make the outer a typographic section.

### Sidebar (unified app nav)
- Width `--sidebar-width` (200px), fixed. Fill `--surface-card`.
- Nav item 36px tall, 8px vertical / 12px horizontal padding; weight 400 → **500 on active**.
- **Active state is a 1px-rounded surface step, not a left bar** (a left bar reads dev-tool; the surface step reads humanist).
- Group label: 12px, weight 500, `letter-spacing 0.02em`, uppercase, `--text-muted` — one per group, never per item.

### Focus rings
- **`:focus-visible` only** — visible on keyboard nav, hidden on mouse. Using `:focus` alone is a bug.
- One canonical treatment everywhere: `--focus-ring` → `2px solid var(--accent)`, offset 2px, applied as `outline: var(--focus-ring)`. **No box-shadow variant, no per-surface ring.** The canonical accent clears 3:1 on every shipped surface; future user accents require runtime validation and warning before they can override it.

### Iconography
- **Functional icons:** monochrome, system-tinted, ~1.5–2px stroke at 16/20/24 (Lucide or Phosphor — pick one).
- **Identity accent:** the brand "m" appears once per window near the heading.

### Distinctive components

**Brand mark** — a brand-crimson (`--brand`) rounded square holding a slightly wonky Fraunces "m." The one place crimson is identity. Appears once per window.

**Tray icon (macOS)** — deliberately **colored, not template** (22pt viewBox, 44px @2x). Crimson reads on both light and dark menu bars. **Attention state:** white squircle with a transparent "m" cutout and a crimson dot — a single-glance affordance that survives macOS tinting.

**`curl` / code block** — `--font-mono`, `--surface-control` fill, `--radius-card`, allowed to scroll horizontally. Primary content in the Connect section, not decoration.

**Activity feed** — humanist-tone event rows with numeric tails in `--font-mono` + `tabular-nums` so live counters, durations, and timestamps don't jitter.

**Usage charts** — traffic stream, trend area, and proportion/breakdown bars colored by the `--viz-*` token-type palette (cool = fresh, warm = cached). Never `--accent`, never `--brand`.

**Contrast warning chip (planned)** — a small status chip near a future user-color control when its combination drops below WCAG AA. Warns, never blocks.

**Splash window** — a native, embedded HTML surface for boot + failure recovery. It boots before any bundle, so its explicit brand mirror is synchronized and checked by the token generator.

## 5. Layout Principles

### Spacing System
- Base scale (`--space-*`, **no off-scale values**): `4px, 8px, 12px, 16px, 24px, 32px, 48px, 64px` (`--space-1`…`--space-8`).
- Typical use: `--space-4` card-internal padding + card-to-card gap; `--space-5` section gap / window-edge to content; `--space-6`–`--space-8` inter-section gaps on larger windows.

### Grid & Containers
- **Desktop only — no responsive breakpoints in v1.** The OS enforces min window sizes; there is no mobile fallback.
- **One desktop workspace.** The Electron client is the canonical app surface, with native window chrome and a renderer-owned workspace. Navigation grows from a simple section list into persistent panels only when the information architecture earns them; the legacy shell remains supported during migration but does not define new composition.
- Content max-widths: `--content-max` **640px** for prose panes; `--content-max-wide` **1040px** for data-dense sections (Usage charts/tables earn more width than prose). Sidebar `--sidebar-width` **200px**.

### Whitespace Philosophy
- **Comfortable, not airy.** Slightly more spacious than Raycast, far less airy than Bear. Rows have real padding; section gaps let the eye breathe.
- **Power lives in depth, not density.** Common controls are big and one click away; advanced controls live one level down (collapsible sections, an "Advanced" tab). More sections, not more items per row.

### Border Radius Scale
| Token | Value | Use |
|-------|-------|-----|
| `--radius-chip` | 4px | Chips, count badges |
| `--radius-input` | 6px | Inputs, buttons |
| `--radius-card` | 8px | Cards, code blocks |
| `--radius-pill` | 9999px | Status dots, round/pill badges (text-light only) |

Unlike a pill-everything system, radius here is **functional and small** — the pill is reserved for dots and tiny badges, not general geometry.

## 6. Depth & Elevation

Depth comes primarily from **surface steps and borders**, not decorative shadow. Shadows exist only where a real z-layer needs to lift.

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat (Level 0) | No shadow, `--surface-base` | Window background, text blocks |
| Surface step (Level 1) | `--surface-card` / `--surface-control` + `--border-subtle` | Cards, sidebar, controls |
| Card (Level 2) | `--elevation-card` (`0 1px 2px rgb(0 0 0 / 0.06)`) — **light mode only** | Cards (dark mode uses the surface step instead) |
| Tooltip (Level 3) | `--elevation-tooltip` (`0 2px 6px rgb(0 0 0 / 0.1)`) | Tooltips, popovers |
| Modal (Level 4) | `--elevation-modal` (`0 8px 24px rgb(0 0 0 / 0.18)`) | Modals |

**Don't add a fourth elevation level.** Z-order is a fixed constant table, not tokens: base 0 · sticky header 10 · dropdowns 100 · toasts 200 · modals 300 · tooltips 400 (always on top).

Border widths: `--border-width-hairline`/`-thin` **1px** · `--border-width-thick` **2px** (focus rings, emphasized dividers) · `--border-width-heavy` **4px** (reserved, unused).

## 7. Do's and Don'ts

### Do
- Use crimson `--brand` (`#c8334a`) for **identity only** — mark, hero, badging, tray attention dot
- Use warm bronze `--accent` (`#9c6025`) for **every interactive surface** — primary buttons, switches, focus rings, active nav
- Ration Fraunces to the brand mark + **one** display heading per window
- Let Commissioner carry the body at weight 400, emphasis at 500–600
- Keep everything **sentence case**; write human-tone copy ("We can't reach the proxy")
- Use cards **only** for discrete actionable entities; use typography (heading + space + optional rule) to section a page
- Before user color controls ship, compute text and focus contrast and **warn** with a chip when either drops below its threshold
- Use `--font-mono` + `tabular-nums` for any numbers that update in place
- Use `:focus-visible` with the single canonical `--focus-ring` on every focusable element
- Honor `prefers-reduced-motion` **literally** — animations off, at most a 60ms opacity crossfade

### Don't
- **Don't use crimson for buttons, links, focus rings, or active-nav** — that's the bronze accent's job (this is the #1 regression)
- Don't put a destructive action in `--brand` crimson — use `--accent-destructive`, a hair deeper
- Don't wrap page sections in cards (the "AI-dashboard grid of rectangles"), and **never nest cards**
- Don't add an in-content H1 that duplicates the desktop titlebar / window name
- Don't inline raw `px` / `rem` / `#hex` in a component — add or reference a token
- Don't use thin (100–300) or 900 weights, or ALL CAPS body/labels
- Don't use more than one Fraunces moment per window
- Don't add bounce/spring/elastic curves, parallax, hover scales, or staggered "reveal" cascades
- Don't rely on decorative drop shadows for depth — use surface steps and borders
- Don't add responsive breakpoints in v1 (desktop only; OS enforces min sizes)
- Don't bind `Cmd-K` (reserved, unbound in v1)

## 8. Responsive Behavior

### Breakpoints
**None in v1 — desktop only.** There are deliberately no CSS responsive breakpoints; the OS enforces minimum window sizes and there is no mobile fallback. Layout adapts by *content*, not viewport: the unified app nav grows from a single scroll into a 200px sidebar as sections accrue, gated on section count ("would a user jump to a section by name?"), not pixel width.

### Density & scaling
- Content panes cap at `--content-max` (640px, prose) or `--content-max-wide` (1040px, data-dense). Prose wraps at `65ch`; code blocks scroll horizontally rather than reflow.
- The Electron workspace is the canonical surface. Secondary windows are single-instance when their task is singular, and window position is restored where appropriate.

### Touch targets
- Not a touch target concern in v1 (desktop), but hit targets are generous regardless: 32–36px control heights, 48px form rows, 32px icon-button targets.

### Motion under constraint
- `prefers-reduced-motion: reduce` is a **contract**: all hover scales, slide-ins, fade-ups, and spring physics go **off**; a jarring instant change may substitute a single 60ms opacity crossfade. Honored literally, never "with reduced intensity." A single global `prefers-reduced-motion` block at the bottom of the stylesheet enforces it (`transition-duration: 0ms !important`).

## 9. Agent Prompt Guide

### Quick Color Reference
- Brand identity (mark/badging ONLY): "Brand Crimson `#c8334a` (`--brand`)"
- Interactive (buttons/switches/focus/active-nav): "Accent Bronze `#9c6025` (`--accent`)"
- Destructive actions: "Destructive `#b32d3f` (`--accent-destructive`)"
- Prose links: "Link (cool slate-blue) `#86adc4` dark / `#35617a` light (`--link`, AA verified)"
- Window background: "`--surface-base` — `#0a0a0a` dark / `#fafafa` light"
- Card / sidebar: "`--surface-card` — `#161616` dark / `#ffffff` light"
- Primary text: "`--text-strong` — `#f5f5f5` dark / `#0a0a0a` light"
- Muted text: "`--text-muted` — `#8a8a8a` dark / `#6a6a6a` light"

### Example Component Prompts
- "Create a Settings form row (min height 48px): a ~210px label column in `--text-base` `--text-strong`, a description beneath in `--text-sm` `--text-muted`, and a right-anchored iOS-style switch (24×16, 200ms ease) whose 'on' state fills the bronze `--accent`. Focus ring `2px solid var(--accent)` offset 2px via `:focus-visible`."
- "Design an API-key card: `--surface-card` fill, `--border-width-thin` `--border-subtle` border, `--radius-card` (8px), padding 16×20. Key value in `--font-mono` `tabular-nums`. A Secondary (outline) 'Copy' button (36px, `--text-sm` 500) and a Destructive 'Revoke' button (`--accent-destructive`). Light-mode only shadow `--elevation-card`. Never nest another card inside."
- "Build the brand mark: a `--brand` crimson (`#c8334a`) rounded square holding a slightly wonky Fraunces 'm' in white. Place it once, near the window heading — not on every row."
- "Create a usage traffic chart with an input band in `--viz-input` teal (`#3f9aa8`), output in `--viz-output` indigo (`#7b6fd0`), cached-input in `--viz-cache-read` amber, cached-output in `--viz-cache-creation` rose (cool = fresh, warm = cached). Axis labels in `--text-xs` `--text-muted`. Never use `--accent` or `--brand` for chart color."
- "Design a window heading: Fraunces `--text-2xl` (32px) weight 700, `--tracking-2xl` (-0.015em), `--text-strong`. One per window. Do not add a second Fraunces element."
- "Prototype the planned contrast-warning chip beside a user-color control: measure text at 4.5:1 and focus indicators at 3:1, use `--radius-chip` and the warning status role, and warn without blocking."

### Iteration Guide
1. **Crimson = identity, warm bronze = interaction.** If a button, link, or focus ring is crimson, it's wrong — make it `--accent`.
2. **Fraunces is rationed** — the mark plus one display heading per window, nothing more.
3. **Cards are entities, typography is sectioning.** If it looks like a grid of similar rectangles, drop the cards.
4. **Dark-first**, with a full light theme and `system` default — check both.
5. **Reference tokens by name, never inline hex/px** in a component; add a token first if one's missing.
6. **The user owns color; you own contrast** — when customization ships, compute it, warn below AA, never block.
7. **Motion is utility** — 120–200ms ease-out, no bounce/parallax/hover-scale, and `prefers-reduced-motion` is literal.
8. **Sentence case, human-tone copy** — speak to the person, not the file.
