# Troubleshooting and FAQ

When something isn't working, start here. Most issues come down to one of a few things. Maybe you're not signed in. Maybe your tool points at the wrong address. Or maybe a key rotated out from under a long-running session. Below are the fixes for the problems people hit most, plus quick answers to common questions.

If you're just installing maximal, start with [Install maximal](./install) and [Sign in](./connect-copilot) first.

## Quick checklist

Before digging in, confirm the basics:

- **maximal is running.** Look for the icon in your menu bar. If it's hidden, the app may be in menu-bar-only mode — it's still running.
- **You're signed in.** Open the **Account** section. It should show a connected GitHub account. Because maximal forwards through your own Copilot license, you need an active GitHub Copilot plan.
- **Your tool points at the right address.** The canonical local address is `http://localhost:4141`. Check the exact values in the **Endpoint** section — don't rely on older notes, some early docs mention a different port.

## "I'm signed in, but my tool gets errors"

If maximal is running and your tool still fails, the local service is probably reaching Copilot but Copilot is rejecting the request.

1. Open **Account** and check the status. It surfaces upstream rejections — billing, plan, rate-limit, or terms issues — with a link to fix them.
2. Confirm your Copilot subscription is active. Without one, the local service still runs, but Copilot rejects every call.
3. If you're on **GitHub Enterprise**, make sure you've set the enterprise URL. The default is public GitHub Copilot, so Enterprise accounts need `COPILOT_API_ENTERPRISE_URL` pointed at your deployment.
4. Check the **Usage** section for rate-limit quotas. If you're out of quota, requests will fail until it resets. See [Usage](./usage-and-settings) for how maximal displays quotas.

## My tool suddenly can't authenticate

The endpoint key that maximal generates automatically **rotates every time the app restarts**. Any tool that saved the old key will start failing after a restart.

The fix: mint a **stable, named key** in the **API clients** section and use that for anything long-running. Named keys don't rotate. See [API keys](./usage-and-settings) for the steps.

## A tool won't connect at all

maximal doesn't configure every tool automatically.

- maximal auto-detects **Claude Code** and **Claude Desktop (Cowork mode)**. Flip their toggle in the **Apps** section, and maximal wires them up.
- You need to point **Codex**, **opencode**, and any other Anthropic- or OpenAI-SDK client at maximal by hand. Grab the base URL and a minted key from the **Endpoint** section. See [Connect your tools](./connect-your-tools) for per-tool steps.
- **Copilot CLI** appears in **Apps** with a coming-soon label — there's no toggle yet.

If you're pointing a tool manually:

- **Anthropic-compatible** base URL: `http://localhost:4141`
- **OpenAI-compatible** base URL: `http://localhost:4141/v1`
- Send your key as `x-api-key` or `Authorization: Bearer <key>`.

## "Enabling this app was refused"

Toggle an app on, and maximal might back off with a warning. That means the app already has its own base URL or API-key helper configured. maximal won't overwrite settings you (or your admin) put there.

To fix it, clear the conflicting base URL or key helper from that tool's own config, then flip the toggle again. The card explains exactly what conflicted.

## Web search says "unavailable"

maximal can resolve web-search and web-fetch requests that Copilot doesn't handle natively, but live **search** needs a backend. Set `OLLAMA_API_KEY` to enable it. Without that key, search reports unavailable — in-process **fetch** still works.

## Where are the logs?

Open the **Logs** section. maximal keeps daily-rotated, per-handler request logs (7 days by default) and gives you a reveal-folder button and tail hints. It shows the paths for your platform.

For a fuller picture, open the **Diagnostics** section. It shows your effective config and where each secret comes from (env, file, config, or unset — never the values themselves). It also shows your version, git SHA, and branch. That's the best thing to copy when you report an issue.

## Frequently asked questions

**Do I need an API key from Anthropic or OpenAI?**
No. That's the point — maximal runs your tools on the models in your GitHub Copilot plan. No separate keys, no second bill.

**Does signing out of maximal log me out of GitHub?**
No. Signing out or removing an account only forgets maximal's own saved token. maximal leaves your `gh` CLI login and your GitHub browser session untouched.

**Can I use more than one GitHub account?**
Yes. maximal keeps a multi-account registry — add several accounts and quick-switch between them. Switching restarts the local service into the account you picked.

**I have no API keys listed. Is that a problem?**
It's a security note to be aware of: when no keys exist, the local service accepts **all** local requests without client auth. If that's not what you want, mint a key in **API clients**. See [API keys](./usage-and-settings).

**Which platforms do you support?**
macOS on Apple Silicon is the primary target, and the Homebrew formula is Apple-Silicon-only. Windows is coming soon. On other platforms you can run from source or a release binary. Details in [Install maximal](./install).

**Which models can I use?**
Whatever your Copilot plan includes. The **Models** section lists them live, grouped by kind, with a refresh button. See [Models](./usage-and-settings).

**Why does it feel rough around the edges?**
maximal is pre-alpha. We've verified it end-to-end against a real enterprise deployment, but expect some sharp corners — and please report what you find.

## Still stuck?

Grab the details from **Diagnostics** (version, branch, secret sources) and the relevant lines from **Logs**, then open an issue. Those two together are usually enough to sort out what's happening fast.
