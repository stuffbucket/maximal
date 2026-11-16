---
name: verify
description: Runtime verification recipe for Maximal CLI and configuration changes through the public binary.
version: 1.0.0
---

# Verify Maximal at Runtime

Read `docs/commands.md` before running scripts. Do not substitute tests or
typechecks for runtime observation.

## CLI and configuration changes

1. Build the public binary:

   ```sh
   bun run build
   ```

2. Create an isolated app home and drive the packaged CLI:

   ```sh
   VERIFY_DIR=$(mktemp -d /tmp/maximal-verify.XXXXXX)
   COPILOT_API_HOME="$VERIFY_DIR" bun dist/main.js debug --json
   ```

3. Inspect `$VERIFY_DIR/config.json` and capture the CLI output. Re-run the same
   command to exercise persisted configuration; compare file hashes before and
   after when the claim includes non-destructive reads.

4. Probe the adjacent failure path in a second temporary app home. For config
   changes, malformed JSON should produce the documented error, continue with
   defaults where supported, and leave the malformed file byte-for-byte intact.

Never point `COPILOT_API_HOME` at the user's real app directory during
verification.
