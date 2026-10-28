; Maximal's NSIS installer hooks (bundle.windows.nsis.installerHooks in
; tauri.conf.json).
;
; Before files are touched, end every maximal-mcp-broker.exe: the MCP broker
; Maximal runs (ending it ends its Job Object and the MCP servers in it), and
; the stdio adapters Claude Desktop runs from the same executable. Either would
; hold the file, so an update couldn't replace it and an uninstall couldn't
; remove it. The MSI (StopRunningMcpBroker in build/windows/maximal.wxs) and
; install.ps1 do the same. taskkill fails when nothing matches; that's fine.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM maximal-mcp-broker.exe /T'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM maximal-mcp-broker.exe /T'
  Pop $0
!macroend
