# Usage and settings

Once maximal is open, this is your map. You'll find a set of sections down the side — Account, Endpoint, API clients, Apps, Models, Usage, General, Logs, and Diagnostics. Here's what each one does and when you'd reach for it.

New here? Start with [Install maximal](./install) and [Get started](./overview) first, then come back.

## Account

Where you connect your GitHub Copilot plan — a signed-in account is what makes everything work, because maximal runs your tools on the models in that plan.

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

The address and key your tools use to reach maximal — most people never touch it, because the Apps section wires up supported tools for you (see below).

There are two local addresses, plus the current API key:

- **Anthropic-compatible:** `http://localhost:4141`
- **OpenAI-compatible:** `http://localhost:4141/v1`

Point any Anthropic- or OpenAI-SDK tool at the matching address and it behaves as if it's talking to Anthropic or OpenAI directly. Use the API key as `x-api-key` or `Authorization: Bearer <key>`.

There are copy helpers for a ready-to-run `curl` and for the environment variables, so you rarely have to type any of this by hand. A quick example for Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4141
export ANTHROPIC_AUTH_TOKEN=<your-maximal-key>
```

Reach for Endpoint when you're connecting something by hand, like Codex or opencode.

## Apps

Turn a tool on with a single switch and maximal sets it up for you — this is the main path for connecting your tools.

Apps auto-detects coding tools you already have installed. Flip a switch on and maximal writes the right settings; flip it off to disconnect.

- **Auto-configured today:** Claude Code and Claude Desktop (Cowork mode). Claude Desktop's model picker keeps working thanks to model-id rewriting.
- **Point-it-yourself:** Codex, opencode, and any other SDK or HTTP client. Grab the base URL and key from [Endpoint](#endpoint).
- **Coming soon:** Copilot CLI shows in the list, but you can't toggle it yet.

If an app already has its own base URL or key helper set, maximal won't clobber it. It backs off, and the card explains the conflict so you can decide. Use the re-scan button after installing a new tool.

## API clients

Mint a stable, named key for anything you want to keep pointed at maximal for the long run.

Every time maximal restarts, its auto-generated endpoint key rotates. That's fine for quick tests, but it'll break a long-running tool the next time you restart. A named key here stays put across restarts — give it a name you'll recognize later.

One security note: if your key list is empty, maximal accepts *all* local requests with no client auth. That's convenient on a trusted machine, but if you want maximal to require a key, add at least one.

## Models

The list of models available through your Copilot plan.

It's live, grouped by kind, and fetched straight from the provider. Hit refresh if you've just changed plans or want the latest. Use this to confirm a model is available before you set it in your tool.

## Usage

Your dashboard for what's actually happening — check here before you wonder "am I close to a limit?"

- **Copilot quotas** — what you've used and what's remaining (or unlimited) on your plan.
- **Token usage** — input, output, cache-read, cache-write, and request counts, with live trackers and traffic graphs.
- **Period windows** — view by day, week, or month.

A retention window caps the events table, so it won't grow forever.

## General

A few small preferences for how maximal sits on your machine.

Turn on the option to **hide maximal from your Dock or taskbar** while it keeps running in the background.

maximal follows your system light/dark setting automatically. The interface ships in 12 languages (English, German, Spanish, French, Italian, Japanese, Portuguese, Russian, Chinese, and regional variants).

## Logs

A record of every request, so you can see what a tool actually sent.

Per-request logs are rotated daily, with a retention you can configure (7 days by default). There's a reveal-folder button and tips for tailing the current log. maximal shows paths for macOS, Linux, and Windows. Start here when a request didn't do what you expected.

## Diagnostics

A read-only snapshot for when something's off and you want the full picture — and it's safe to screenshot, since it never reveals secrets.

- Your effective configuration
- Where each secret comes from — environment, file, config, or unset — **never the values themselves**
- Version, git SHA, and branch
- Web-search backend status and overall setup state

It's the first thing to check before filing an issue.

## Good to know

- maximal is pre-alpha, so expect a few rough edges.
- maximal auto-configures only Claude Code and Claude Desktop. Everything else connects through the [Endpoint](#endpoint) values.
- Server-side web search needs an Ollama key configured. Without it, search reports as unavailable while fetch still works.

Stuck on connecting a specific tool? See [Connect your tools](./connect-your-tools).
