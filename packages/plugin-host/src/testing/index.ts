/**
 * `@stuffbucket/maximal-plugin-host/testing` — run plugins through their
 * whole lifecycle under the real host and record what crosses the plugin
 * boundary (`createLifecycleHarness`), the generic contract checks every
 * plugin package runs (`runPluginConformance`, bun:test), and the pieces
 * both use: transcript normalisation and Bun-friendly leak tracking.
 */
export { type ConformanceOptions, runPluginConformance } from "./conformance"
export {
  createLifecycleHarness,
  type FiberStateName,
  formatEntry,
  type LifecycleHarness,
  type LifecycleHarnessOptions,
  type PluginContributions,
  type SettingsChange,
  settingsChanges,
  type TranscriptEntry,
  type TranscriptKind,
  type WaitOptions,
} from "./harness"
export { type HandleTracker, type LiveHandle, trackHandles } from "./leaks"
export { findSecrets, Normalizer, type NormalizerOptions } from "./normalize"
