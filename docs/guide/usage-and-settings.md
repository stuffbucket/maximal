# Usage and settings

Once maximal is running in your menu bar, this is your map. Open the app and you'll find a set of sections down the side — Account, Endpoint, API clients, Apps, Models, Usage, General, Logs, and Diagnostics. Here's what each one does and when you'd reach for it.

New here? Start with [Install maximal](./install) and [Get started](./overview) first, then come back.

## Account

This is where you connect your GitHub Copilot plan. maximal runs your tools on the models in that plan. A signed-in account is what makes everything work.

You can sign in three ways:

- **GitHub device code** — maximal copies a short code to your clipboard and opens the GitHub approval page. Paste the code, approve, and maximal notices automatically.
- **Reuse your `gh` login** — if you're already signed in with the GitHub CLI on this machine, pick that account. No code to copy.
- **From the terminal** — run `maximal auth` if you installed the CLI.

You can keep several accounts and quick-switch between them; switching restarts maximal into the chosen account. Signing out or removing an account only forgets maximal's own saved token — it never touches your `gh` login or your GitHub browser session.

A couple of things to know:

- You need an active GitHub Copilot subscription. Until you sign in, maximal runs but rejects Copilot requests.
- **GitHub Enterprise?** Set your enterprise URL here and maximal points at your deployment instead of public GitHub.
- If Copilot pushes back (billing, plan, rate limit, terms), this section explains what happened and links you to the fix.

## Endpoint

This section shows the local addresses your tools connect to, plus the current API key. There are two:

- **Anthropic-compatible:** `http://localhost:4141`
- **OpenAI-compatible:** `http://localhost:4141/v1`

Point any Anthropic- or OpenAI-SDK tool at the matching address and it behaves as if it's talking to Anthropic or OpenAI directly. Use the API key as `x-api-key` or `Authorization: Bearer <key>`.

There are copy helpers for a ready-to-run `curl` and for the environment variables, so you rarely have to type any of this by hand. A quick example for Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4141
export ANTHROPIC_AUTH_TOKEN=<your-maximal-key>
```

Most people never touch the Endpoint values directly — the Apps section wires up supported tools for you (see below). Reach for Endpoint when you're connecting something by hand, like Codex or opencode.

## Apps

Apps auto-detects coding tools you already have installed and configures them for maximal with a single toggle. Flip it on and maximal writes the right settings; flip it off to disconnect.

- **Auto-configured today:** Claude Code and Claude Desktop (Cowork mode). Claude Desktop's model picker keeps working thanks to model-id rewriting.
- **Point-it-yourself:** Codex, opencode, and any other SDK or HTTP client. Grab the base URL and key from [Endpoint](#endpoint).
- **Coming soon:** Copilot CLI shows in the list, but you can't toggle it yet.

If an app already has its own base URL or key helper set, maximal won't clobber it. It backs off, and the card explains the conflict so you can decide. Use the re-scan button after installing a new tool.

## API clients

Every time maximal restarts, its auto-generated endpoint key rotates. That's fine for quick tests, but it'll break a long-running tool the next time you restart.

For anything you want to keep pointed at maximal, mint a **stable, named key** here and use that instead. Give it a name you'll recognize later, and it stays put across restarts.

One security note: if your key list is empty, maximal accepts *all* local requests with no client auth. That's convenient on a trusted machine, but if you want maximal to require a key, add at least one.

## Models

A live list of the models available through your Copilot plan, grouped by kind and fetched straight from the provider. Hit refresh if you've just changed plans or want the latest. Use this to confirm a model is available before you set it in your tool.

## Usage

Your dashboard for what's actually happening:

- **Copilot quotas** — what you've used and what's remaining (or unlimited) on your plan.
- **Token usage** — input, output, cache-read, cache-write, and request counts, with live trackers and traffic graphs.
- **Period windows** — view by day, week, or month.

A retention window caps the events table, so it won't grow forever. This is the place to check before you wonder "am I close to a limit?"

## General

Small but handy: enable **menu bar / system tray only** mode. It hides maximal from your Dock or taskbar while maximal keeps running in the background.

maximal follows your system light/dark setting automatically. The interface ships in 12 languages (English, German, Spanish, French, Italian, Japanese, Portuguese, Russian, Chinese, and regional variants).

## Logs

Per-request logs, rotated daily, with a retention you can configure (7 days by default). There's a reveal-folder button and tips for tailing the current log. maximal shows paths for macOS, Linux, and Windows. Start here when a request didn't do what you expected.

## Diagnostics

A read-only snapshot for when something's off and you want the full picture:

- Your effective configuration
- Where each secret comes from — environment, file, config, or unset — **never the values themselves**
- Version, git SHA, and branch
- Web-search backend status and overall setup state

It's the first thing to check before filing an issue, and safe to screenshot since it never reveals secrets.

## Good to know

- maximal is pre-alpha, so expect a few rough edges.
- maximal auto-configures only Claude Code and Claude Desktop. Everything else connects through the [Endpoint](#endpoint) values.
- Server-side web search needs an Ollama key configured. Without it, search reports as unavailable while fetch still works.

Stuck on connecting a specific tool? See [Connect your tools](./connect-your-tools).
