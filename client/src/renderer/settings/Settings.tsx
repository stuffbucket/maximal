import type { ReactElement } from 'react'

import { AccountSection } from './AccountSection'
import { AccountsSection } from './AccountsSection'
import type { SettingsCapabilities } from './capabilities'
import { ConnectionSection } from './ConnectionSection'

// The Settings surface. Composition only: this file owns the page heading and
// the section order; each section owns its own data lifecycle against
// `SettingsCapabilities`. Mounting (which window/tab hosts this, and building
// the capabilities instance via `createCoreSettingsCapabilities`) is
// deliberately somebody else's decision — this module exports a component and
// touches no root, mirroring workspace/Workspace.tsx.
//
// One primary heading per view: the "Settings" h1 below is the only h1 this
// surface renders; each section heading is an h2.

interface SettingsProps {
  capabilities: SettingsCapabilities
}

export function Settings({ capabilities }: SettingsProps): ReactElement {
  return (
    <div className="settings">
      <h1 className="settings__heading">Settings</h1>
      <AccountSection capabilities={capabilities} />
      <AccountsSection capabilities={capabilities} />
      <ConnectionSection capabilities={capabilities} />
    </div>
  )
}

// ---- Styles ----
//
// Injected once on import (guarded by element id so Vite HMR reloads don't
// pile up duplicate <style> tags — same pattern as workspace/RunCard.tsx and
// workspace/Inspector.tsx). Every child component in this directory only
// references these classnames; this file is the single place the rules are
// declared, so there is one source to check for drift rather than one per
// section. Values reference the `--shell-*` custom-property contract
// `stuffbucket-electron` publishes (see that package's README "Consume the
// shell frame" section), with the same "sensible fallback" idiom the
// workspace components use — this package ships no palette by design, so a
// host that defines no theme still renders something legible.
const SETTINGS_CSS = `
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-5, 24px);
  padding: var(--shell-space-4, 16px);
  max-width: 640px;
  color: var(--shell-text, #f5f5f5);
}

.settings__heading {
  margin: 0;
  font-size: 1.3em;
  font-weight: 600;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-3, 12px);
  padding-top: var(--shell-space-4, 16px);
  border-top: 1px solid var(--shell-border, #2a2a2a);
}

.settings-section:first-of-type {
  padding-top: 0;
  border-top: none;
}

.settings-section__heading {
  margin: 0;
  font-size: 1em;
  font-weight: 600;
}

.settings-field {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--shell-space-2, 8px);
}

.settings-note {
  margin: 0;
  font-size: var(--shell-text-sm, 0.9em);
  color: var(--shell-text-muted, #8a8a8a);
}

.settings-note--warning {
  color: var(--shell-warning, #eab308);
}

.settings-note--error {
  color: var(--shell-danger, #ef4444);
}

.settings-details {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-1, 4px);
  margin: 0;
}

.settings-details__row {
  display: flex;
  align-items: baseline;
  gap: var(--shell-space-2, 8px);
}

.settings-details__row dt {
  margin: 0;
  min-width: 9em;
  font-size: var(--shell-text-sm, 0.9em);
  color: var(--shell-text-subtle, #6a6a6a);
}

.settings-details__row dd {
  margin: 0;
  font-size: var(--shell-text-sm, 0.9em);
  color: var(--shell-text, #f5f5f5);
}

.settings-button {
  padding: var(--shell-space-2, 8px) var(--shell-space-3, 12px);
  border: 1px solid var(--shell-border, #2a2a2a);
  border-radius: var(--shell-radius-small, 4px);
  background: transparent;
  color: var(--shell-text, #f5f5f5);
  font: inherit;
  font-size: var(--shell-text-sm, 0.9em);
  cursor: pointer;
  transition: background-color 150ms ease-out, border-color 150ms ease-out;
}

.settings-button:hover:not(:disabled) {
  background: var(--shell-hover, rgb(255 255 255 / 0.04));
}

.settings-button:disabled {
  cursor: default;
  opacity: 0.6;
}

.settings-button--primary {
  border-color: var(--shell-accent, #5198a6);
  color: var(--shell-accent, #5198a6);
}

.settings-button:focus-visible,
.settings-link-button:focus-visible {
  outline: 2px solid var(--shell-focus, var(--shell-accent, #5198a6));
  outline-offset: 2px;
}

.settings-link-button {
  padding: 0;
  border: none;
  background: none;
  color: var(--shell-accent, #5198a6);
  font: inherit;
  font-size: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.settings-device-code {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--shell-space-2, 8px);
}

.settings-device-code__instructions {
  margin: 0;
  font-size: var(--shell-text-sm, 0.9em);
  color: var(--shell-text-muted, #8a8a8a);
}

.settings-device-code__code {
  margin: 0;
  padding: var(--shell-space-2, 8px) var(--shell-space-4, 16px);
  border-radius: var(--shell-radius, 6px);
  background: var(--shell-hover, rgb(255 255 255 / 0.06));
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 1.5em;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.settings-device-code__link-row {
  margin: 0;
}

.settings-device-code__status {
  margin: 0;
  font-size: var(--shell-text-sm, 0.9em);
  color: var(--shell-text-muted, #8a8a8a);
}

.settings-device-code__actions {
  display: flex;
  gap: var(--shell-space-2, 8px);
}

.settings-accounts-list {
  display: flex;
  flex-direction: column;
  gap: var(--shell-space-2, 8px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.settings-accounts-list__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--shell-space-3, 12px);
  padding: var(--shell-space-2, 8px) 0;
}

.settings-accounts-list__identity {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.settings-accounts-list__login {
  font-size: var(--shell-text-sm, 0.9em);
  font-weight: 600;
  color: var(--shell-text, #f5f5f5);
}

.settings-accounts-list__meta {
  font-size: 12px;
  color: var(--shell-text-subtle, #6a6a6a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-accounts-list__active-badge {
  flex: none;
  padding: 2px var(--shell-space-2, 8px);
  border: 1px solid var(--shell-border, #2a2a2a);
  border-radius: var(--shell-radius-small, 4px);
  font-size: 12px;
  font-weight: 500;
  color: var(--shell-success, #22c55e);
  white-space: nowrap;
}

.settings-connection-row {
  display: flex;
  align-items: center;
  gap: var(--shell-space-2, 8px);
  flex-wrap: wrap;
}

.settings-connection-row__value {
  padding: var(--shell-space-2, 8px) var(--shell-space-3, 12px);
  border-radius: var(--shell-radius-small, 4px);
  background: var(--shell-hover, rgb(255 255 255 / 0.06));
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: var(--shell-text-sm, 0.9em);
  user-select: all;
}

.settings-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .settings-button {
    transition-duration: 0.01ms;
  }
}
`

const SETTINGS_STYLE_ID = 'settings-styles'

if (typeof document !== 'undefined' && !document.getElementById(SETTINGS_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = SETTINGS_STYLE_ID
  style.textContent = SETTINGS_CSS
  document.head.appendChild(style)
}
