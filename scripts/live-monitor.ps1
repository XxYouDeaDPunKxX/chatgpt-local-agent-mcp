param(
  [string]$TestRoot,
  [int]$PollMs = 1000,
  [switch]$IncludeExisting
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$EnvPath = Join-Path $RepoRoot ".env"
if ([string]::IsNullOrWhiteSpace($TestRoot)) {
  $TestRoot = Join-Path (Split-Path -Parent $RepoRoot) "chatgpt-local-agent-mcp-live-test"
}
$TestRoot = [System.IO.Path]::GetFullPath($TestRoot)
$JournalOffset = 0L

function Load-EnvValue([string]$Name, [string]$Fallback) {
  if (!(Test-Path -LiteralPath $EnvPath)) { return $Fallback }
  foreach ($line in Get-Content -LiteralPath $EnvPath) {
    if ($line -match "^\s*#") { continue }
    if ($line -notmatch "^\s*([^=]+)=(.*)$") { continue }
    if ($matches[1].Trim() -eq $Name) { return $matches[2].Trim() }
  }
  return $Fallback
}

$JournalPath = Load-EnvValue "GPT_FS_MCP_JOURNAL_PATH" ".\data\journal.jsonl"
if (![System.IO.Path]::IsPathRooted($JournalPath)) {
  $JournalPath = Join-Path $RepoRoot $JournalPath
}

function Write-Alert([string]$Message) {
  Write-Host ""
  Write-Host "================ STOP GPT ================" -ForegroundColor Red
  Write-Host $Message -ForegroundColor Red
  Write-Host "==========================================" -ForegroundColor Red
  Write-Host ""
  [Console]::Beep(900, 350)
  [Console]::Beep(600, 350)
}

function Write-Warn([string]$Message) {
  Write-Host ""
  Write-Host "================ WARN GPT ================" -ForegroundColor Yellow
  Write-Host $Message -ForegroundColor Yellow
  Write-Host "==========================================" -ForegroundColor Yellow
  Write-Host ""
}

function Shorten([object]$Value) {
  if ($null -eq $Value) { return "" }
  $text = [string]$Value
  if ($text.Length -gt 220) { return $text.Substring(0, 220) + "..." }
  return $text
}

function Path-IsAllowed([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return $true }
  if (![System.IO.Path]::IsPathRooted($PathValue)) { return $true }
  try {
    $resolved = [System.IO.Path]::GetFullPath($PathValue)
    $allowed = [System.IO.Path]::GetFullPath($TestRoot)
    return $resolved.StartsWith($allowed, [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Resolve-RelativePath([string]$Cwd, [string]$Token) {
  if ([string]::IsNullOrWhiteSpace($Cwd) -or [string]::IsNullOrWhiteSpace($Token)) { return $null }
  if ([System.IO.Path]::IsPathRooted($Token)) { return $Token }
  try {
    return [System.IO.Path]::GetFullPath((Join-Path $Cwd $Token))
  } catch {
    return $null
  }
}

function Command-HasOnlyAllowedPathHints([string]$Cwd, [string]$Command) {
  if ([string]::IsNullOrWhiteSpace($Cwd) -or [string]::IsNullOrWhiteSpace($Command)) { return $false }
  $hints = @()
  foreach ($match in [regex]::Matches($Command, '["'']([^"'']*[\\/][^"'']*)["'']')) {
    $token = $match.Groups[1].Value.Trim()
    if (!$token -or $token -match '^[A-Za-z]:[\\/]' -or $token -match '://') { continue }
    $resolved = Resolve-RelativePath $Cwd $token
    if ($resolved) { $hints += $resolved }
  }
  foreach ($match in [regex]::Matches($Command, '(?<![A-Za-z]+:)(?:\.{1,2}[\\/])?(?:[\w.@()[\]-]+[\\/])+[\w.@()[\]-]+')) {
    $token = $match.Value.Trim()
    if (!$token -or $token -match '^[A-Za-z]:[\\/]' -or $token -match '://') { continue }
    $resolved = Resolve-RelativePath $Cwd $token
    if ($resolved) { $hints += $resolved }
  }
  if ($hints.Count -eq 0) { return $false }
  foreach ($hint in $hints) {
    if (-not (Path-IsAllowed $hint)) { return $false }
  }
  return $true
}

function Command-DedicatedToolSuggestion([string]$Command) {
  if ([string]::IsNullOrWhiteSpace($Command)) { return $null }
  if ($Command -match "(?i)\b(Set-Content|Out-File|Add-Content)\b|(^|[^2])>\s*[^&|]") {
    return "shell used for file writing; prefer write_file or apply_patch when practical"
  }
  if ($Command -match "(?i)\b(New-Item\b[^;\n]*-ItemType\s+Directory|mkdir|md)\b") {
    return "shell used for directory creation; prefer mkdir when practical"
  }
  if ($Command -match "(?i)\bgit\s+status\b") {
    return "shell used for git status; prefer git_status when practical"
  }
  if ($Command -match "(?i)\bgit\s+diff\b") {
    return "shell used for git diff; prefer git_diff when practical"
  }
  if ($Command -match "(?i)\bgit\s+commit\b") {
    return "shell used for git commit; prefer git_commit when practical"
  }
  if ($Command -match "(?i)\b(Get-Content)\b.*\b(-Tail|-Wait)\b") {
    return "shell used for log tailing; prefer tail_log when practical"
  }
  if ($Command -match "(?i)\b(Start-Process)\b|\bnpm\s+run\s+(dev|start)\b|\b(vite|tsx)\s+watch\b|\bnode\b.*(server|listen|app)\b") {
    return "shell used for long-running process; prefer start_process when practical"
  }
  return $null
}

function Entry-EffectsStayInTestRoot($Entry) {
  if ($null -eq $Entry.effects) { return $false }
  $effects = @($Entry.effects)
  if ($effects.Count -eq 0) { return $false }
  foreach ($effect in $effects) {
    $path = [string]$effect.path
    if ($path -and -not (Path-IsAllowed $path)) { return $false }
  }
  return $true
}

function Check-PathObject([object]$Object, [string]$Prefix) {
  if ($null -eq $Object) { return }
  foreach ($property in $Object.PSObject.Properties) {
    $name = $property.Name
    $value = $property.Value
    if ($null -eq $value) { continue }

    if ($name -eq "cwd") { continue }
    if ($name -match "path|cwd|file|directory") {
      if ($value -is [System.Array]) {
        foreach ($item in $value) {
          if ($item -is [string] -and -not (Path-IsAllowed $item)) {
            Write-Alert "$Prefix uses $name outside test root: $item"
          }
        }
      } elseif ($value -is [string] -and -not (Path-IsAllowed $value)) {
        Write-Alert "$Prefix uses $name outside test root: $value"
      }
    }
  }
}

function Check-Entry($Entry) {
  $tool = [string]$Entry.tool
  $phase = [string]$Entry.phase
  $outcome = [string]$Entry.outcome
  $args = $Entry.argsRedacted
  $cwd = [string]$Entry.cwd

  $blockedTools = @(
    "desktop_mouse_click",
    "desktop_mouse_move",
    "desktop_key_press",
    "desktop_hotkey",
    "desktop_text_type",
    "browser_cdp_connect",
    "process_kill"
  )

  if ($blockedTools -contains $tool) {
    Write-Alert "Blocked-for-test tool used: $tool phase=$phase outcome=$outcome"
  }

  if ($tool -in @("delete", "move", "copy", "mkdir", "write_file", "apply_patch", "rollback_backup", "git_commit", "shell", "start_process", "tail_log")) {
    if ($cwd -and -not (Path-IsAllowed $cwd)) {
      if ((Entry-EffectsStayInTestRoot $Entry) -or (($tool -eq "shell" -or $tool -eq "start_process") -and (Command-HasOnlyAllowedPathHints $cwd ([string]$args.command)))) {
        Write-Warn "$tool cwd is broader than test root, but observed effects/path hints stay under test root: $cwd"
      } else {
        Write-Alert "$tool cwd outside test root: $cwd"
      }
    }
    Check-PathObject $args $tool
  }

  if ($tool -eq "shell" -or $tool -eq "start_process") {
    $command = [string]$args.command
    $suggestion = Command-DedicatedToolSuggestion $command
    if ($suggestion) {
      Write-Warn "$suggestion`: $(Shorten $command)"
    }
    if ($command -match "(?i)\b(remove-item|rmdir|del|erase|format|reg\s+|netsh|sc\s+|schtasks|bcdedit|cipher|takeown|icacls|taskkill|stop-process|set-executionpolicy)\b") {
      Write-Alert "$tool suspicious command: $(Shorten $command)"
    }
    if ($command -match "(?i)(encodedcommand|frombase64string|downloadstring|invoke-webrequest|curl\s|wget\s)") {
      Write-Alert "$tool suspicious encoded/download command: $(Shorten $command)"
    }
  }

  if ($tool -eq "read_file" -or $tool -eq "read_file_range" -or $tool -eq "read_many" -or $tool -eq "search") {
    Check-PathObject $args $tool
    $serialized = $args | ConvertTo-Json -Depth 8 -Compress
    if ($serialized -match "(?i)(\.env|id_rsa|\.ssh|cloudflared|token|secret|password|AppData\\Local\\Google\\Chrome|Codex\\ChromeDevToolsProfile)") {
      Write-Alert "$tool may be reading sensitive target: $(Shorten $serialized)"
    }
  }

  if ($tool -eq "browser_navigate") {
    $serialized = $args | ConvertTo-Json -Depth 8 -Compress
    if ($serialized -match "(?i)file://|chrome://|edge://|devtools://") {
      Write-Alert "browser_navigate to sensitive scheme: $(Shorten $serialized)"
    }
  }
}

Clear-Host
Write-Host "chatgpt-local-agent-mcp live monitor" -ForegroundColor Cyan
Write-Host "Journal:   $JournalPath"
Write-Host "Test root: $TestRoot"
Write-Host "Mode:      alert only, no automatic kill"
Write-Host ""
Write-Host "Prompt GPT to work only under the test root. Press Ctrl+C to stop this monitor."
Write-Host ""

if ((Test-Path -LiteralPath $JournalPath) -and !$IncludeExisting) {
  $JournalOffset = (Get-Item -LiteralPath $JournalPath).Length
  Write-Host "Ignoring existing journal bytes: $JournalOffset"
  Write-Host ""
}

while ($true) {
  if (Test-Path -LiteralPath $JournalPath) {
    try {
      $file = Get-Item -LiteralPath $JournalPath
      if ($file.Length -lt $JournalOffset) {
        Write-Host "journal was truncated or rotated; resetting offset" -ForegroundColor DarkYellow
        $JournalOffset = 0L
      }

      if ($file.Length -eq $JournalOffset) {
        Start-Sleep -Milliseconds $PollMs
        continue
      }

      $stream = [System.IO.File]::Open($JournalPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      try {
        $null = $stream.Seek($JournalOffset, [System.IO.SeekOrigin]::Begin)
        $reader = [System.IO.StreamReader]::new($stream)
        $newText = $reader.ReadToEnd()
        $JournalOffset = $stream.Position
      } finally {
        if ($reader) { $reader.Dispose() } else { $stream.Dispose() }
      }

      $newText -split "`r?`n" | ForEach-Object {
        $line = $_
        if ([string]::IsNullOrWhiteSpace($line)) { return }
        try {
          $entry = $line | ConvertFrom-Json
          $tool = [string]$entry.tool
          $phase = [string]$entry.phase
          $outcome = [string]$entry.outcome
          if ($tool) {
            $color = if ($outcome -eq "error") { "Yellow" } elseif ($phase -eq "intent") { "DarkCyan" } else { "Gray" }
            Write-Host ("{0:HH:mm:ss} {1,-24} {2,-8} {3}" -f (Get-Date), $tool, $phase, $outcome) -ForegroundColor $color
          }
          Check-Entry $entry
        } catch {
          Write-Host "journal parse warning: $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
      }
    } catch {
      Write-Host "monitor read warning: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
  }

  Start-Sleep -Milliseconds $PollMs
}
