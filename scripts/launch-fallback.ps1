param(
  [switch]$Wait
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$appScript = Join-Path $repoRoot "apps\fallback-dashboard\fallback-dashboard.ps1"

if (!(Test-Path -LiteralPath $appScript)) {
  throw "Fallback app script not found at $appScript"
}

$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $powershell
$startInfo.Arguments = "-STA -NoProfile -ExecutionPolicy Bypass -File `"$appScript`""
$startInfo.WorkingDirectory = $repoRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true

$process = [System.Diagnostics.Process]::Start($startInfo)
if (!$process) {
  throw "Fallback app process did not start."
}
try {
  Add-Content -LiteralPath (Join-Path ([System.IO.Path]::GetTempPath()) "agentic-filesystem-mcp-fallback.log") -Value ("{0:s} launched fallback pid={1}" -f (Get-Date), $process.Id)
} catch {
  [System.Diagnostics.Debug]::WriteLine("Fallback launch log write failed: $($_.Exception.Message)")
}

if ($Wait) {
  $process.WaitForExit()
  exit $process.ExitCode
}
