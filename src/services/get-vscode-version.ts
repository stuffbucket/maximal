// The VS Code version we advertise to Copilot via `editor-version`. Two
// constraints pin this value:
//   1. It must be a REAL released VS Code version (1.124 ships as VS Code
//      Insiders — no spoofing a build that doesn't exist).
//   2. Copilot emits a `client_version_deprecated` / usage-based-billing
//      warning on every model when `editor-version` is below a threshold
//      that sits between 1.105 and 1.124 (verified live, June 2026). 1.124
//      clears it; 1.118 (the prior value) and 1.105 do not.
// Bump this as newer VS Code versions ship to stay current.
const FALLBACK = "1.124.0"

export async function getVSCodeVersion() {
  await Promise.resolve()
  return FALLBACK
}
