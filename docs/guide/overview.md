# What is maximal?

maximal lets the AI coding tools you already use run on the models included in your GitHub Copilot plan. No extra API keys, no second bill. You start maximal, point your tool at a local address, and Copilot's backend quietly serves your requests.

If you already pay for Copilot, this is a way to get more out of that plan. Your tools keep working exactly as they do today — now powered by the models Copilot already gives you.

## How it works

maximal is a small macOS menu-bar app (Windows support is on the way). When it's running, it does two things:

- Runs a tiny local service on your machine that speaks both the Anthropic and OpenAI API formats.
- Signs in to GitHub on your behalf and serves your tools' requests through your own Copilot license.

Your tool thinks it's talking to Anthropic or OpenAI. Behind the scenes, maximal connects it to Copilot's models. That's it — nothing leaves your machine except the calls Copilot would already handle.

## What you need

- A GitHub account with an active **GitHub Copilot** subscription (personal or GitHub Enterprise).
- macOS on Apple Silicon for the packaged app. Other platforms can run from source or a release binary for now.

Without a Copilot subscription, the local service still runs, but maximal rejects any Copilot calls. It forwards through *your* license — it doesn't provide the plan for you.

## What you can connect

maximal works with the tools you already reach for:

- **Claude Code** — auto-detected and wired up for you.
- **Claude Desktop** (Cowork mode) — auto-detected and wired up for you.
- **Codex** — point it at the OpenAI-compatible address.
- **opencode** — point it at maximal's address with a key.
- **Any Anthropic- or OpenAI-SDK client** — use the endpoint values and a generated key.

Claude Code and Claude Desktop flip on with a single toggle in the Apps section. The others take one quick manual step. See [Connect your tools](./connect-your-tools) for the details on each.

## Get started in three steps

1. **Install maximal.** Grab it with Homebrew (`brew install stuffbucket/tap/maximal`) or download the app. Full walkthrough in [Install maximal](./install).
2. **Sign in with GitHub.** Open maximal and connect your GitHub account. Approve a short device code, or reuse an account you're already signed into with the `gh` CLI. See [Sign in](./connect-copilot).
3. **Point a tool at maximal.** Toggle on a supported app, or copy the local address and key from the Endpoint section into your tool. See [Connect your tools](./connect-your-tools).

Once you point a tool at maximal, run it like you always have. Your prompts go out on Copilot's models.

## A quick example

For a tool that reads the Anthropic environment variables (like Claude Code), pointing it at maximal by hand looks like this:

```bash
export ANTHROPIC_BASE_URL="http://localhost:4141"
export ANTHROPIC_AUTH_TOKEN="your-maximal-key"   # any value works if you haven't minted a key
export ANTHROPIC_MODEL="the model you want"
```

For an OpenAI-style tool, use the `/v1` address instead:

```bash
export OPENAI_BASE_URL="http://localhost:4141/v1"
```

maximal shows the exact addresses, keys, and copy-ready snippets in its Endpoint section — you rarely have to type these from memory.

## What's inside the app

Beyond the basics, maximal gives you a few surfaces worth knowing about:

- **Account** — sign in, add or switch between GitHub accounts, and see your connection status.
- **Endpoint** — your local addresses and current key, with copy helpers.
- **API keys** — mint stable, named keys for long-running tools. See [API keys](./usage-and-settings).
- **Apps** — auto-detect and toggle supported tools.
- **Models** — browse the models available through your Copilot plan.
- **Usage** — track your Copilot quota and token usage over time.
- **Logs & Diagnostics** — see request logs and check your setup when something looks off.

## A couple of things to know

- maximal is **pre-alpha**. It works, and we've run it end-to-end against a real enterprise deployment — but expect a few rough edges.
- The auto-generated endpoint key **rotates every time maximal restarts**. For anything long-running, mint a stable named key in [API keys](./usage-and-settings).
- If a tool is misbehaving, [Diagnostics](./troubleshooting) shows your effective config and setup state without ever exposing your secrets.

## Next steps

- [Install maximal](./install)
- [Sign in](./connect-copilot)
- [Connect your tools](./connect-your-tools)
- [Mint API keys](./usage-and-settings)
- [Troubleshooting](./troubleshooting)
