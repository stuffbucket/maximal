# Work IQ

Work IQ is Microsoft's Microsoft 365 Copilot service for asking about your
work: email, meetings, chats, files and people. Maximal includes it as a
built-in connector. It connects straight to Microsoft's hosted Work IQ MCP
service (`https://workiq.svc.cloud.microsoft/mcp`) with its own Microsoft
sign-in; nothing else needs installing, and no `workiq` program runs. The
Work IQ sign-in is Work IQ's own: it is separate from Maximal's GitHub
Copilot sign-in and is never handed to MCP clients.

## Requirements

- A **work or school** Microsoft account. Personal Microsoft accounts are not
  supported.
- Your organization must allow the Work IQ app: a Microsoft Entra admin
  grants tenant-wide **admin consent** to the Work IQ app
  (`ba081686-5d24-4bc6-a0d6-d034ecffed87`). Without it, sign-in or the first
  request fails with "Your organization has not approved Work IQ".
- Your account needs a **licence** that includes Work IQ (Microsoft 365
  Copilot). Without one, Work IQ answers "not licensed".
- A desktop session with a browser for sign-in, and local port **12798**
  free while you sign in: it is the Work IQ app's registered redirect
  (`http://localhost:12798`), so Maximal never uses another port. If another
  program holds it, sign-in stops with "Sign-in needs local port 12798" and
  no browser opens.

## Turn it on

