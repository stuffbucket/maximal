# A stdio client that isn't Bun, for the Windows adapter test: .NET's
# Process class, as PowerShell scripts use it. It starts the command with
# redirected stdio (anonymous pipes), writes Line with WriteLine (CRLF), and
# prints the first line the command writes to stdout as JSON:
# {"line": "..."}, or {"timeout": true}.
param(
  [int]$TimeoutMs,
  [string]$Line,
  [string]$Command,
  [string[]]$Arguments
)
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $Command
$info.Arguments = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
$info.UseShellExecute = $false
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.CreateNoWindow = $true
$process = [System.Diagnostics.Process]::Start($info)
$process.StandardInput.WriteLine($Line)
$process.StandardInput.Flush()
$read = $process.StandardOutput.ReadLineAsync()
if ($read.Wait($TimeoutMs)) {
  @{ line = $read.Result } | ConvertTo-Json -Compress
} else {
  '{"timeout":true}'
}
if (-not $process.HasExited) { $process.Kill() }
