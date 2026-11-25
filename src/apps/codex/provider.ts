import os from "node:os"
import path from "node:path"

import {
  applyCodexConfigFile,
  type AppliedCodexConfigFile,
  CODEX_KEY_LABEL,
  codexConfigFileConflict,
  isCodexConfigFileConfigured,
  revertCodexConfigFile,
  type RevertedCodexConfigFile,
} from "~/apps/codex/config"
import { apiKeyHelperInvocation } from "~/lib/auth/api-key-helper"

export interface CodexConfigPathOptions {
  codexHome?: string
  homeDir?: string
}

export interface CodexProviderOptions extends CodexConfigPathOptions {
  filePath?: string
  execPath?: string
  profileId?: string
  overrideOtherMaximal?: boolean
}

export function getCodexConfigPath(
  options: CodexConfigPathOptions = {},
): string {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME
  const configDirectory =
    codexHome || path.join(options.homeDir ?? os.homedir(), ".codex")
  return path.join(configDirectory, "config.toml")
}

function providerFilePath(options: CodexProviderOptions): string {
  return options.filePath ?? getCodexConfigPath(options)
}

export function applyCodexProvider(
  options: CodexProviderOptions = {},
): AppliedCodexConfigFile {
  return applyCodexConfigFile(providerFilePath(options), {
    invocation: apiKeyHelperInvocation(
      CODEX_KEY_LABEL,
      options.execPath ?? process.execPath,
    ),
    ...(options.profileId ? { profileId: options.profileId } : {}),
    ...(options.overrideOtherMaximal ? { overrideOtherMaximal: true } : {}),
  })
}

export function isCodexProviderConfigured(
  options: CodexProviderOptions = {},
): boolean {
  return isCodexConfigFileConfigured(
    providerFilePath(options),
    options.profileId,
  )
}

export function codexProviderConflict(
  options: CodexProviderOptions = {},
): "other-maximal-config" | null {
  return codexConfigFileConflict(providerFilePath(options), options.profileId)
}

export function revertCodexProvider(
  options: CodexProviderOptions = {},
): RevertedCodexConfigFile {
  return revertCodexConfigFile(providerFilePath(options), options.profileId)
}
