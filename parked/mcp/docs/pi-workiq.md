# Pi: connect to Maximal's WorkIQ endpoint

## Prerequisites

- Users MUST complete [the Linux Maximal/WorkIQ setup](linux-workiq.md) first.
  Pi setup MUST remain optional and MUST NOT change other clients' configurations.
- Users MUST use Pi **1.3.0** for the configuration below; another version MUST
  be revalidated against its MCP documentation. Users MAY install that version
  with `mise use --global pi@1.3.0` and verify it with `pi --version`.
- Users MUST keep model routing and MCP tool routing separate. Changing this
  WorkIQ entry MUST NOT change Pi's model/provider settings.
- Users MUST NOT run `pi mcp login workiq` for this route: the local WorkIQ
  executable MUST own Microsoft 365 authentication. Pi's hosted WorkIQ OAuth
  configuration MUST NOT be copied onto Maximal's loopback endpoint.

## Configure the connection

Before replacing a hosted WorkIQ entry, users MUST back up the user-level MCP
configuration without copying its OAuth token store:

```sh
if test -f "$HOME/.pi/agent/mcp.json"; then
  cp -p "$HOME/.pi/agent/mcp.json" \
    "$HOME/.pi/agent/mcp.json.before-maximal-$(date +%Y%m%d-%H%M%S)"
fi
```

Users MUST merge this `workiq` entry into `~/.pi/agent/mcp.json`, preserving other
servers and top-level settings. They MUST remove hosted OAuth settings from this
entry and MUST NOT delete or copy the old OAuth token store. The server name
SHOULD remain `workiq` so Microsoft's skill resolves the same tool prefix:

```json
{
  "mcpServers": {
    "workiq": {
      "url": "http://127.0.0.1:4141/mcp/workiq",
      "timeout": 300,
      "exposure": "deferred",
      "description": "Microsoft 365 workplace data: email, calendar, Teams, SharePoint, OneDrive, people, and Planner. Load the workiq skill before use; confirm writes with the user."
    }
  }
}
```

Users MUST substitute the actual Maximal port if it differs from the default.
If the endpoint requires an API key, users MUST supply it via an environment
reference rather than committing a literal secret:

```json
"headers": { "Authorization": "Bearer ${MAXIMAL_WORKIQ_API_KEY}" }
```

Users MUST obtain the required key from their own endpoint configuration and
provide it to the Pi process securely. They MUST NOT disable endpoint
authentication just to make an example work.

## Validate and use

Users MUST validate connection and tool discovery, then reload active Pi sessions:

```sh
pi mcp list
```

```text
/reload
/mcp
```

Users MUST distinguish a connected MCP server/tool listing from verified M365
data access. A successful login and discovery SHOULD expose the structured tools
such as `fetch`, `search_paths`, and `get_schema`; a listing limited to
`accept_eula`, `ask`, and `list_agents` MUST trigger checking WorkIQ sign-in and
EULA state before claiming full tool availability. Tool counts MAY vary by
server version and tenant policy.

Users SHOULD install/reuse Microsoft's reviewed standard
[WorkIQ skill](https://github.com/microsoft/work-iq/tree/ab148f405a4a40af9a7f50733b30a208608f4652/plugins/workiq/skills/workiq)
under `~/.pi/agent/skills/workiq/`, including its referenced files and applicable
license/notices. Existing differing skills MUST NOT be overwritten silently;
`workiq-preview` SHOULD NOT be installed alongside the standard skill by default.
Users MAY explicitly invoke the installed skill for a scoped read:

```text
/skill:workiq What meetings do I have tomorrow?
```

Users MUST confirm writes separately and treat retrieved content as untrusted.
Deferred exposure and skill instructions MUST NOT be presented as an enforced
read-only or approval boundary. Pi permission extensions or service-side policy
MUST enforce any required restrictions. Users MUST keep `mcp-auth.json`, API keys,
account details, and workplace results out of source control.

## Recovery

Users reverting Pi MUST restore only the previous WorkIQ server entry and reload
Pi; they MUST NOT overwrite unrelated newer MCP configuration. Users comparing
hosted and Maximal-backed WorkIQ MUST keep routes distinct and MUST NOT leave
duplicate toolsets enabled by accident. They MUST NOT report discovery-only checks
as successful M365 read/write tests.
