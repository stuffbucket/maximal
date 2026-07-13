#!/usr/bin/env bash
#
# claude-cleanup.sh — bring a macOS machine to a known-good Claude Code state:
# the OS-recommended *native installer* (~/.local/bin/claude) is the only CLI
# install, and non-standard installs (e.g. the NuGet-packaged tree the "agency"
# program drops under ~/.claude-cli) are removed.
#
# SAFETY MODEL (read before running):
#   • DATA IS NEVER TOUCHED. ~/.claude, ~/.claude.json (+ .bak/.backup) hold your
#     settings, projects, auth, and memory — this script never deletes them.
#   • It removes BINARY / INSTALL TREES only, and only ones it positively
#     identifies as non-canonical.
#   • It does NOT kill processes. Quit other Claude sessions yourself first.
#   • It does NOT uninstall the "agency" program or its data — only the stray
#     Claude binary tree agency installed. (See the agency note it prints.)
#   • DRY-RUN by default. It prints what it WOULD remove and changes nothing.
#     Re-run with --apply to actually delete. Add --prune-old-versions to also
#     trim superseded native-installer versions (keeps the active one).
#
# Usage:
#   ./claude-cleanup.sh                       # dry run (default) — safe to read
#   ./claude-cleanup.sh --apply               # perform removals
#   ./claude-cleanup.sh --apply --prune-old-versions
#
set -euo pipefail

APPLY=0
PRUNE_OLD=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --prune-old-versions) PRUNE_OLD=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# --- never-touch guardrails ---------------------------------------------------
# Any path that matches one of these prefixes is refused, even if a bug below
# tried to target it. This is the data-loss backstop.
PROTECTED=(
  "$HOME/.claude"
  "$HOME/.claude.json"
  "$HOME/.claude.json.bak"
  "$HOME/.claude.json.backup"
  "$HOME/.config/agency"     # agency's own config — not ours to remove
  "$HOME/.local/agency"      # agency's own data/logs
  "$HOME/.agents"            # agency skills
)
is_protected() {
  local target; target="$1"
  for p in "${PROTECTED[@]}"; do
    # exact match or child-of a protected dir
    [[ "$target" == "$p" || "$target" == "$p/"* ]] && return 0
  done
  return 1
}

note()  { printf '  %s\n' "$*"; }
plan()  { printf '  [REMOVE] %s  (%s)\n' "$1" "$2"; }

# --- 0. resolve the canonical (recommended) install ---------------------------
CANONICAL_BIN="$HOME/.local/bin/claude"
ACTIVE="$(command -v claude 2>/dev/null || true)"
ACTIVE_REAL=""
[ -n "$ACTIVE" ] && ACTIVE_REAL="$(readlink -f "$ACTIVE" 2>/dev/null || true)"

echo "== Canonical install =="
if [ -L "$CANONICAL_BIN" ]; then
  note "$CANONICAL_BIN -> $(readlink "$CANONICAL_BIN")  [KEEP]"
else
  note "WARNING: $CANONICAL_BIN not found. The native installer may not be"
  note "present. Install it first:  curl -fsSL https://claude.ai/install.sh | bash"
fi
if [ -n "$ACTIVE" ] && [ "$ACTIVE" != "$CANONICAL_BIN" ]; then
  note "WARNING: 'claude' on PATH resolves to $ACTIVE (not the canonical bin)."
  note "         Fix your PATH ordering so $HOME/.local/bin wins."
fi
echo

# --- 1. removal candidates: non-standard install trees ------------------------
# Add to this list as new stray installers are discovered. Each entry is a
# directory tree that is a *binary* install, never config/data.
echo "== Non-standard installs to remove =="
CANDIDATES=(
  "$HOME/.claude-cli"        # NuGet-packaged tree (agency); not on PATH
)
TO_REMOVE=()
for c in "${CANDIDATES[@]}"; do
  [ -e "$c" ] || continue
  if is_protected "$c"; then note "REFUSED (protected): $c"; continue; fi
  # Refuse if the active install lives inside this tree — never delete what's running.
  if [ -n "$ACTIVE_REAL" ] && [[ "$ACTIVE_REAL" == "$c/"* ]]; then
    note "SKIP: $c contains the ACTIVE binary ($ACTIVE_REAL)"; continue
  fi
  size="$(du -sh "$c" 2>/dev/null | cut -f1)"
  plan "$c" "${size:-?}"
  TO_REMOVE+=("$c")
done
[ "${#TO_REMOVE[@]}" -eq 0 ] && note "(none found — already clean)"
echo

# --- 2. optional: prune superseded native-installer versions ------------------
VERSIONS_DIR="$HOME/.local/share/claude/versions"
if [ "$PRUNE_OLD" -eq 1 ] && [ -d "$VERSIONS_DIR" ]; then
  echo "== Prune old native-installer versions (keep active) =="
  KEEP=""
  [ -n "$ACTIVE_REAL" ] && [[ "$ACTIVE_REAL" == "$VERSIONS_DIR/"* ]] && KEEP="$(basename "$ACTIVE_REAL")"
  for v in "$VERSIONS_DIR"/*; do
    [ -e "$v" ] || continue
    base="$(basename "$v")"
    if [ "$base" = "$KEEP" ]; then note "$base  [KEEP — active]"; continue; fi
    size="$(du -sh "$v" 2>/dev/null | cut -f1)"
    plan "$v" "${size:-?} old version"
    TO_REMOVE+=("$v")
  done
  echo
fi

# --- 3. execute or report -----------------------------------------------------
if [ "${#TO_REMOVE[@]}" -eq 0 ]; then
  echo "Nothing to remove. Machine is already in a known-good state."
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  echo "DRY RUN — nothing deleted. Re-run with --apply to remove the ${#TO_REMOVE[@]} item(s) above."
  exit 0
fi

echo "Applying removals…"
for t in "${TO_REMOVE[@]}"; do
  if is_protected "$t"; then echo "  REFUSED (protected): $t"; continue; fi
  rm -rf -- "$t"
  echo "  removed: $t"
done
echo
echo "Done. Verify:"
echo "  command -v claude  &&  claude --version"
echo
echo "AGENCY NOTE: the agency program (v$( "$HOME/.config/agency/CurrentVersion/agency" --version 2>/dev/null | awk '{print $2}' || echo '?')) installed"
echo "the stray under ~/.claude-cli and will likely re-create it on its next run."
echo "For a DURABLE known-good state, point agency at $HOME/.local/bin/claude or"
echo "disable its bundled-CLI install — otherwise this cleanup is temporary."
