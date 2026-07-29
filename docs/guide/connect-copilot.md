# Connect GitHub Copilot

maximal runs your AI coding tools on the models in your GitHub Copilot plan. Before your tools can use those models, you sign maximal in to GitHub once. This page walks you through it.

You'll need an active **GitHub Copilot subscription** — either a personal plan or one from GitHub Enterprise. Because maximal works through your own Copilot license, there are no extra API keys and no second bill.

New here? [Install maximal](./install) first, then come back.

## What "connecting" means

When you sign in, maximal links to your GitHub account and uses your Copilot plan to serve your tools. Your tools point at a local address maximal provides. Behind the scenes, Copilot's models answer their requests.

Until you sign in, maximal still runs — but it rejects any request that needs Copilot. Signing in is what turns it on.

## Sign in

Open maximal from the menu bar and go to the **Account** section. You have three ways to connect.

### Option 1 — Sign in with GitHub (device code)

This is the simplest path and works on any machine.

1. In **Account**, choose **Sign in with GitHub**.
2. maximal copies a short code to your clipboard and opens `github.com/login/device` in your browser.
3. Paste the code, then approve the request for maximal.
4. maximal detects the approval automatically and switches to connected.

### Option 2 — Reuse your GitHub CLI login

Already signed in with the `gh` command-line tool on this machine? maximal can reuse that account — no code to copy.

1. In **Account**, choose the option to **use your existing `gh` login**.
2. Pick the account you want, and maximal connects.

### Option 3 — Sign in from the terminal

If you installed the CLI and prefer to stay in the terminal:

```sh
maximal auth
```

Follow the prompts to complete the GitHub sign-in.

## Confirm you're connected

Back in **Account**, you should see a connected status and your Copilot plan. That's it — your tools can now use Copilot's models.

Next, [connect your first tool](./connect-your-tools) (like Claude Code), or grab your local address and key from the [Endpoint](./usage-and-settings) section.

## Use more than one account

maximal keeps a registry of accounts, so you can keep work and personal setups side by side.

- **Add an account** — sign in again with a different GitHub account.
- **Switch accounts** — pick another account and maximal restarts on it. Any tool already pointed at maximal picks up the change on its next request.
- **Sign out** — forgets the currently active account.
- **Remove an account** — drops one specific saved account.

Signing out or removing an account only touches maximal's own saved token. It never affects your `gh` login or your GitHub session in the browser.

## GitHub Enterprise

Using Copilot through GitHub Enterprise? Set your enterprise URL so maximal signs in against your organization instead of public GitHub. We tested maximal end-to-end against an enterprise deployment.

Set the enterprise URL with the `COPILOT_API_ENTERPRISE_URL` environment variable before you sign in. Then follow the sign-in steps above as usual.

## Troubleshooting

- **"Requires a Copilot subscription."** maximal is running, but your account doesn't have an active Copilot plan. Add Copilot to your GitHub account, then sign in again.
- **maximal keeps rejecting requests.** Open **Account** and confirm the status shows connected. If it doesn't, sign in again.
- **A plan, billing, or rate-limit message from Copilot.** maximal surfaces these in **Account**. Each message includes a link to fix it on GitHub's side.
- **Approved the device code but nothing happened.** Give it a moment — maximal detects approval on its own. If it's stuck, cancel and start the sign-in again.

## What's next

- [Connect your tools](./connect-your-tools) — wire up Claude Code, Codex, opencode, and more.
- [Endpoint](./usage-and-settings) — find your local address, keys, and copy-paste helpers.
- [Install maximal](./install) — if you haven't set it up yet.
