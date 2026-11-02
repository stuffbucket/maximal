export const SETTINGS_UNSET = "__UNSET__"
export const SETTINGS_ENV_KEY = "env"

export function readSettingsEnv(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const env = settings[SETTINGS_ENV_KEY]
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    return env as Record<string, unknown>
  }
  return {}
}

export function priorField(
  prior: Record<string, unknown>,
  key: string,
): unknown {
  return key in prior ? prior[key] : SETTINGS_UNSET
}

export function withRestoredField(
  target: Record<string, unknown>,
  key: string,
  prior: unknown,
): Record<string, unknown> {
  if (prior === SETTINGS_UNSET) {
    const { [key]: _dropped, ...without } = target
    return without
  }
  return { ...target, [key]: prior }
}
