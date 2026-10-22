import os from "node:os"
import path from "node:path"

import {
  applyCodexConfigFile,
  type AppliedCodexConfigFile,
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
      "codex",
      options.execPath ?? process.execPath,
    ),
  })
}

export function isCodexProviderConfigured(
  options: CodexProviderOptions = {},
): boolean {
  return isCodexConfigFileConfigured(providerFilePath(options))
}

export function revertCodexProvider(
  options: CodexProviderOptions = {},
): RevertedCodexConfigFile {
  return revertCodexConfigFile(providerFilePath(options))
}
