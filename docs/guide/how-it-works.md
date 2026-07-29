# How maximal works

maximal lets the AI coding tools you already use run on the models in your GitHub Copilot plan. No extra API keys, no second bill. Your tool works exactly as it does today — it just gets its answers from Copilot.

Here's the whole idea in one line. You point your tool at a local address maximal provides. Then maximal serves its requests using your Copilot plan.

## What you need

- A GitHub account with an active **Copilot subscription** (personal or Enterprise).
- macOS on Apple Silicon for the menu-bar app, or any platform if you run from source. See [Install maximal](./install).
- One of the supported tools — Claude Code, Claude Desktop (Cowork mode), Codex, opencode, or any Anthropic- or OpenAI-SDK client.

## The short version

1. **Install and start maximal.** It lives in your menu bar and runs a small local service on your machine.
2. **Sign in with GitHub.** maximal uses your own Copilot license — nothing else to buy. See [Sign in](./connect-copilot).
3. **Point your tool at maximal.** Either flip a toggle in the Apps section or copy the address from the Endpoint section. See [Connect your tools](./connect-your-tools).
4. **Use your tool normally.** Behind the scenes, Copilot's models serve your requests.

## Step by step

### 1. Start the local service

When maximal is running, it starts a small service on your machine (at a local address like `http://localhost:4141`). That service speaks two languages:

- an **Anthropic-compatible** address, for tools that expect Anthropic (like Claude Code)
- an **OpenAI-compatible** address at `/v1`, for tools that expect OpenAI (like Codex)

Your tool talks to whichever one it already knows how to use — it never has to change how it works.

### 2. Sign in with GitHub

maximal needs to know it's really you, so it can use your Copilot plan. You can:

- sign in with a **GitHub device code** — maximal copies a short code to your clipboard and opens the approval page. It then detects when you approve.
- **reuse a `gh` login** you already have on the machine
- run `maximal auth` from the terminal

Signing out only forgets maximal's own saved token — it never touches your `gh` login or your GitHub browser session. Until you sign in, the local service runs but can't reach Copilot yet.

### 3. Connect your tool

There are two ways to connect, depending on the tool:

- **Auto-configure.** In the **Apps** section, maximal detects installed tools like Claude Code and Claude Desktop. Flip the toggle and maximal wires them up for you. If a tool already has its own address or key set, maximal leaves it alone. It tells you rather than overwriting your setup.
- **Point it manually.** For Codex, opencode, or any SDK client, open the **Endpoint** section and copy the base URL and an API key. There are copy-curl and copy-env helpers to make this quick.

### 4. Run your tool

That's it. Your tool sends requests to the local address, and maximal serves them using the models in your Copilot plan. From your tool's point of view, nothing has changed.

## A concrete example: Claude Code

If you'd rather set it up by hand, point Claude Code at maximal with three environment variables:

```sh
export ANTHROPIC_BASE_URL="http://localhost:4141"
export ANTHROPIC_AUTH_TOKEN="any-value-or-a-maximal-key"
export ANTHROPIC_MODEL="<a model from the Models section>"
```

Then run Claude Code as usual. (In most cases you can skip all of this and just flip the toggle in **Apps**.)

## Keys and security

- maximal can **mint named API keys** for your tools in the API clients section. Do this for anything long-running — the auto-generated key rotates every time maximal restarts.
- If you have **no keys configured**, the local service accepts every request from your machine without checking a key. That's fine for quick local use, but mint a key if you'd like maximal to require one.

## Good to know

- maximal is **pre-alpha** — it works, but expect some rough edges.
- maximal supports **GitHub Enterprise** — set your enterprise URL.
- The **Models** section lists everything available through your Copilot plan, fetched live.
- The **Usage** and **Logs** sections show your quotas, token usage, and per-request logs so you can see exactly what's happening.

## Where to next

- [Install maximal](./install)
- [Sign in](./connect-copilot)
- [Connect your tools](./connect-your-tools)
- [Troubleshooting](./troubleshooting)
