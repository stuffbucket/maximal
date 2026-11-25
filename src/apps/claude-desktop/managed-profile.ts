/**
 * A macOS managed-preferences profile that routes Claude Desktop (Cowork 3P)
 * at a Maximal gateway, for fleets that push configuration through MDM.
 */

import { randomUUID } from "node:crypto"
import os from "node:os"

import {
  CLAUDE_3P_PREF_DOMAIN,
  gatewayProfile,
  type GatewayProfileValues,
} from "./config"

function plistEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function plistValue(v: unknown, indent: number): string {
  const pad = "  ".repeat(indent)
  if (typeof v === "string") return `${pad}<string>${plistEscape(v)}</string>`
  if (typeof v === "boolean") return `${pad}<${v ? "true" : "false"}/>`
  if (Array.isArray(v)) {
    const items = v.map((x) => plistValue(x, indent + 1)).join("\n")
    return `${pad}<array>\n${items}\n${pad}</array>`
  }
  if (typeof v === "object" && v !== null) {
    const body = Object.entries(v)
      .map(
        ([k, val]) =>
          `${pad}  <key>${plistEscape(k)}</key>\n${plistValue(val, indent + 1)}`,
      )
      .join("\n")
    return `${pad}<dict>\n${body}\n${pad}</dict>`
  }
  throw new Error(`unsupported plist value: ${typeof v}`)
}

export interface ManagedProfileOptions {
  profileUUID?: string
  payloadUUID?: string
  scope?: "User" | "System"
}

/**
 * A managed profile is generated once and pushed to many machines, each with
 * its own local proxy and keys — so it carries a placeholder, never this
 * machine's key. Fleets either run without key enforcement or provision
 * per-machine keys through their MDM.
 */
const MANAGED_PLACEHOLDER_KEY = "anything"

export function generateManagedProfile(
  home: string = os.homedir(),
  values: GatewayProfileValues = {
    ...gatewayProfile(home),
    inferenceGatewayApiKey: MANAGED_PLACEHOLDER_KEY,
  },
  opts: ManagedProfileOptions = {},
): string {
  const profileUUID = opts.profileUUID ?? randomUUID()
  const payloadUUID = opts.payloadUUID ?? randomUUID()
  const scope = opts.scope ?? "User"
  const settings = plistValue(values, 8)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.ManagedClient.preferences</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.maximal.claude3p.mcx</string>
      <key>PayloadUUID</key>
      <string>${payloadUUID}</string>
      <key>PayloadEnabled</key>
      <true/>
      <key>PayloadContent</key>
      <dict>
        <key>${CLAUDE_3P_PREF_DOMAIN}</key>
        <dict>
          <key>Forced</key>
          <array>
            <dict>
              <key>mcx_preference_settings</key>
${settings}
            </dict>
          </array>
        </dict>
      </dict>
    </dict>
  </array>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadIdentifier</key>
  <string>com.maximal.claude3p</string>
  <key>PayloadUUID</key>
  <string>${profileUUID}</string>
  <key>PayloadDisplayName</key>
  <string>maximal — Claude Desktop third-party gateway</string>
  <key>PayloadDescription</key>
  <string>Routes Claude Desktop (Cowork 3P) at the local maximal gateway (${plistEscape(values.inferenceGatewayBaseUrl)}). No Anthropic sign-in required.</string>
  <key>PayloadOrganization</key>
  <string>maximal</string>
  <key>PayloadScope</key>
  <string>${scope}</string>
</dict>
</plist>
`
}
