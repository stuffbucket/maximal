# contrib/

Read-only reference snapshot. **Nothing in this directory is built or
shipped** — it's documentation that informed the architecture. The live
code lives at the repo root (`src/`, `tests/`).

## opencode-copilot/

How [sst/opencode](https://github.com/sst/opencode) does Copilot auth.

- `auth.ts` (115 lines, verbatim from
  [sst/opencode-github-copilot](https://github.com/sst/opencode-github-copilot)).
  Clean, self-contained `AuthCopilot` namespace: device-flow authorize,
  poll-for-access-token, exchange-for-Copilot-token, refresh.
- `opencode-copilot-auth.index.mjs` — the bundled plugin from
  [sst/opencode-copilot-auth](https://github.com/sst/opencode-copilot-auth)
  that opencode loads at runtime. Includes the GHE `enterpriseUrl`
  handling pattern.
- `LICENSE` — MIT.

opencode is officially blessed by GitHub for Copilot integration
(GitHub Changelog 2026-01-16), so its auth flow is the most-validated
public reference. Use this as the **bug-fix oracle** when caozhiyuan's
auth misbehaves: diff against this and bring fixes back across.

## Refresh procedure

These are point-in-time snapshots. To update one:

```sh
# example: refresh opencode-copilot
git clone --depth 1 https://github.com/sst/opencode-github-copilot /tmp/x
cp /tmp/x/auth.ts contrib/opencode-copilot/auth.ts
git diff contrib/opencode-copilot/   # review, commit if reasonable
```
