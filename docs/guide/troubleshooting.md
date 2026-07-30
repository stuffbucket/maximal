# Troubleshooting and FAQ

When something isn't working, start here. Most issues come down to one of a few things. Maybe you're not signed in. Maybe a tool is pointed at the wrong place. Or maybe a key changed out from under a long-running session. Below are the fixes for the problems people hit most, plus quick answers to common questions.

If you're just getting started, run through [Install maximal](./install) and [Sign in](./connect-copilot) first.

## Quick checklist

Before digging in, confirm the basics:

- **maximal is open.** It runs in the background, so even if you don't see a window it may still be running.
- **You're signed in.** Open the **Account** section. It should show a connected GitHub account. Because maximal runs your tools through your own Copilot license, you need an active GitHub Copilot plan.
- **Your tools are switched on.** In the **Apps** section, check that the tool you're using has its switch flipped on. maximal sets those tools up for you. If you wired a tool up by hand, confirm it's still pointed at maximal — the exact values live in the **Endpoint** section.

## "I'm signed in, but my tool gets errors"

If maximal is open and your tool still fails, maximal is probably reaching Copilot but Copilot is rejecting the request.

1. Open **Account** and check the status. It surfaces upstream rejections — billing, plan, rate-limit, or terms issues — with a link to fix them.
2. Confirm your Copilot subscription is active. Without one, maximal still runs, but Copilot rejects every call.
3. If you're on **GitHub Enterprise**, maximal needs to be pointed at your company's Copilot deployment instead of public GitHub. See the [For developers](#for-developers) section below for the setting.
4. Check the **Usage** section for rate-limit quotas. If you're out of quota, requests fail until it resets. See [Usage](./usage-and-settings) for how maximal displays quotas.

## My tool suddenly can't authenticate

The key that maximal generates automatically **changes every time the app restarts**. Any tool that saved the old key will start failing after a restart.

The fix: create a **stable, named key** in the **API clients** section and use that for anything long-running. Named keys don't change. See [API keys](./usage-and-settings) for the steps.

## A tool won't connect at all

maximal doesn't set up every tool automatically.

- maximal auto-detects **Claude Code** and **Claude Desktop (Cowork mode)**. Flip their switch in the **Apps** section and maximal wires them up.
- **Codex**, **opencode**, and any other Anthropic- or OpenAI-SDK client you point at maximal yourself. See [Connect your tools](./connect-your-tools) for per-tool steps, and the [For developers](#for-developers) section below for the address and key details.
- **Copilot CLI** appears in **Apps** with a coming-soon label — there's no switch yet.

## "Enabling this app was refused"

Turn an app on, and maximal might back off with a warning. That means the app already has its own address or key helper configured, and maximal won't overwrite settings you (or your admin) put there.

To fix it, clear the conflicting setting from that tool's own config, then flip the switch again. The card explains exactly what conflicted.

## Where are the logs?

Open the **Logs** section. maximal keeps daily-rotated, per-handler request logs (7 days by default) and gives you a reveal-folder button and tail hints. It shows the paths for your platform.

For a fuller picture, open the **Diagnostics** section. It shows your effective config and where each secret comes from (env, file, config, or unset — never the values themselves). It also shows your version, git SHA, and branch. That's the best thing to copy when you report an issue.

## Frequently asked questions

**Do I need an API key from Anthropic or OpenAI?**
No. That's the point — maximal runs your tools on the models in your GitHub Copilot plan. No separate keys, no second bill.

**Does signing out of maximal log me out of GitHub?**
No. Signing out or removing an account only forgets maximal's own saved token. maximal leaves your `gh` CLI login and your GitHub browser session untouched.

**Can I use more than one GitHub account?**
Yes. maximal keeps a multi-account registry — add several accounts and quick-switch between them. Switching restarts maximal into the account you picked.

**I have no API keys listed. Is that a problem?**
It's a security note to be aware of: when no keys exist, maximal accepts **all** local requests without a client key. If that's not what you want, create a key in **API clients**. See [API keys](./usage-and-settings).

**Which platforms do you support?**
macOS on Apple Silicon is the primary target, and the Homebrew formula is Apple-Silicon-only. Windows is coming soon. On other platforms you can run from source or a release binary. Details in [Install maximal](./install).

**Which models can I use?**
Whatever your Copilot plan includes. The **Models** section lists them live, grouped by kind, with a refresh button. See [Models](./usage-and-settings).

**Why does it feel rough around the edges?**
maximal is pre-alpha. We've verified it end-to-end against a real enterprise deployment, but expect some sharp corners — and please report what you find.

## Still stuck?

Grab the details from **Diagnostics** (version, branch, secret sources) and the relevant lines from **Logs**, then open an issue. Those two together are usually enough to sort out what's happening fast.

---

## For developers

### Pointing a tool by hand

Not every tool auto-configures, so Codex, opencode, and other Anthropic- or OpenAI-SDK clients need the address and a key. Grab both from the **Endpoint** section:

- **Anthropic-compatible** base URL: `http://localhost:4141`
- **OpenAI-compatible** base URL: `http://localhost:4141/v1`
- Send your key as `x-api-key` or `Authorization: Bearer <key>`.

The canonical local address is `http://localhost:4141`. Always read the exact values from the **Endpoint** section rather than older notes — some early docs mention a different port. See [Connect your tools](./connect-your-tools) for per-tool steps.

### GitHub Enterprise

The default is public GitHub Copilot, so Enterprise accounts need `COPILOT_API_ENTERPRISE_URL` pointed at your deployment. If that isn't set, maximal reaches public GitHub and Copilot rejects your Enterprise requests.

### Web search says "unavailable"

maximal can resolve web-search and web-fetch requests that Copilot doesn't handle natively, but live **search** needs a backend. Set `OLLAMA_API_KEY` to enable it. Without that key, search reports unavailable — in-process **fetch** still works.
