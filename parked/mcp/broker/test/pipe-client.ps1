# A stdio client that isn't Bun, for the Windows adapter test: .NET's
# Process class, as PowerShell scripts use it. It starts the command with
# redirected stdio (anonymous pipes), writes the line with WriteLine (CRLF), and
# prints the first line the command writes to stdout as JSON:
# {"line": "..."}, or {"timeout": true}.
#
# The line comes in PIPE_CLIENT_LINE and the command line as a JSON array in
# PIPE_CLIENT_COMMAND, so neither goes through PowerShell's own parsing.
param([int]$TimeoutMs)
$Line = $env:PIPE_CLIENT_LINE
$command = $env:PIPE_CLIENT_COMMAND | ConvertFrom-Json
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $command[0]
$info.Arguments = ($command | Select-Object -Skip 1 | ForEach-Object { '"' + $_ + '"' }) -join ' '
$info.UseShellExecute = $false
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.CreateNoWindow = $true
$process = [System.Diagnostics.Process]::Start($info)
$process.StandardInput.WriteLine($Line)
$process.StandardInput.Flush()
$read = $process.StandardOutput.ReadLineAsync()
if ($read.Wait($TimeoutMs)) {
  if ($null -eq $read.Result) {
    @{ exited = $process.ExitCode } | ConvertTo-Json -Compress
  } else {
    @{ line = $read.Result } | ConvertTo-Json -Compress
  }
} else {
  '{"timeout":true}'
}
if (-not $process.HasExited) { $process.Kill() }
