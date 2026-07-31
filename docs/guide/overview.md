# What is maximal?

If you pay for GitHub Copilot, you already have access to top AI models — Claude, GPT, and more. maximal lets the AI tools you already use run on those models, so you don't pay for a second AI subscription on top of Copilot.

Here's the whole idea: you install a small desktop app, sign in with GitHub once, and switch on the tools you want. From then on, they run on your Copilot plan.

## Who it's for

- You have a **GitHub Copilot** plan — your own, or one from work or GitHub Enterprise.
- You use an AI coding tool like **Claude Code**, **Claude Desktop**, **Codex**, or **opencode** — or you'd like to.
- You're on a **Mac**. (Windows is coming soon.)

You don't need to be a developer, and you don't need any other accounts or keys. If you have Copilot, you have everything maximal needs.

## Get set up (about five minutes)

1. **Install maximal.** Download the maximal app and drag it into your Applications folder, then open it. → [Install maximal](./install.md)
2. **Sign in with GitHub.** Open maximal, click *Sign in with GitHub*, and approve the short code it shows you. This is what connects your Copilot plan. → [Connect GitHub Copilot](./connect-copilot.md)
3. **Switch on your tools.** In the **Apps** section, flip the switch next to a tool like Claude Code. maximal sets it up for you. → [Connect your tools](./connect-your-tools.md)

Now open your tool and use it the way you always have. It's running on your Copilot models.

## One heads-up: it's early

maximal is pre-alpha. It works — it's been used against a real company's GitHub Enterprise setup — but you'll hit the occasional rough edge. If something looks off, [Troubleshooting](./troubleshooting.md) has the common fixes.

---

## For developers

Want to wire things up yourself, or connect a tool that isn't in the **Apps** list (like Codex, opencode, or your own scripts)? maximal runs a small local server that speaks the Anthropic and OpenAI APIs, so any compatible tool can point at it:

- Anthropic-compatible: `http://localhost:4141`
- OpenAI-compatible: `http://localhost:4141/v1`

Set your tool's base URL to that address and use a key from the **Endpoint** section. For Claude Code, that looks like:

```sh
export ANTHROPIC_BASE_URL=http://localhost:4141
export ANTHROPIC_AUTH_TOKEN=<your-maximal-key>
```

Prefer the terminal? There's a `maximal` command-line tool too:

```sh
brew install stuffbucket/tap/maximal
```

Full details are in [Connect your tools](./connect-your-tools.md) and [How maximal works](./how-it-works.md).
