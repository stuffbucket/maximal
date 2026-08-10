import { execFileSync } from 'node:child_process'

/**
 * List `pid command` for every process whose command line contains
 * `pathFragment`. Used to prove a spawned sidecar (or the packaged app's own
 * main process) is really gone after shutdown, without depending on
 * capturing an OS pid ourselves — the relocated app lives at a fresh
 * `mktemp -d` path unique to this run, so a substring match against that path
 * cannot collide with an unrelated process.
 */
export function findProcessesContaining(pathFragment: string): string[] {
  // `ps -A -o pid=,command=` — no header row, every process on the system,
  // full command line (so an argv-only match like a resources/bin path is
  // visible even when argv[0] is trimmed).
  const output = execFileSync('ps', ['-A', '-o', 'pid=,command=']).toString()
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(pathFragment))
}
