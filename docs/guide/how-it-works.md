# How maximal works

maximal lets the AI coding tools you already use run on the models in your GitHub Copilot plan. No extra API keys, no second bill. Your tool works exactly as it does today — it just gets its answers from Copilot.

Here's the whole idea in one line: you point your tool at maximal, and maximal serves its requests using your Copilot plan.

## What you need

You need a GitHub Copilot plan and a tool you'd like to use it with.

- A GitHub account with an active **Copilot subscription** (personal or Enterprise).
- macOS on Apple Silicon for the desktop app, or any platform if you run from source. See [Install maximal](./install).
- One of the supported tools — Claude Code, Claude Desktop (Cowork mode), Codex, opencode, or any Anthropic- or OpenAI-SDK client.

## The short version

Install the app, sign in with GitHub, switch on your tool, and keep working.

1. **Install and start maximal.** It runs in the background on your machine and does the work of connecting your tools to Copilot.
2. **Sign in with GitHub.** maximal uses your own Copilot license — nothing else to buy. See [Sign in](./connect-copilot).
3. **Switch on your tool.** Either flip a toggle in the Apps section or copy the address from the Endpoint section. See [Connect your tools](./connect-your-tools).
4. **Use your tool normally.** Behind the scenes, Copilot's models serve your requests.

## Step by step

### 1. Start maximal

When maximal is running, it's ready to connect the tools you switch on — you don't have to do anything else to it. Under the hood it speaks two languages so any tool feels at home:

- one that tools built for Anthropic understand (like Claude Code)
- one that tools built for OpenAI understand (like Codex)

Your tool talks to whichever one it already knows how to use — it never has to change how it works.

### 2. Sign in with GitHub

maximal needs to know it's really you, so it can use your Copilot plan. You can:

- sign in with a **GitHub device code** — maximal copies a short code to your clipboard and opens the approval page. It then detects when you approve.
- **reuse a `gh` login** you already have on the machine
- run `maximal auth` from the terminal

Signing out only forgets maximal's own saved sign-in — it never touches your `gh` login or your GitHub browser session. Until you sign in, maximal is running but can't reach Copilot yet.

### 3. Connect your tool

There are two ways to connect, depending on the tool:

- **Auto-configure.** In the **Apps** section, maximal detects installed tools like Claude Code and Claude Desktop. Flip the toggle and maximal wires them up for you. If a tool is already set up its own way, maximal leaves it alone. It tells you rather than overwriting your setup.
- **Point it manually.** For Codex, opencode, or any SDK client, open the **Endpoint** section and copy the address and a key. There are copy helpers to make this quick.

### 4. Run your tool

That's it. Your tool sends its requests to maximal, and maximal serves them using the models in your Copilot plan. From your tool's point of view, nothing has changed.

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

---

## For developers

### The local address

When maximal is running, it starts a small service on your machine at a local address like `http://localhost:4141`. It serves two API-compatible surfaces:

- an **Anthropic-compatible** address at `http://localhost:4141`, for tools that expect Anthropic (like Claude Code)
- an **OpenAI-compatible** address at `http://localhost:4141/v1`, for tools that expect OpenAI (like Codex)

For manual setup, open the **Endpoint** section and copy the base URL and an API key — there are copy-curl and copy-env helpers to make this quick.

### A concrete example: Claude Code

If you'd rather set it up by hand, point Claude Code at maximal with three environment variables:

```sh
export ANTHROPIC_BASE_URL="http://localhost:4141"
export ANTHROPIC_AUTH_TOKEN="any-value-or-a-maximal-key"
export ANTHROPIC_MODEL="<a model from the Models section>"
```

Then run Claude Code as usual. (In most cases you can skip all of this and just flip the toggle in **Apps**.)

### Keys and security

- maximal can **mint named API keys** for your tools in the API clients section. Do this for anything long-running — the auto-generated key rotates every time maximal restarts.
- If you have **no keys configured**, the local service accepts every request from your machine without checking a key. That's fine for quick local use, but mint a key if you'd like maximal to require one.
