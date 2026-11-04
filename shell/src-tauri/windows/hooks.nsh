; Maximal's NSIS installer hooks (bundle.windows.nsis.installerHooks in
; tauri.conf.json).
;
; These hooks run before Tauri's CheckIfAppIsRunning. Stop the shell first so
; that check cannot wait indefinitely for a tray-only process. Do not use /T on
; maximal-shell.exe: during an in-place update the installer is its descendant,
; and killing the shell's process tree would kill the installer too. Stop the
; proxy sidecar tree explicitly afterward so its binary can be replaced or
; removed. The maximal-mcp-broker.exe kill stays for upgrades from older
; versions that shipped it (this version doesn't). taskkill fails when nothing
; matches; that's fine.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM maximal-shell.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM maximal.exe /T'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM maximal-mcp-broker.exe /T'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM maximal-shell.exe'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM maximal.exe /T'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM maximal-mcp-broker.exe /T'
  Pop $0
!macroend
