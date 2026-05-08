#!/usr/bin/env bash
# UTM helper for the Windows test VM.
#
# UTM 4.7.x has no AppleScript `snapshot` command and the .utm bundles
# live in UTM's app sandbox, so `qemu-img snapshot` from the shell isn't
# practical. We work around both by using UTM's `export` command (which
# can write outside the sandbox) to make a baseline clone, then importing
# the baseline when we want to revert.
#
# Usage:
#   scripts/dev/utm.sh status
#   scripts/dev/utm.sh start [<vm-name>]
#   scripts/dev/utm.sh stop [<vm-name>]
#   scripts/dev/utm.sh suspend [<vm-name>]      # saves running state
#   scripts/dev/utm.sh baseline [<vm-name>]     # export to ~/UTM-Baselines/
#   scripts/dev/utm.sh restore [<vm-name>]      # opens the baseline in UTM
#   scripts/dev/utm.sh ls
#
# Default <vm-name> = "Windows".

set -euo pipefail

VM="${2:-Windows}"
BASELINE_DIR="${UTM_BASELINE_DIR:-$HOME/UTM-Baselines}"

run_osa() {
  osascript -e "$1"
}

cmd_status() {
  run_osa 'tell application "UTM"
    set vm to first virtual machine whose name = "'"$VM"'"
    return (status of vm as text)
  end tell'
}

cmd_start() {
  run_osa 'tell application "UTM"
    set vm to first virtual machine whose name = "'"$VM"'"
    start vm
  end tell'
  echo "Started $VM."
}

cmd_stop() {
  run_osa 'tell application "UTM"
    set vm to first virtual machine whose name = "'"$VM"'"
    stop vm
  end tell'
  echo "Stopped $VM."
}

cmd_suspend() {
  # `saving:true` writes guest RAM state to disk so resume is fast.
  run_osa 'tell application "UTM"
    set vm to first virtual machine whose name = "'"$VM"'"
    suspend vm saving yes
  end tell'
  echo "Suspended $VM (state saved to disk)."
}

cmd_baseline() {
  mkdir -p "$BASELINE_DIR"
  local stamp dest
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="$BASELINE_DIR/${VM}-${stamp}.utm"

  echo "Exporting $VM to $dest ..."
  run_osa 'tell application "UTM"
    set vm to first virtual machine whose name = "'"$VM"'"
    export vm to file (POSIX file "'"$dest"'")
  end tell'
  echo "Baseline written: $dest"
  echo "Symlinking as latest:"
  ln -sfn "$dest" "$BASELINE_DIR/${VM}-latest.utm"
  ls -la "$BASELINE_DIR" | tail -3
}

cmd_restore() {
  local src="$BASELINE_DIR/${VM}-latest.utm"
  if [ ! -e "$src" ]; then
    echo "::error::no baseline at $src — run 'baseline' first."
    exit 1
  fi
  echo "Opening baseline $src in UTM (will prompt to import)."
  echo "After import: delete the old '$VM' VM in UTM's sidebar, then"
  echo "rename the imported copy back to '$VM' if desired."
  open "$src"
}

cmd_ls() {
  run_osa 'tell application "UTM"
    set out to ""
    repeat with vm in (every virtual machine)
      set out to out & (name of vm as text) & tab & (status of vm as text) & linefeed
    end repeat
    return out
  end tell'
}

case "${1:-}" in
  status)   cmd_status ;;
  start)    cmd_start ;;
  stop)     cmd_stop ;;
  suspend)  cmd_suspend ;;
  baseline) cmd_baseline ;;
  restore)  cmd_restore ;;
  ls|list)  cmd_ls ;;
  ""|-h|--help|help)
    sed -n '1,30p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "::error::unknown subcommand: $1"
    exit 2
    ;;
esac
