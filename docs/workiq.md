# Work IQ

Work IQ is Microsoft's Microsoft 365 Copilot service for asking about your
work: email, meetings, chats, files and people. Maximal includes it as a
built-in plugin. It connects straight to Microsoft's hosted Work IQ MCP
service (`https://workiq.svc.cloud.microsoft/mcp`) with its own Microsoft
sign-in; nothing else needs installing, and no `workiq` program runs.

## Requirements

- A **work or school** Microsoft account. Personal Microsoft accounts are not
  supported.
- Your organization must allow the Work IQ app: a Microsoft Entra admin
  grants tenant-wide **admin consent** to the Work IQ app
  (`ba081686-5d24-4bc6-a0d6-d034ecffed87`). Without it, sign-in or the first
  request fails with "Your organization has not approved Work IQ".
- Your account needs a **licence** that includes Work IQ (Microsoft 365
  Copilot). Without one, Work IQ answers "not licensed".
- A desktop session with a browser for sign-in.

## Turn it on

1. Open Settings → **Plugins** and switch **Work IQ** on.
2. **Accept terms.** Read Microsoft's Work IQ terms
   ([github.com/microsoft/work-iq](https://github.com/microsoft/work-iq)) and
   choose *Accept terms*. Maximal records the acceptance in its own data and
   doesn't ask again.
3. **Sign in.** Choose *Sign in*. Your browser opens Microsoft's sign-in page;
   finish there and return to Settings. The status changes to *Connected as
   …* with your account, tenant and the number of tools Work IQ offers.

Until all three are done Work IQ offers no tools, and its status says what is
missing. If something goes wrong (consent, licence, network, Work IQ busy) the
status explains it in plain English with *Try again*, and *Sign in with
another account* when the problem is the account.

Maximal keeps the sign-in in its data directory (`<app dir>/plugins/workiq/`,
readable only by you) and refreshes it silently. *Sign out* deletes it.
Turning the plugin off stops it and removes its tools but keeps the sign-in
and the accepted terms.

## Use it from Claude Code

Under Work IQ in Settings → Plugins, tick **Claude Code**. Maximal then
registers Work IQ with Claude Code (user scope, in `~/.claude.json`) as an
HTTP MCP server named `workiq` at `http://127.0.0.1:<port>/mcp/workiq`, using
your Claude Code key. Its tools appear in Claude Code as `mcp__workiq__<tool>`.

- The Claude Code integration (Settings → Apps) must be on, and Maximal
  must find a `claude` program it can run; otherwise the box is unavailable
  and says why.
- The entry exists while Maximal runs: Maximal removes it when it quits and
  adds it back when it starts, so a Claude Code session started while Maximal
  is stopped doesn't see a dead server. Start a new Claude Code session after
  turning Work IQ on.
- An existing `workiq` entry of your own is left alone, and Maximal doesn't
  add its own.

Any other MCP client on this machine can use the same URL with Maximal's API
key (`Authorization: Bearer <key>` or `x-api-key`), when keys are required.
The endpoint answers only on loopback and refuses browser pages from other
origins. A Work IQ tool that needs an answer from you asks through the client
(MCP elicitation) when the client supports it.

## Settings file

Settings → Plugins writes `config.json` → `plugins.workiq`:

```json
{
  "plugins": {
    "workiq": { "enabled": true, "clients": ["claude-code"] }
  }
}
```

`plugins.workiq.config` may override `endpoint` (the Work IQ MCP URL) and
`authority` (the Microsoft Entra authority, default
`https://login.microsoftonline.com/organizations`); an invalid value marks the
plugin failed with the reason in Settings. A Work IQ set up through the older
MCP broker is carried over once: on if it was on, with its Claude Code choice.
