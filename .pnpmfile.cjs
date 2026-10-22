// The repository root is a Bun project: bun.lock is its lockfile and every
// script runs under Bun. pnpm would otherwise install a second dependency
// tree here (and write pnpm-lock.yaml) before running anything, so stop it
// up front and say what to run instead. Packages with their own
// pnpm-workspace.yaml are workspace roots of their own and don't load this.
//
// CommonJS because pnpm only loads `.pnpmfile.cjs` by default. Exiting from
// readPackage (the first hook pnpm calls) stops the install before anything
// is written; a thrown error would bury this text under a stack trace.

const message = `This project is configured to use bun, not pnpm.

  bun install    install dependencies (from bun.lock)
  bun run dev    run Maximal from source, restarting on changes
  bun test       run the tests
  bun run <name> run any other script in package.json

More in docs/commands.md.
`

module.exports = {
  hooks: {
    readPackage() {
      process.stderr.write(message)
      process.exit(1)
    },
  },
}
