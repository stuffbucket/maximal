# Work IQ

Work IQ (`@microsoft/workiq`) is Microsoft's MCP server for Microsoft 365
Copilot data. Maximal finds an installed copy, runs it behind its MCP broker,
and adds it to Claude Code and Claude Desktop. Maximal does not install Work IQ
or own its Microsoft sign-in. Linux needs extra setup: see
[Work IQ on Linux](linux-workiq.md).

## Set it up from Settings

Open Settings → Integrations → MCP servers and turn Work IQ on. The card shows
where setup stands and the next step. Maximal runs a Work IQ command only after
you confirm it in a dialog that names the command.

1. **Review terms.** Work IQ does nothing until you accept
   [Microsoft's terms](https://github.com/microsoft/work-iq). Confirming runs
   `workiq accept-eula`.
2. **Sign in.** Confirming runs `workiq auth login`, which opens a Microsoft
   sign-in page. Maximal waits up to 5 minutes; **Cancel sign-in** stops it.
   After a sign-in, Maximal restarts its MCP servers (open MCP sessions end)
   and checks that Work IQ now lists its Microsoft 365 tools, such as `fetch`,
   `get_schema` and `search_paths`.
3. **Ready**, or **Your organization needs to approve Work IQ**: see
   [Signed in, but it still doesn't work](#signed-in-but-it-still-doesnt-work).

### On macOS

The sign-in dialog offers **Use browser sign-in**. Checking it runs
`workiq config set disableBrokeredAuth=true` before signing in, so Work IQ signs
in through your browser instead of the macOS sign-in broker. Microsoft's
[MSAL macOS broker documentation](https://learn.microsoft.com/en-us/entra/msal/dotnet/acquiring-tokens/desktop-mobile/macos-broker-dotnet-sdk)
says the broker blocks requests from signed executables that are not bundled
apps, and `workiq` is one. Work IQ issues
[#87](https://github.com/microsoft/work-iq/issues/87) and
[#116](https://github.com/microsoft/work-iq/issues/116) describe repeated
sign-in windows and sign-ins that don't last across restarts. To go back to the
broker, run `workiq config unset disableBrokeredAuth`.

macOS may ask for your Mac password so Work IQ can save its sign-in to your
keychain. Choose **Always Allow**. **Allow** works once, so you would be asked
again each time Work IQ starts.

## Questions

### Where does Maximal put Work IQ for Claude Desktop?

In Claude Desktop's third-party config, as an `mcpServers` entry named after
the endpoint (`workiq`):

- macOS: `~/Library/Application Support/Claude-3p/claude_desktop_config.json`
- Windows: `%LOCALAPPDATA%\Claude-3p\claude_desktop_config.json`

The entry runs Maximal's `maximal-mcp-broker stdio-adapter`, which connects to
`http://127.0.0.1:<port>/mcp/workiq`. Claude Desktop reads this file only when
it launches, so quit and reopen it after turning Work IQ on or off. The entry
stays when Maximal quits. Claude Code gets a user-scope HTTP entry in
`~/.claude.json` instead, which new sessions pick up.

### Does signing in from Terminal work for the app?

Yes. A `workiq auth login` you run in Terminal and the Work IQ that Maximal
starts run as the same user. They share Work IQ's config
(`~/.work-iq-cli/.workiq.json`) and its saved sign-in (your keychain on macOS,
your Secret Service keyring on Linux). On macOS, use browser sign-in there too:

```sh
workiq config set disableBrokeredAuth=true
workiq auth login
```

Maximal checks the sign-in when it starts Work IQ, so turn Work IQ off and on
in Settings afterwards.

### Where are the logs?

- **Maximal's log.** Maximal writes Work IQ's error output to
  `mcp-broker-<date>.log` in its logs folder, `~/.local/share/maximal/logs/` on
  macOS and Linux (`COPILOT_API_HOME` moves it). Work IQ's lines start with
  `workiq:`. Logs are kept for 7 days by default.
- **The card.** When Work IQ isn't ready, its card shows the last line Work IQ
  wrote that looks like a problem, for example
  `[MCP Proxy] Failed to fetch remote tools: …`.
- **More detail from Work IQ.** Add `-l Debug` (or `-l Trace`, which includes
  the sign-in library's output) to a command you run yourself, for example
  `workiq -l Debug auth login`. This doesn't apply to the MCP connection:
  Maximal runs `workiq mcp` at Work IQ's default level, `Warning`.

### Signed in, but it still doesn't work

Work IQ needs your organization's approval. A Microsoft Entra admin grants
consent once for the whole tenant, at
`https://login.microsoftonline.com/{tenant}/adminconsent?client_id=ba081686-5d24-4bc6-a0d6-d034ecffed87`.
Each user also needs a license for Work IQ. See Microsoft's
[admin instructions](https://github.com/microsoft/work-iq/blob/main/ADMIN-INSTRUCTIONS.md)
and [Work IQ CLI guide](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/cli).

Maximal shows **Your organization needs to approve Work IQ** when Work IQ is
signed in but lists only its local tools (`accept_eula`, `ask`,
`list_agents`). A sign-in Work IQ couldn't read back looks the same, for
example after a keychain prompt was denied. If your admin has already approved
Work IQ, use **Sign in again** on the card.