1. Open Settings → Integrations → **Connectors**, open **Work IQ** and switch it on.
2. **Accept terms.** Read Microsoft's Work IQ terms
   ([github.com/microsoft/work-iq](https://github.com/microsoft/work-iq)) and
   choose *Accept terms*. Maximal records the acceptance in its own data and
   doesn't ask again.
3. **Sign in.** Choose *Sign in*. Your browser opens Microsoft's sign-in page;
   finish there and return to Settings. The status changes to *Connected as
   …* with your account, tenant and the number of tools Work IQ offers.

Until all three are done Work IQ offers no tools to MCP clients, and its
status says what is missing. If something goes wrong (consent, licence, network, Work IQ busy) the
status explains it in plain English with *Try again*, and *Sign in with
another account* when the problem is the account.

Sign-in is the same as the Work IQ CLI's and agent-kit's tools (same app,
authority `organizations`, scope `WorkIQAgent.Ask`, browser sign-in with
PKCE), but Maximal keeps its own sign-in: it doesn't read or share their
keychain-encrypted token cache. Maximal refreshes the sign-in silently and
keeps it encrypted in its data directory
(`<app dir>/plugins/workiq/msal-token-cache.sealed.json`, readable only by
you), with the key in your system's credential store: the macOS Keychain,
Windows Credential Manager, or the keyring (Secret Service) on Linux. The
Keychain lists it as *Maximal connectors*. Only the most recently signed-in
account is kept. *Sign out* deletes the file and the key. Turning Work IQ off
stops it and removes its tools but keeps the sign-in, the accepted terms and
your tool permissions.

Without a usable credential store (most often Linux without a keyring, see
[Maximal on Linux](linux.md)) Maximal never writes the sign-in to disk: it
keeps it in memory, and you sign in again after Maximal restarts. Turning Work
IQ off and on keeps it. Work IQ's status then shows *Sign-in: Kept until
Maximal restarts* and what to install. A keyring that was only locked is
tried again a few minutes later, and the sign-in is saved once it answers. If
the credential store doesn't answer at all (an unanswered prompt), the
desktop app says so in a notification, and Work IQ carries on from memory.

The desktop app also shows a notification when Work IQ starts working after a
sign-in or after a problem, not on every start.

## When your organization limits Work IQ

Your Microsoft 365 admin decides whether you may use Work IQ and which parts,
and can change that later. The status names the Work IQ app id so you can
pass it on:

- **Sign-in blocked** — admin approval (consent) needed, your account not
  assigned to the app, a Conditional Access rule, or the app disabled in your
  organization. The status says which, with *Try again* and *Sign in*.
  Cancelling or letting the browser sign-in time out just asks you to sign
  in again.
- **Signed in but not enabled** — Work IQ refuses your account (no licence,
  or not turned on for you). Maximal first tries a fresh token once; if Work
  IQ still refuses, the status says your organization hasn't enabled Work IQ
  for this account. You stay signed in: choose *Try again* once your admin has
  enabled it.
- **Partly enabled** — Work IQ may offer only some tools; Maximal offers
  exactly those. When a later check finds fewer tools than before, the Tools
  count notes that some may be restricted. A single request your
  organization's policy refuses fails on its own ("Your organization's Work
  IQ policy doesn't allow this request"); Work IQ stays connected.
- **Changes later** — *Try again* re-runs the whole check (terms, sign-in,
  fresh token, connection, tool list).

## Choose which tools AI apps may use

Work IQ's page in Settings → Integrations → Connectors lists every tool Work IQ
offers, in three groups taken from the tools' own hints: **Read-only**,
**Write/delete** and **Other**. Each tool is **Allowed** (the default) or
**Blocked**; a group's menu sets all of its tools at once (*Custom* means its
tools differ). Open a tool to see its inputs and full schema.

- A blocked tool disappears from the tool list MCP clients see (Maximal tells
  connected clients the list changed), and a call to it is refused with "This
  tool is blocked in Maximal settings." Allowed tools run as usual; your MCP
  client still asks before using them.
- Changes apply at once without restarting Work IQ, and are kept by tool name:
  a tool that disappears (for example when your organization restricts it)
  gets its setting back if it returns.
- While Work IQ is off or signed out, the page shows the tools it offered last
  time ("Last seen …") so you can set permissions ahead of time.
- Permissions live in Work IQ's settings file
  (`<app dir>/plugins/workiq/settings.json`, `tools.permissions`).

## When Microsoft 365 is busy

Microsoft 365 limits how fast an app may read your data, and it limits
Teams chats hardest. When Work IQ reports that a request was throttled,
Maximal waits as long as Microsoft asks (or 2, 4, 8 and 16 seconds when it
doesn't say) and tries again, up to five times — a client that asked for
progress sees "Work IQ is rate-limiting requests …; retrying in 8 s." while
it waits. One throttled request slows every client using Work IQ through
Maximal for that moment, so they don't all keep hitting the limit. A read of
several items retries only the items that were throttled; any still
throttled at the end come back marked as such, with the others. If
Microsoft asks for a wait longer than 30 seconds, or too many requests are
already waiting, the request fails straight away and says when to try
again. A request that **changes** something (sending mail, creating an
event) is retried only when Microsoft clearly refused it; if the answer was
lost or Microsoft reported a server error, Maximal says the change may have
gone through and to check before trying again, so nothing is sent twice.

## Use it from Claude Code

On Work IQ’s page in Settings → Integrations → Connectors, tick **Claude Code**. Maximal then
registers Work IQ with Claude Code (user scope, in `~/.claude.json`) as an
HTTP MCP server named `maximal-workiq` at `http://127.0.0.1:<port>/mcp/workiq`,
using your Claude Code key. Its tools appear in Claude Code as
`mcp__maximal-workiq__<tool>`. Start a new Claude Code session after turning
Work IQ on.

- The Claude Code integration (Settings → Apps) must be on; otherwise the box
  is unavailable and says why.
- The entry stays while Maximal is stopped. Claude Code then shows
  `maximal-workiq` as failing to connect, and it works again once Maximal is
  running. Turning Work IQ off, unticking Claude Code, turning off the Claude
  Code integration or `maximal uninstall` removes it.
- If Claude Code already has its own Work IQ (a server named `workiq`, or
  Microsoft’s `workiq@work-iq` plugin), Maximal adds nothing and Settings
  marks Work IQ with a note saying so. Remove yours and Maximal adds its own the
  next time Settings looks.
- Versions before the rename wrote a `workiq` entry; Maximal replaces it with
  `maximal-workiq` when it starts.

Any other MCP client on this machine can use the same URL with Maximal's API
key (`Authorization: Bearer <key>` or `x-api-key`), when keys are required.
The endpoint answers only on loopback and refuses browser pages from other
origins. A Work IQ tool that needs an answer from you asks through the client
(MCP elicitation) when the client supports it.

## Settings file

Work IQ's own settings live in `<app dir>/plugins/workiq/settings.json`
(readable only by you; Maximal writes it, edit it through Settings):

```json
{
  "$schema": "maximal-plugin-settings/1",
  "plugin": "workiq",
  "version": 1,
  "config": {
    "endpoint": "https://workiq.svc.cloud.microsoft/mcp",
    "authority": "https://login.microsoftonline.com/organizations"
  },
  "tools": {
    "permissions": { "delete_entity": "block" },
    "catalog": { "updatedAt": "…", "tools": ["…"] }
  }
}
```

`config` holds the advanced options from the Configuration form on Work IQ's
page: `endpoint` (the Work IQ MCP URL) and `authority` (the Microsoft Entra
authority). Saving an invalid value is refused with the reason next to the
field; an invalid value edited into the file by hand marks Work IQ failed with
the reason in Settings, and a file Maximal can't read is reported and never
overwritten. `tools.permissions` holds your Allowed/Blocked choices and
`tools.catalog` the last tool list Work IQ offered.

`config.json` → `plugins.workiq` keeps only whether Work IQ is on and its
Claude Code choice:

```json
{
  "plugins": {
    "workiq": { "enabled": true, "clients": ["claude-code"] }
  }
}
```

An older `plugins.workiq.config` in `config.json` is moved into the settings
file once at startup. A Work IQ set up through the older MCP broker is carried
over once: on if it was on, with its Claude Code choice.
