# Install maximal

maximal is a small desktop app that lets your AI coding tools run on the models in your GitHub Copilot plan. Install it, sign in with GitHub, and switch on the tools you want. No extra API keys, no second bill.

This page covers getting maximal onto your machine. Once it's installed, head to [Sign in](./connect-copilot) and [Connect your tools](./connect-your-tools).

## Before you start

You'll need:

- **A GitHub Copilot plan.** maximal runs your tools on the models in your existing Copilot subscription, so you need an active plan. GitHub Enterprise works too.
- **A Mac with Apple Silicon** (M1 or newer) for the app. Windows is coming soon.

That's it. You don't need any Anthropic or OpenAI API keys.

## Install on your Mac

1. Download the latest `.dmg` from the [releases page](https://github.com/stuffbucket/maximal/releases).
2. Open the `.dmg` and drag **maximal** into your Applications folder.
3. Open maximal. It runs quietly in the background — click its icon any time to open it.

> **First launch on macOS:** because maximal is pre-alpha and not yet notarized, macOS may warn you the first time you open it. If it does, right-click the app and choose **Open**, then confirm. You only need to do this once.

## Next steps

1. **[Sign in](./connect-copilot)** with your GitHub account so maximal can use your Copilot plan.
2. **[Connect your tools](./connect-your-tools)** — flip a switch for Claude Code and Claude Desktop.
3. **[Get started](./overview)** with your first request.

Something not working? See [Troubleshooting](./troubleshooting).

---

## For developers

### Windows and other platforms

- **Windows** — support is on the way. The app already speaks Windows in a few places, but there's no packaged installer yet. Check the [releases page](https://github.com/stuffbucket/maximal/releases) for the latest.
- **Linux and everything else** — grab a release binary from the [releases page](https://github.com/stuffbucket/maximal/releases), or run from source with [Bun](https://bun.sh). Clone the repo and start it:

  ```sh
  git clone https://github.com/stuffbucket/maximal
  cd maximal
  bun install
  bun start
  ```

### Homebrew CLI

Prefer the terminal? Install the `maximal` command-line tool with Homebrew:

```sh
brew install stuffbucket/tap/maximal
```

From there you can sign in and start the local service straight from your terminal:

```sh
maximal auth      # sign in with GitHub
maximal           # start the service
```

Most people install both the app and the CLI eventually, but either one gets you running.

### Confirm it's running

Once you start maximal, it serves a local address on your machine — by default `http://localhost:4141`. Open the app (or run `maximal`) and you should see it listening. You can point any Anthropic- or OpenAI-compatible tool at that address.

You're not done until you sign in, though — until then the service runs but can't reach Copilot's models.
