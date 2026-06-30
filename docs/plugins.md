# Plugin Integrations

- **Claude Code plugin:** Install from marketplace with `/plugin marketplace add https://github.com/caozhiyuan/copilot-api.git` then `/plugin install claude-plugin@copilot-api-marketplace`. Injects `__SUBAGENT_MARKER__` on subagent starts. `maximal configure-claude-code` writes both `env.ANTHROPIC_BASE_URL` and `apiKeyHelper: "maximal --apiKeyHelper claude-code"` into `~/.claude/settings.json`; the helper prints the Claude Code API-client key from Settings → API clients, falling back to the default endpoint key.
- **Opencode plugin:** Copy `.opencode/plugins/subagent-marker.js` to `~/.config/opencode/plugins/`.
