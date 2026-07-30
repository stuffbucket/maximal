# Connect your tools

maximal connects the AI coding tools you already use to the models in your GitHub Copilot plan. Your tool works exactly as before — it's just running on Copilot now. No extra API keys, no second bill.

The simplest way to connect a tool is a single switch. It takes about a minute.

## Before you start

Two quick things first:

- [Install maximal](./install) and leave it open so it keeps running in the background.
- [Sign in with GitHub](./connect-copilot) so maximal can use your Copilot plan.

## Turn on a tool

1. Open maximal and go to the **Apps** section.
2. Find your tool and flip its switch on. maximal sets it up for you.
3. Start the tool — it's now running on your Copilot models.

This works today for **Claude Code** and **Claude Desktop**. Flip the switch, open the tool, and use it the way you always have.

**Claude Desktop (Cowork mode):** after you switch it on, use Claude Desktop's model picker as usual — maximal handles the model names behind the scenes. If you manage Claude Desktop through MDM, see the admin notes in `docs/admin/claude-desktop-mdm.md`.

**Copilot CLI** is listed in the **Apps** section too, but connecting it is coming soon — there's no switch yet.

If a tool is already pointed somewhere else, maximal won't overwrite it. It backs off and tells you about the conflict so nothing gets clobbered.

## Next steps

- [Watch your usage](./usage-and-settings) — Copilot quotas and token counts, live.
- [Troubleshooting](./troubleshooting) — if a tool won't connect or Copilot rejects a request.

---

## For developers

To connect a tool that isn't in the **Apps** list — Codex, opencode, or your own SDK and HTTP clients — point it at maximal by hand. Once you're signed in, maximal is listening locally at these addresses:

- **Anthropic-compatible:** `http://localhost:4141`
- **OpenAI-compatible:** `http://localhost:4141/v1`

The exact address and a ready-to-copy API key always live in the **Endpoint** section of the app. See [Endpoint and API keys](./usage-and-settings) for the copy helpers.

### Claude Code (manual)

If you'd rather set Claude Code yourself instead of using its switch, add these to your environment:

```sh
export ANTHROPIC_BASE_URL=http://localhost:4141
export ANTHROPIC_AUTH_TOKEN=your-maximal-key   # any value works, or mint a stable key
export ANTHROPIC_MODEL=<a model from the Models section>
```

The **Models** section lists everything available through your Copilot plan.

### Codex

Codex isn't auto-configured, so point it at maximal's OpenAI-compatible address. In your Codex settings, use:

- **Base URL:** `http://localhost:4141/v1`
- **API key:** any maximal-minted key (see below)

Codex will behave as if it's talking to `api.openai.com`. Grab the exact values from the **Endpoint** section.

### opencode

Point opencode at the same OpenAI-compatible endpoint:

- **Base URL:** `http://localhost:4141/v1`
- **API key:** a maximal-minted key

Copy both straight from the **Endpoint** section and paste them into opencode's provider settings.

### Any Anthropic or OpenAI SDK

Any client that speaks the Anthropic or OpenAI wire format works. Set the base URL and send a maximal key as the auth header:

- **Anthropic-style:** base URL `http://localhost:4141`, key as `x-api-key`
- **OpenAI-style:** base URL `http://localhost:4141/v1`, key as `Authorization: Bearer <key>`

A quick sanity check with curl:

```sh
curl http://localhost:4141/v1/chat/completions \
  -H "Authorization: Bearer your-maximal-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"<a model from Models>","messages":[{"role":"user","content":"hello"}]}'
```

The **Endpoint** section has copy-curl and copy-env-var helpers so you don't have to type any of this.

### A note on API keys

- **Mint a stable key for anything long-running.** In **API clients**, create a named key and use it in your tools. The auto-generated endpoint key rotates every time maximal restarts. So it's fine for a quick test, but not for a tool you leave running.
- **No keys configured?** Then maximal accepts every local request without checking auth. That's convenient, but worth knowing — mint a key if you want to lock local access down.

See [Endpoint and API keys](./usage-and-settings) for the full details.
