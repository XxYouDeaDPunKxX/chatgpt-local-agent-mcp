$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ([Threading.Thread]::CurrentThread.ApartmentState -ne "STA") {
  [System.Windows.Forms.MessageBox]::Show("This WinForms dashboard must be launched with powershell.exe -STA.", "Unsupported PowerShell host") | Out-Null
  exit 1
}

$SourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$LocalAppDataRoot = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  [Environment]::GetFolderPath("LocalApplicationData")
} else {
  $env:LOCALAPPDATA
}
if ([string]::IsNullOrWhiteSpace($LocalAppDataRoot)) {
  $LocalAppDataRoot = Join-Path ([Environment]::GetFolderPath("UserProfile")) "AppData\Local"
}
$DefaultRuntimeRoot = Join-Path $LocalAppDataRoot "chatgpt-local-agent-mcp"
$LegacyRuntimeRoot = Join-Path $LocalAppDataRoot "AgenticFilesystemMCP"
if ($env:CHATGPT_LOCAL_AGENT_MCP_RUNTIME_ROOT) {
  $RuntimeRoot = [System.IO.Path]::GetFullPath($env:CHATGPT_LOCAL_AGENT_MCP_RUNTIME_ROOT)
} elseif ($env:AGENTIC_FILESYSTEM_MCP_RUNTIME_ROOT) {
  $RuntimeRoot = [System.IO.Path]::GetFullPath($env:AGENTIC_FILESYSTEM_MCP_RUNTIME_ROOT)
} elseif (Test-Path -LiteralPath (Join-Path $DefaultRuntimeRoot ".env")) {
  $RuntimeRoot = $DefaultRuntimeRoot
} elseif (Test-Path -LiteralPath (Join-Path $LegacyRuntimeRoot ".env")) {
  $RuntimeRoot = $LegacyRuntimeRoot
} else {
  $RuntimeRoot = $SourceRoot
}
$RepoRoot = $RuntimeRoot
$RuntimeDataDir = Join-Path $RuntimeRoot "data"
$RuntimeLogDir = Join-Path $RuntimeRoot "logs"
New-Item -ItemType Directory -Force -Path $RuntimeDataDir, $RuntimeLogDir | Out-Null
$EnvPath = Join-Path $RepoRoot ".env"
$ServerOut = Join-Path $RuntimeLogDir "server.out.log"
$ServerErr = Join-Path $RuntimeLogDir "server.err.log"

$script:EnvMap = @{}
$script:ConnectedStatus = $null
$script:ConnectedActivity = $null
$script:ConnectedTests = $null
$script:ConnectedRecovery = $null
$script:ConnectedConfigCheck = $null
$script:ConnectedDebugBundle = $null
$script:LastBrief = ""
$script:Buttons = @()
$script:CachedPublicHealth = $null
$script:CachedProtectedMetadata = $null
$script:CachedAuthMetadata = $null
$script:LastPublicProbeAt = [datetime]::MinValue
$script:FallbackLog = Join-Path ([System.IO.Path]::GetTempPath()) "chatgpt-local-agent-mcp-fallback.log"
$script:IsRefreshing = $false
$script:IsBusy = $false
$script:IsClosing = $false
$script:AutoRefreshEnabled = $false
$script:LastRefreshText = "Not refreshed yet."
$script:ConsoleLines = New-Object System.Collections.Generic.List[string]
$script:MaxConsoleLines = 500
$script:Form = $null
$script:ConsoleBox = $null
$script:StatusLabel = $null
$script:AutoRefreshButton = $null
$script:AutoRefreshTimer = $null

function Write-FallbackLog {
  param([string]$Message)
  try {
    Add-Content -LiteralPath $script:FallbackLog -Value ("{0:s} {1}" -f (Get-Date), $Message)
  } catch {
    [System.Diagnostics.Debug]::WriteLine("Fallback log write failed: $($_.Exception.Message)")
  }
}

function Invoke-FallbackUi {
  param(
    [System.Windows.Forms.Control]$Control,
    [System.Delegate]$Callback,
    [object[]]$Arguments = @()
  )
  if ($script:IsClosing -or !$Control -or $Control.IsDisposed -or !$Control.IsHandleCreated) { return }
  try {
    [void]$Control.BeginInvoke($Callback, $Arguments)
  } catch {
    Write-FallbackLog "UI dispatch failed: $($_.Exception.Message)"
  }
}

function Write-AppConsole {
  param([string]$Message)
  $line = "{0:HH:mm:ss} {1}" -f (Get-Date), $Message
  Write-FallbackLog $Message
  if ($script:ConsoleBox -and -not $script:ConsoleBox.IsDisposed -and $script:ConsoleBox.IsHandleCreated) {
    $appendConsoleLine = [Action[string]]{
      param([string]$Text)
      if ($script:IsClosing -or $script:ConsoleBox.IsDisposed) { return }
      $script:ConsoleLines.Add($Text)
      while ($script:ConsoleLines.Count -gt $script:MaxConsoleLines) {
        $script:ConsoleLines.RemoveAt(0)
      }
      $script:ConsoleBox.Text = ($script:ConsoleLines -join [Environment]::NewLine)
      $script:ConsoleBox.SelectionStart = $script:ConsoleBox.TextLength
      $script:ConsoleBox.ScrollToCaret()
    }
    Invoke-FallbackUi $script:ConsoleBox $appendConsoleLine @($line)
  }
}

function Read-EnvMap {
  $map = @{}
  if (Test-Path -LiteralPath $EnvPath) {
    foreach ($line in Get-Content -LiteralPath $EnvPath) {
      if ($line -match '^\s*#') { continue }
      if ($line -notmatch '^\s*([^=]+)=(.*)$') { continue }
      $key = $matches[1].Trim()
      $value = $matches[2].Trim()
      $map[$key] = $value
    }
  }
  $script:EnvMap = $map
  return $map
}

function Apply-EnvMap {
  foreach ($key in $script:EnvMap.Keys) {
    [Environment]::SetEnvironmentVariable([string]$key, [string]$script:EnvMap[$key], "Process")
  }
  if (!$script:EnvMap.ContainsKey("GPT_FS_MCP_JOURNAL_PATH")) {
    [Environment]::SetEnvironmentVariable("GPT_FS_MCP_JOURNAL_PATH", (Join-Path $RuntimeDataDir "journal.jsonl"), "Process")
  }
  if (!$script:EnvMap.ContainsKey("GPT_FS_MCP_BACKUP_DIR")) {
    [Environment]::SetEnvironmentVariable("GPT_FS_MCP_BACKUP_DIR", (Join-Path $RuntimeDataDir "backups"), "Process")
  }
}

function Get-EnvValue {
  param([string]$Name, [string]$Fallback)
  if ($script:EnvMap.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace([string]$script:EnvMap[$Name])) {
    return [string]$script:EnvMap[$Name]
  }
  return $Fallback
}

function Get-McpPort {
  $value = Get-EnvValue "GPT_FS_MCP_PORT" "8789"
  return [int]$value
}

function Get-LocalBaseUrl {
  return "http://127.0.0.1:$(Get-McpPort)"
}

function Get-PublicBaseUrl {
  return (Get-EnvValue "PUBLIC_BASE_URL" (Get-LocalBaseUrl)).TrimEnd("/")
}

function Get-CloudflaredExe {
  return (Get-EnvValue "CLOUDFLARED_EXE" (Join-Path ([Environment]::GetFolderPath("UserProfile")) "Documents\cloudflared\cloudflared.exe"))
}

function Get-CloudflaredConfig {
  return (Get-EnvValue "CLOUDFLARED_CONFIG" (Join-Path ([Environment]::GetFolderPath("UserProfile")) ".cloudflared\config.yml"))
}

function Get-TunnelName {
  return (Get-EnvValue "CLOUDFLARE_TUNNEL_NAME" "chatgpt-local-agent-mcp")
}

function Get-JournalPath {
  $configured = Get-EnvValue "GPT_FS_MCP_JOURNAL_PATH" ""
  if ([string]::IsNullOrWhiteSpace($configured)) {
    return (Join-Path $RuntimeDataDir "journal.jsonl")
  }
  if ([System.IO.Path]::IsPathRooted($configured)) {
    return $configured
  }
  return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $configured))
}

function Get-BackupDir {
  $configured = Get-EnvValue "GPT_FS_MCP_BACKUP_DIR" ""
  if ([string]::IsNullOrWhiteSpace($configured)) {
    return (Join-Path $RuntimeDataDir "backups")
  }
  if ([System.IO.Path]::IsPathRooted($configured)) {
    return $configured
  }
  return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $configured))
}

function Redact-Value {
  param([string]$Key, [string]$Value)
  if ($Key -match '(?i)(SECRET|TOKEN|PASSWORD|CLIENT_SECRET|API_KEY)') {
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    return "[REDACTED]"
  }
  return $Value
}

function Format-Bytes {
  param([long]$Bytes)
  if ($Bytes -lt 1024) { return "$Bytes B" }
  if ($Bytes -lt 1048576) { return "{0:N1} KB" -f ($Bytes / 1024) }
  return "{0:N1} MB" -f ($Bytes / 1048576)
}

function Get-TextTail {
  param([string]$Path, [int]$Lines = 80)
  if (!(Test-Path -LiteralPath $Path)) { return @() }
  return @(Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue)
}

function ConvertFrom-JsonLine {
  param([string]$Line)
  try {
    return ($Line | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Get-JournalEvents {
  param([int]$Lines = 200)
  $events = @()
  foreach ($line in Get-TextTail -Path (Get-JournalPath) -Lines $Lines) {
    $event = ConvertFrom-JsonLine $line
    if ($event) { $events += $event }
  }
  return ,$events
}

function Get-EventField {
  param($Event, [string]$Name)
  if ($null -eq $Event) { return $null }
  if ($Event.PSObject.Properties[$Name]) { return $Event.$Name }
  return $null
}

function Get-ObjectPath {
  param($Value, [string]$Path)
  $current = $Value
  foreach ($part in $Path.Split(".")) {
    if ($null -eq $current) { return $null }
    if (!$current.PSObject.Properties[$part]) { return $null }
    $current = $current.$part
  }
  return $current
}

function ConvertTo-NonNullArray {
  param($Value)
  $items = @()
  if ($null -ne $Value) {
    if ($Value -is [array]) {
      $items = @($Value | Where-Object { $null -ne $_ })
    } else {
      $items = @($Value)
    }
  }
  return ,$items
}

function Get-ItemCount {
  param($Value)
  return (ConvertTo-NonNullArray $Value).Length
}

function Get-McpListener {
  $port = Get-McpPort
  Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq "127.0.0.1" -or $_.LocalAddress -eq "::1" } |
    Select-Object -First 1
}

function Get-McpProcess {
  $listener = Get-McpListener
  if (!$listener) { return $null }
  Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
}

function Get-TunnelProcess {
  $tunnelName = Get-TunnelName
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$tunnelName*" } |
    Select-Object -First 1
}

function Ensure-NodeDependencies {
  $nodeModules = Join-Path $RepoRoot "node_modules"
  $packageLock = Join-Path $RepoRoot "package-lock.json"
  if (Test-Path -LiteralPath $nodeModules) { return }
  if (!(Test-Path -LiteralPath $packageLock)) {
    throw "package-lock.json not found; cannot install dependencies."
  }
  Push-Location $RepoRoot
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Start-McpServer {
  Read-EnvMap | Out-Null
  Apply-EnvMap
  $existing = Get-McpListener
  if ($existing) { return "Local MCP already running, pid=$($existing.OwningProcess)" }

  $distIndex = Join-Path $RepoRoot "dist\index.js"
  if (!(Test-Path -LiteralPath $distIndex)) {
    Push-Location $RepoRoot
    try {
      Ensure-NodeDependencies
      npm run build
      if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed with exit code $LASTEXITCODE"
      }
    } finally { Pop-Location }
  }

  Remove-Item -LiteralPath $ServerOut, $ServerErr -Force -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath "node" -ArgumentList "dist/index.js" -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $ServerOut -RedirectStandardError $ServerErr -PassThru

  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Get-McpListener) { return "Local MCP started, pid=$($process.Id)" }
  }

  $tail = if (Test-Path -LiteralPath $ServerErr) { (Get-Content -LiteralPath $ServerErr -Tail 20) -join [Environment]::NewLine } else { "" }
  throw "Local MCP did not become ready. $tail"
}

function Stop-McpServer {
  Read-EnvMap | Out-Null
  $listener = Get-McpListener
  if (!$listener) { return "Local MCP is not running." }
  $process = Get-McpProcess
  if ($process -and $process.CommandLine -notlike "*dist/index.js*") {
    throw "Refusing to stop pid=$($listener.OwningProcess): command line does not look like this MCP server. $($process.CommandLine)"
  }
  Stop-Process -Id $listener.OwningProcess -Force
  return "Local MCP stopped, pid=$($listener.OwningProcess)"
}

function Restart-McpServer {
  $message = Stop-McpServer
  Start-Sleep -Milliseconds 800
  return "$message`r`n$(Start-McpServer)"
}

function Start-Tunnel {
  Read-EnvMap | Out-Null
  Apply-EnvMap
  $cloudflaredExe = Get-CloudflaredExe
  $cloudflaredConfig = Get-CloudflaredConfig
  $tunnelName = Get-TunnelName
  $existing = Get-TunnelProcess
  if ($existing) { return "Tunnel already running, pid=$($existing.ProcessId)" }
  if (!(Test-Path -LiteralPath $cloudflaredExe)) { throw "cloudflared.exe not found at $cloudflaredExe" }
  if (!(Test-Path -LiteralPath $cloudflaredConfig)) { throw "cloudflared config not found at $cloudflaredConfig" }

  $dataDir = $RuntimeLogDir
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $out = Join-Path $dataDir "cloudflared.out.log"
  $err = Join-Path $dataDir "cloudflared.err.log"
  $args = "tunnel --config `"$cloudflaredConfig`" run $tunnelName"
  $process = Start-Process -FilePath $cloudflaredExe -ArgumentList $args -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  return "Tunnel started, pid=$($process.Id)"
}

function Stop-Tunnel {
  $process = Get-TunnelProcess
  if (!$process) { return "Tunnel is not running." }
  Stop-Process -Id $process.ProcessId -Force
  return "Tunnel stopped, pid=$($process.ProcessId)"
}

function Restart-Tunnel {
  $message = Stop-Tunnel
  Start-Sleep -Milliseconds 800
  return "$message`r`n$(Start-Tunnel)"
}

function Invoke-ControlAction {
  param([scriptblock]$Action, [string]$Title)
  Invoke-BackgroundAction $Title $Action {
    param($message)
    Write-AppConsole $message
    Start-Refresh $true
  }
}

function Invoke-TextUrl {
  param([string]$Url, [int]$TimeoutSec = 2)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec -ErrorAction Stop
    return [ordered]@{
      ok = $true
      statusCode = [int]$response.StatusCode
      message = "OK"
      content = [string]$response.Content
    }
  } catch {
    return [ordered]@{
      ok = $false
      statusCode = $null
      message = $_.Exception.Message
      content = ""
    }
  }
}

function Invoke-JsonUrl {
  param([string]$Url, [int]$TimeoutSec = 2)
  $raw = Invoke-TextUrl -Url $Url -TimeoutSec $TimeoutSec
  if (-not $raw.ok) { return $null }
  try {
    return ($raw.content | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Refresh-PublicProbeCache {
  $now = Get-Date
  if (($now - $script:LastPublicProbeAt).TotalSeconds -lt 15 -and $script:CachedPublicHealth) {
    return
  }
  $public = Get-PublicBaseUrl
  $script:CachedPublicHealth = Invoke-TextUrl "$public/healthz" 2
  $script:CachedProtectedMetadata = Invoke-TextUrl "$public/.well-known/oauth-protected-resource" 2
  $script:CachedAuthMetadata = Invoke-TextUrl "$public/.well-known/oauth-authorization-server" 2
  $script:LastPublicProbeAt = $now
}

function Get-DirectoryStats {
  param([string]$Path)
  if (!(Test-Path -LiteralPath $Path)) {
    return [ordered]@{ exists = $false; files = 0; bytes = 0 }
  }
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue)
  $bytes = 0
  foreach ($file in $files) { $bytes += [long]$file.Length }
  return [ordered]@{ exists = $true; files = @(ConvertTo-NonNullArray $files).Length; bytes = $bytes }
}

function Get-RiskForEvent {
  param($Event)
  $tool = [string](Get-EventField $Event "tool")
  $json = ($Event | ConvertTo-Json -Depth 8 -Compress)
  if (
    $tool -eq "shell" -or
    $tool -eq "delete" -or
    $tool -eq "process_kill" -or
    $tool -eq "browser_cdp_connect" -or
    $tool -match "^desktop_" -or
    $json -match "(?i)(\.env|secret|token|password|credential)"
  ) {
    return "high"
  }
  if (
    $tool -in @("write_file","apply_patch","move","copy","git_commit","start_process","screen_screenshot","screen_ocr") -or
    $tool -match "^browser_"
  ) {
    return "medium"
  }
  return "low"
}

function Get-HumanEvent {
  param($Event)
  $tool = [string](Get-EventField $Event "tool")
  $phase = [string](Get-EventField $Event "phase")
  $outcome = [string](Get-EventField $Event "outcome")
  if ([string]::IsNullOrWhiteSpace($outcome)) { $outcome = "recorded" }
  $tail = if ($phase) { "$phase/$outcome" } else { $outcome }
  switch -Regex ($tool) {
    "^shell$" { return "GPT ran shell ($tail)" }
    "^write_file$" { return "GPT wrote or created a file ($tail)" }
    "^apply_patch$" { return "GPT applied a targeted patch ($tail)" }
    "^browser_cdp_connect$" { return "GPT attached to an existing browser profile ($tail)" }
    "^browser_" { return "GPT used browser automation: $tool ($tail)" }
    "^desktop_" { return "GPT used desktop control: $tool ($tail)" }
    "^(screen_|window_list)" { return "GPT inspected screen/window state: $tool ($tail)" }
    default { return "GPT used $tool ($tail)" }
  }
}

function Get-Warnings {
  param($Events)
  $warnings = @()
  foreach ($event in $Events) {
    $phase = [string](Get-EventField $event "phase")
    if ($phase -eq "intent") { continue }
    $risk = Get-RiskForEvent $event
    $errorText = [string](Get-EventField $event "error")
    if ($risk -ne "low" -or $errorText) {
      $warnings += [ordered]@{
        timestamp = [string](Get-EventField $event "timestamp")
        risk = if ($errorText -and $risk -eq "low") { "medium" } else { $risk }
        tool = [string](Get-EventField $event "tool")
        message = if ($errorText) { "$(Get-HumanEvent $event) - $errorText" } else { Get-HumanEvent $event }
      }
    }
  }
  return ,$warnings
}

function Add-Header {
  param([System.Text.StringBuilder]$Builder, [string]$Title)
  [void]$Builder.AppendLine($Title)
  [void]$Builder.AppendLine(("=" * $Title.Length))
  [void]$Builder.AppendLine("")
}

function Add-Kv {
  param([System.Text.StringBuilder]$Builder, [string]$Name, $Value)
  [void]$Builder.AppendLine(("{0,-28} {1}" -f ($Name + ":"), $Value))
}

function Format-JsonCompact {
  param($Value)
  if ($null -eq $Value) { return "" }
  try { return ($Value | ConvertTo-Json -Depth 12) } catch { return [string]$Value }
}

function Get-ConnectedJson {
  param([string]$Path)
  if (-not $script:ConnectedStatus) { return $null }
  return Invoke-JsonUrl "$(Get-LocalBaseUrl)$Path"
}

function Refresh-ConnectedData {
  $local = Get-LocalBaseUrl
  $script:ConnectedStatus = Invoke-JsonUrl "$local/dashboard/api/status"
  $script:ConnectedActivity = Invoke-JsonUrl "$local/dashboard/api/activity"
  $script:ConnectedRecovery = Invoke-JsonUrl "$local/dashboard/api/recovery"
  $script:ConnectedConfigCheck = Invoke-JsonUrl "$local/dashboard/api/config-check"
  $script:ConnectedDebugBundle = Invoke-JsonUrl "$local/dashboard/api/debug-bundle"
  $script:ConnectedTests = $null
}

function Build-StatusText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Status"
  $listener = Get-McpListener
  $mcpProcess = Get-McpProcess
  $tunnel = Get-TunnelProcess
  $localHealth = Invoke-TextUrl "$(Get-LocalBaseUrl)/healthz" 1
  Refresh-PublicProbeCache
  $publicHealth = $script:CachedPublicHealth
  Add-Kv $b "Repo" $RepoRoot
  Add-Kv $b "Local dashboard" "$(Get-LocalBaseUrl)/dashboard"
  Add-Kv $b "Public URL" (Get-PublicBaseUrl)
  Add-Kv $b "MCP URL" "$(Get-PublicBaseUrl)/mcp"
  Add-Kv $b "Local server" $(if ($listener) { "RUNNING pid=$($listener.OwningProcess)" } else { "STOPPED" })
  if ($mcpProcess) { Add-Kv $b "Server command" $mcpProcess.CommandLine }
  Add-Kv $b "Tunnel" $(if ($tunnel) { "RUNNING pid=$($tunnel.ProcessId)" } else { "STOPPED" })
  Add-Kv $b "Local health" "$($localHealth.statusCode) $($localHealth.message)"
  Add-Kv $b "Public health" "$($publicHealth.statusCode) $($publicHealth.message)"
  Add-Kv $b "Connected dashboard API" $(if ($script:ConnectedStatus) { "YES" } else { "NO - using local fallback data" })
  if ($script:ConnectedStatus) {
    Add-Kv $b "Dashboard summary" (Get-ObjectPath $script:ConnectedStatus "summary")
    Add-Kv $b "Current risk" (Get-ObjectPath $script:ConnectedStatus "risk.current")
  }
  $recoveryActions = ConvertTo-NonNullArray (Get-ObjectPath $script:ConnectedRecovery "actions")
  if ($recoveryActions.Length -gt 0) {
    $action = $recoveryActions[0]
    [void]$b.AppendLine("")
    [void]$b.AppendLine("Next action")
    [void]$b.AppendLine("-----------")
    Add-Kv $b "Title" (Get-EventField $action "title")
    Add-Kv $b "Priority" (Get-EventField $action "priority")
    Add-Kv $b "Detail" (Get-EventField $action "detail")
  }
  return $b.ToString()
}

function Build-ActivityText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "GPT Activity"
  $activityEvents = ConvertTo-NonNullArray (Get-ObjectPath $script:ConnectedActivity "events")
  if ($activityEvents.Length -gt 0) {
    [void]$b.AppendLine("Connected server view")
    [void]$b.AppendLine("")
    foreach ($event in @($activityEvents | Select-Object -First 80)) {
      $timestamp = [string](Get-EventField $event "timestamp")
      $risk = [string](Get-EventField $event "risk")
      $tool = [string](Get-EventField $event "tool")
      $human = [string](Get-EventField $event "human")
      $errorText = [string](Get-EventField $event "error")
      [void]$b.AppendLine("$timestamp [$risk] $tool - $human")
      if ($errorText) { [void]$b.AppendLine("  error: $errorText") }
    }
    return $b.ToString()
  }

  [void]$b.AppendLine("Fallback journal view")
  [void]$b.AppendLine("")
  foreach ($event in @(Get-JournalEvents 120 | Select-Object -Last 80)) {
    $risk = Get-RiskForEvent $event
    [void]$b.AppendLine("$([string](Get-EventField $event 'timestamp')) [$risk] $([string](Get-EventField $event 'tool')) - $(Get-HumanEvent $event)")
    $cwd = [string](Get-EventField $event "cwd")
    if ($cwd) { [void]$b.AppendLine("  cwd: $cwd") }
  }
  return $b.ToString()
}

function Build-SecurityText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Security"
  Add-Kv $b "Auth required" (Get-EnvValue "AUTH_REQUIRED" "(unset)")
  Add-Kv $b "Tunnel enabled" (Get-EnvValue "CLOUDFLARE_TUNNEL_ENABLED" "(unset)")
  Add-Kv $b "Public base URL" (Get-PublicBaseUrl)
  Add-Kv $b "Max policy mode" (Get-EnvValue "GPT_FS_MCP_MAX_POLICY_MODE" "(default destructive)")
  Add-Kv $b "Shell policy" (Get-EnvValue "GPT_FS_MCP_SHELL_POLICY" "(default full)")
  Add-Kv $b "Process policy" (Get-EnvValue "GPT_FS_MCP_PROCESS_POLICY" "(default full)")
  Add-Kv $b "Workspace enforcement" (Get-EnvValue "GPT_FS_MCP_ENFORCE_WORKSPACE_PROFILES" "(default true)")
  [void]$b.AppendLine("")
  [void]$b.AppendLine("Recent warnings")
  [void]$b.AppendLine("---------------")
  $connectedWarnings = ConvertTo-NonNullArray (Get-ObjectPath $script:ConnectedActivity "warnings")
  $warnings = if ($connectedWarnings.Length -gt 0) { $connectedWarnings } else { ConvertTo-NonNullArray (Get-Warnings (Get-JournalEvents 200)) }
  if ($warnings.Length -eq 0) {
    [void]$b.AppendLine("No recent warnings.")
  } else {
    foreach ($warning in @($warnings | Select-Object -First 80)) {
      [void]$b.AppendLine("$($warning.timestamp) [$($warning.risk)] $($warning.tool) - $($warning.message)")
    }
  }
  return $b.ToString()
}

function Build-FilesText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Files & Changes"
  $backup = Get-DirectoryStats (Get-BackupDir)
  $screenshots = Get-DirectoryStats (Join-Path $RuntimeDataDir "screenshots")
  Add-Kv $b "Journal" (Get-JournalPath)
  Add-Kv $b "Backups" "$(Get-BackupDir) ($($backup.files) files, $(Format-Bytes $backup.bytes))"
  Add-Kv $b "Screenshots" "$($screenshots.files) files, $(Format-Bytes $screenshots.bytes)"
  [void]$b.AppendLine("")
  [void]$b.AppendLine("Recent file effects")
  [void]$b.AppendLine("-------------------")
  foreach ($event in @(Get-JournalEvents 200 | Select-Object -Last 120)) {
    $effects = Get-EventField $event "effects"
    if (!$effects) { continue }
    foreach ($effect in @($effects)) {
      [void]$b.AppendLine("$([string](Get-EventField $event 'timestamp')) $([string](Get-EventField $event 'tool')) $($effect.operation) $($effect.path)")
    }
  }
  return $b.ToString()
}

function Build-BrowserDesktopText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Browser & Desktop"
  $browserDir = Get-DirectoryStats (Join-Path $RuntimeDataDir "browser")
  $screenshotDir = Get-DirectoryStats (Join-Path $RuntimeDataDir "screenshots")
  Add-Kv $b "Browser artifacts" "$($browserDir.files) files, $(Format-Bytes $browserDir.bytes)"
  Add-Kv $b "Screenshot artifacts" "$($screenshotDir.files) files, $(Format-Bytes $screenshotDir.bytes)"
  Add-Kv $b "OCR local dependency" "Shown by MCP when screen_ocr runs"
  [void]$b.AppendLine("")
  [void]$b.AppendLine("Recent browser/screen/desktop events")
  [void]$b.AppendLine("------------------------------------")
  foreach ($event in @(Get-JournalEvents 200 | Select-Object -Last 120)) {
    $tool = [string](Get-EventField $event "tool")
    if ($tool -match "^(browser_|screen_|desktop_|window_list)") {
      [void]$b.AppendLine("$([string](Get-EventField $event 'timestamp')) $(Get-HumanEvent $event)")
    }
  }
  return $b.ToString()
}

function Build-ProcessesText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Processes"
  $listener = Get-McpListener
  $mcpProcess = Get-McpProcess
  $tunnel = Get-TunnelProcess
  Add-Kv $b "MCP listener" $(if ($listener) { "$($listener.LocalAddress):$($listener.LocalPort) pid=$($listener.OwningProcess)" } else { "not listening" })
  if ($mcpProcess) { Add-Kv $b "MCP command" $mcpProcess.CommandLine }
  Add-Kv $b "Tunnel process" $(if ($tunnel) { "pid=$($tunnel.ProcessId)" } else { "not running" })
  [void]$b.AppendLine("")
  [void]$b.AppendLine("Non-local TCP listeners")
  [void]$b.AppendLine("-----------------------")
  $listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -notin @("127.0.0.1","::1") } |
    Sort-Object LocalPort, LocalAddress |
    Select-Object -First 80
  foreach ($item in $listeners) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($item.OwningProcess)" -ErrorAction SilentlyContinue
    [void]$b.AppendLine("$($item.LocalAddress):$($item.LocalPort) pid=$($item.OwningProcess) $($proc.Name)")
  }
  return $b.ToString()
}

function Build-TestsText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Tests & Diagnostics"
  $localHealth = Invoke-TextUrl "$(Get-LocalBaseUrl)/healthz" 1
  Refresh-PublicProbeCache
  $publicHealth = $script:CachedPublicHealth
  $protected = $script:CachedProtectedMetadata
  $authServer = $script:CachedAuthMetadata
  Add-Kv $b "Local health" "$(if ($localHealth.ok) { 'OK' } else { 'FAIL' }) - $($localHealth.message)"
  Add-Kv $b "Public health" "$(if ($publicHealth.ok) { 'OK' } else { 'FAIL' }) - $($publicHealth.message)"
  Add-Kv $b "Resource metadata" "$(if ($protected.ok) { 'OK' } else { 'FAIL' }) - $($protected.message)"
  Add-Kv $b "Auth metadata" "$(if ($authServer.ok) { 'OK' } else { 'FAIL' }) - $($authServer.message)"
  Add-Kv $b "Journal readable" $(if (Test-Path -LiteralPath (Get-JournalPath)) { "OK" } else { "missing" })
  if ($script:ConnectedTests) {
    [void]$b.AppendLine("")
    [void]$b.AppendLine("Connected smoke tests")
    [void]$b.AppendLine("---------------------")
    foreach ($test in @($script:ConnectedTests.tests)) {
      [void]$b.AppendLine("$(if ($test.ok) { 'OK' } else { 'FAIL' }) [$($test.severity)] $($test.name): $($test.detail)")
    }
  }
  return $b.ToString()
}

function Build-ConfigText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Configuration"
  Add-Kv $b "Env path" $EnvPath
  Add-Kv $b "Repo root" $RepoRoot
  Add-Kv $b "Journal" (Get-JournalPath)
  Add-Kv $b "Backup dir" (Get-BackupDir)
  [void]$b.AppendLine("")
  if ($script:ConnectedConfigCheck) {
    [void]$b.AppendLine("Connected config validator")
    [void]$b.AppendLine("--------------------------")
    [void]$b.AppendLine([string](Get-ObjectPath $script:ConnectedConfigCheck "summary"))
    foreach ($check in (ConvertTo-NonNullArray (Get-ObjectPath $script:ConnectedConfigCheck "checks"))) {
      [void]$b.AppendLine("$(if ($check.ok) { 'OK' } else { 'FAIL' }) [$($check.severity)] $($check.name): $($check.detail)")
    }
    [void]$b.AppendLine("")
  }
  [void]$b.AppendLine(".env snapshot")
  [void]$b.AppendLine("-------------")
  foreach ($key in ($script:EnvMap.Keys | Sort-Object)) {
    [void]$b.AppendLine(("{0,-38} {1}" -f ($key + ":"), (Redact-Value $key ([string]$script:EnvMap[$key]))))
  }
  return $b.ToString()
}

function Build-MaintenanceText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Maintenance"
  Add-Kv $b "Fallback dashboard" "PowerShell WinForms, cold-start capable"
  Add-Kv $b "Web dashboard" "$(Get-LocalBaseUrl)/dashboard"
  Add-Kv $b "Server controls" "Use the buttons at the top of this app"
  Add-Kv $b "Live monitor" (Join-Path $RepoRoot "chatgpt-local-agent-mcp-live-monitor.bat")
  Add-Kv $b "Cloudflared exe" (Get-CloudflaredExe)
  Add-Kv $b "Cloudflared config" (Get-CloudflaredConfig)
  Add-Kv $b "Server out log" $ServerOut
  Add-Kv $b "Server err log" $ServerErr
  [void]$b.AppendLine("")
  [void]$b.AppendLine("server.out.log tail")
  [void]$b.AppendLine("-------------------")
  foreach ($line in Get-TextTail $ServerOut 50) { [void]$b.AppendLine($line) }
  [void]$b.AppendLine("")
  [void]$b.AppendLine("server.err.log tail")
  [void]$b.AppendLine("-------------------")
  foreach ($line in Get-TextTail $ServerErr 50) { [void]$b.AppendLine($line) }
  return $b.ToString()
}

function Build-AuthText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Connector/Auth"
  $auth = Get-ConnectedJson "/dashboard/api/auth"
  if ($auth) {
    Add-Kv $b "Auth required" (Get-ObjectPath $auth "authRequired")
    Add-Kv $b "Access token TTL" "$(Get-ObjectPath $auth 'accessTokenTtlSeconds') seconds"
    Add-Kv $b "Refresh token" "not issued"
    Add-Kv $b "Issuer" (Get-ObjectPath $auth "issuer")
    Add-Kv $b "Resource URI" (Get-ObjectPath $auth "resourceUri")
    Add-Kv $b "Default scopes" (@(Get-ObjectPath $auth "defaultScopes") -join ", ")
    $lastToolActivity = Get-ObjectPath $auth "lastToolActivity"
    Add-Kv $b "Last tool activity" $(if ($lastToolActivity) { "$(Get-ObjectPath $lastToolActivity 'timestamp') $(Get-ObjectPath $lastToolActivity 'tool')" } else { "-" })
    [void]$b.AppendLine("")
    [void]$b.AppendLine([string](Get-ObjectPath $auth "note"))
    return $b.ToString()
  }
  Add-Kv $b "Auth required" (Get-EnvValue "AUTH_REQUIRED" "(unset)")
  Add-Kv $b "Public base URL" (Get-PublicBaseUrl)
  Add-Kv $b "MCP URL" "$(Get-PublicBaseUrl)/mcp"
  Add-Kv $b "Redirect URIs" (Get-EnvValue "OAUTH_REDIRECT_URIS" "(unset)")
  [void]$b.AppendLine("")
  [void]$b.AppendLine("Server disconnected: live token/session details unavailable.")
  return $b.ToString()
}

function Build-SessionsText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Browser Sessions"
  $data = Get-ConnectedJson "/dashboard/api/browser-sessions"
  if (!$data) {
    [void]$b.AppendLine("Server disconnected: browser session state unavailable.")
    return $b.ToString()
  }
  $sessions = ConvertTo-NonNullArray (Get-ObjectPath $data "sessions")
  if ($sessions.Length -eq 0) {
    [void]$b.AppendLine("No active browser sessions.")
    return $b.ToString()
  }
  foreach ($session in $sessions) {
    [void]$b.AppendLine("$($session.sessionId) [$($session.source)] $($session.browser)")
    [void]$b.AppendLine("  URL: $($session.url)")
    [void]$b.AppendLine("  Allowed: $(@($session.allowedHostnames) -join ', ')")
    [void]$b.AppendLine("  Pages: $($session.pageCount)")
  }
  return $b.ToString()
}

function Build-MonitorText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Live Monitor"
  $data = Get-ConnectedJson "/dashboard/api/monitor"
  if ($data) {
    $processPid = Get-ObjectPath $data "process.pid"
    Add-Kv $b "Process" $(if ($processPid) { "RUNNING pid=$processPid" } else { "not running" })
    Add-Kv $b "Script" (Get-ObjectPath $data "scriptPath")
    Add-Kv $b "Test root hint" (Get-ObjectPath $data "testRootHint")
    [void]$b.AppendLine("")
    [void]$b.AppendLine("Recent warnings")
    [void]$b.AppendLine("---------------")
    foreach ($warning in @((ConvertTo-NonNullArray (Get-ObjectPath $data "recentWarnings")) | Select-Object -First 40)) {
      [void]$b.AppendLine("$($warning.timestamp) [$($warning.risk)] $($warning.tool) - $($warning.message)")
    }
    return $b.ToString()
  }
  Add-Kv $b "Script" (Join-Path $RepoRoot "scripts\live-monitor.ps1")
  Add-Kv $b "Start bat" (Join-Path $RepoRoot "chatgpt-local-agent-mcp-live-monitor.bat")
  [void]$b.AppendLine("Server disconnected: monitor status unavailable.")
  return $b.ToString()
}

function Build-CloudflareText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Cloudflare"
  $data = Get-ConnectedJson "/dashboard/api/cloudflare"
  if ($data) {
    Add-Kv $b "Hostname" (Get-ObjectPath $data "hostname")
    $tunnelPid = Get-ObjectPath $data "tunnelProcess.pid"
    Add-Kv $b "Tunnel" $(if ($tunnelPid) { "RUNNING pid=$tunnelPid" } else { "not running" })
    $publicHealthOk = Get-ObjectPath $data "publicHealth.ok"
    Add-Kv $b "Public health" "$(if ($publicHealthOk) { 'OK' } else { 'FAIL' }) $(Get-ObjectPath $data 'publicHealth.message')"
    Add-Kv $b "Config" (Get-ObjectPath $data "configPath")
    Add-Kv $b "Exe" (Get-ObjectPath $data "exePath")
    [void]$b.AppendLine("")
    [void]$b.AppendLine("cloudflared.err.log")
    [void]$b.AppendLine("-------------------")
    [void]$b.AppendLine([string](Get-ObjectPath $data "logs.err.text"))
    return $b.ToString()
  }
  Add-Kv $b "Cloudflared exe" (Get-CloudflaredExe)
  Add-Kv $b "Cloudflared config" (Get-CloudflaredConfig)
  Add-Kv $b "Tunnel name" (Get-TunnelName)
  Add-Kv $b "Public URL" (Get-PublicBaseUrl)
  return $b.ToString()
}

function Build-ToolsText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Tools & Scopes"
  $data = Get-ConnectedJson "/dashboard/api/tools"
  if (!$data) {
    [void]$b.AppendLine("Server disconnected: tool registry unavailable.")
    return $b.ToString()
  }
  foreach ($tool in @(Get-ObjectPath $data "tools")) {
    [void]$b.AppendLine(("{0,2}. {1,-28} scope={2,-12} policy={3,-12} risk={4}" -f $tool.index, $tool.name, $tool.requiredScope, $tool.policyMode, (@($tool.riskTags) -join ",")))
  }
  return $b.ToString()
}

function Build-ArtifactsText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Artifacts"
  $data = Get-ConnectedJson "/dashboard/api/artifacts"
  if ($data) {
    foreach ($item in @(Get-ObjectPath $data "artifacts")) {
      [void]$b.AppendLine("$($item.label): $($item.files) files, $($item.size)")
      [void]$b.AppendLine("  $($item.path)")
      [void]$b.AppendLine("  cleanup target: $($item.cleanup)")
    }
    return $b.ToString()
  }
  Add-Kv $b "Journal" (Get-JournalPath)
  Add-Kv $b "Backups" (Get-BackupDir)
  Add-Kv $b "Data" $RuntimeDataDir
  return $b.ToString()
}

function Build-JournalText {
  $b = New-Object System.Text.StringBuilder
  Add-Header $b "Journal Explorer"
  $data = Get-ConnectedJson "/dashboard/api/journal-operations"
  if ($data) {
    [void]$b.AppendLine("Operations")
    [void]$b.AppendLine("----------")
    foreach ($op in @((@(Get-ObjectPath $data "operations")) | Select-Object -First 80)) {
      [void]$b.AppendLine("$($op.timestamp) [$($op.risk)] $($op.tool) $($op.outcome) $($op.operationId)")
      if ($op.error) { [void]$b.AppendLine("  error: $($op.error)") }
    }
    [void]$b.AppendLine("")
    [void]$b.AppendLine("Legacy entries")
    [void]$b.AppendLine("--------------")
    foreach ($entry in @((@(Get-ObjectPath $data "legacy")) | Select-Object -First 40)) {
      [void]$b.AppendLine("$($entry.timestamp) $($entry.tool) $($entry.outcome)")
    }
    return $b.ToString()
  }
  foreach ($event in @(Get-JournalEvents 160 | Select-Object -Last 100)) {
    [void]$b.AppendLine("$([string](Get-EventField $event 'timestamp')) $([string](Get-EventField $event 'tool')) $([string](Get-EventField $event 'outcome'))")
  }
  return $b.ToString()
}

function Build-AgentBrief {
  if ($script:ConnectedDebugBundle) {
    $bundleText = [string](Get-EventField $script:ConnectedDebugBundle "text")
    if ($bundleText) { return $bundleText }
  }
  if ($script:ConnectedStatus) {
    $remote = Invoke-JsonUrl "$(Get-LocalBaseUrl)/dashboard/api/agent-brief"
    $remoteText = [string](Get-EventField $remote "text")
    if ($remote -and $remoteText) { return $remoteText }
  }
  $listener = Get-McpListener
  $tunnel = Get-TunnelProcess
  $warnings = ConvertTo-NonNullArray (Get-Warnings (Get-JournalEvents 200))
  return @(
    "chatgpt-local-agent-mcp-fallback-diagnostic-brief",
    "",
    "Repo: $RepoRoot",
    "Local dashboard: $(Get-LocalBaseUrl)/dashboard",
    "Public URL: $(Get-PublicBaseUrl)",
    "MCP URL: $(Get-PublicBaseUrl)/mcp",
    "Local server: $(if ($listener) { "RUNNING pid=$($listener.OwningProcess)" } else { "STOPPED" })",
    "Tunnel: $(if ($tunnel) { "RUNNING pid=$($tunnel.ProcessId)" } else { "STOPPED" })",
    "Journal: $(Get-JournalPath)",
    "Warnings in recent journal: $($warnings.Length)",
    "Fallback app can start/stop the local MCP server and Cloudflare tunnel."
  ) -join [Environment]::NewLine
}

function New-Button {
  param([string]$Text, [int]$W = 132, [int]$H = 30)
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Size = New-Object System.Drawing.Size($W, $H)
  $button.Margin = New-Object System.Windows.Forms.Padding(0, 0, 8, 8)
  $script:Buttons += $button
  return $button
}

function Set-ButtonsEnabled {
  param([bool]$Enabled)
  foreach ($button in @($script:Buttons)) {
    if ($button -and -not $button.IsDisposed) {
      $button.Enabled = $Enabled
    }
  }
}

function Invoke-BackgroundAction {
  param(
    [string]$Title,
    [scriptblock]$Action,
    [scriptblock]$OnSuccess = $null,
    [object]$Data = $null
  )
  if ($script:IsBusy -or $script:IsRefreshing) {
    Write-AppConsole "Busy; ignored $Title."
    return
  }
  $script:IsBusy = $true
  Set-UiBusy $true $Title
  Write-AppConsole "$Title started."
  try {
    $result = & $Action $Data
    if ($OnSuccess) {
      & $OnSuccess $result
    }
    Write-AppConsole "$Title completed."
  } catch {
    Write-AppConsole "$Title failed: $($_.Exception.Message)"
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "$Title failed") | Out-Null
  } finally {
    $script:IsBusy = $false
    Set-UiBusy $false
  }
}

function Set-UiBusy {
  param([bool]$Busy, [string]$Message = "")
  if ($script:StatusLabel -and -not $script:StatusLabel.IsDisposed) {
    if ($Busy) {
      $script:StatusLabel.Text = if ($Message) { $Message } else { "Loading..." }
    } else {
      $script:StatusLabel.Text = $script:LastRefreshText
    }
  }
  Set-ButtonsEnabled (-not $Busy)
  if ($script:AutoRefreshButton -and -not $script:AutoRefreshButton.IsDisposed) {
    $script:AutoRefreshButton.Enabled = $true
  }
  if ($script:Form -and -not $script:Form.IsDisposed) {
    $script:Form.Cursor = if ($Busy) { [System.Windows.Forms.Cursors]::WaitCursor } else { [System.Windows.Forms.Cursors]::Default }
  }
  if ($Busy -and $Message) { Write-AppConsole $Message }
}

function New-TextBox {
  $box = New-Object System.Windows.Forms.TextBox
  $box.Dock = [System.Windows.Forms.DockStyle]::Fill
  $box.Multiline = $true
  $box.ScrollBars = "Both"
  $box.ReadOnly = $true
  $box.WordWrap = $false
  $box.Font = New-Object System.Drawing.Font("Consolas", 9)
  return $box
}

function Set-Box {
  param($Box, [string]$Text)
  if (!$Box -or $Box.IsDisposed) { return }
  if ($null -eq $Text) { $Text = "" }
  $normalized = $Text.Replace("`r`n", "`n").Replace("`n", "`r`n")
  if ($Box.Text -eq $normalized) { return }
  $Box.Text = $normalized
  $Box.SelectionStart = 0
  $Box.ScrollToCaret()
}

function Set-BoxSafe {
  param($Box, [string]$Title, [scriptblock]$Builder)
  try {
    Set-Box $Box (& $Builder)
  } catch {
    $message = "$Title unavailable.`r`n`r`n$($_.Exception.Message)`r`n`r`nLog: $script:FallbackLog"
    Write-FallbackLog "$Title refresh failed: $($_.Exception.GetType().FullName): $($_.Exception.Message)"
    Set-Box $Box $message
  }
}

function Get-PanelText {
  param([string]$Title, [scriptblock]$Builder)
  try {
    return (& $Builder)
  } catch {
    $message = "$Title unavailable.`r`n`r`n$($_.Exception.Message)`r`n`r`nLog: $script:FallbackLog"
    Write-FallbackLog "$Title refresh failed: $($_.Exception.GetType().FullName): $($_.Exception.Message)"
    return $message
  }
}

function Build-RefreshSnapshot {
  param([hashtable]$Request)
  $full = [bool]$Request.Full
  $selectedTab = [string]$Request.SelectedTab
  $snapshot = [ordered]@{
    boxes = @{}
    formTitle = ""
    lastRefreshText = ""
    lastBrief = $script:LastBrief
  }
  try {
    try {
      Read-EnvMap | Out-Null
    } catch {
      Write-FallbackLog "Read-EnvMap failed: $($_.Exception.Message)"
    }
    try {
      Refresh-ConnectedData
    } catch {
      Write-FallbackLog "Refresh-ConnectedData failed: $($_.Exception.Message)"
      $script:ConnectedStatus = $null
      $script:ConnectedActivity = $null
    }
    $snapshot.boxes["Status"] = Get-PanelText "Status" { Build-StatusText }
    if ($full -or [string]::IsNullOrWhiteSpace($selectedTab) -or $selectedTab -eq "GPT Activity") {
      $snapshot.boxes["GPT Activity"] = Get-PanelText "GPT Activity" { Build-ActivityText }
    }
    if ($full -or $selectedTab -eq "Security") { $snapshot.boxes["Security"] = Get-PanelText "Security" { Build-SecurityText } }
    if ($full -or $selectedTab -eq "Files") { $snapshot.boxes["Files"] = Get-PanelText "Files" { Build-FilesText } }
    if ($full -or $selectedTab -eq "Browser Desktop") { $snapshot.boxes["Browser Desktop"] = Get-PanelText "Browser Desktop" { Build-BrowserDesktopText } }
    if ($full -or $selectedTab -eq "Processes") { $snapshot.boxes["Processes"] = Get-PanelText "Processes" { Build-ProcessesText } }
    if ($full -or $selectedTab -eq "Tests") { $snapshot.boxes["Tests"] = Get-PanelText "Tests" { Build-TestsText } }
    if ($full -or $selectedTab -eq "Config") { $snapshot.boxes["Config"] = Get-PanelText "Config" { Build-ConfigText } }
    if ($full -or $selectedTab -eq "Maintenance") { $snapshot.boxes["Maintenance"] = Get-PanelText "Maintenance" { Build-MaintenanceText } }
    if ($full -or $selectedTab -eq "Auth") { $snapshot.boxes["Auth"] = Get-PanelText "Auth" { Build-AuthText } }
    if ($full -or $selectedTab -eq "Sessions") { $snapshot.boxes["Sessions"] = Get-PanelText "Sessions" { Build-SessionsText } }
    if ($full -or $selectedTab -eq "Monitor") { $snapshot.boxes["Monitor"] = Get-PanelText "Monitor" { Build-MonitorText } }
    if ($full -or $selectedTab -eq "Cloudflare") { $snapshot.boxes["Cloudflare"] = Get-PanelText "Cloudflare" { Build-CloudflareText } }
    if ($full -or $selectedTab -eq "Tools") { $snapshot.boxes["Tools"] = Get-PanelText "Tools" { Build-ToolsText } }
    if ($full -or $selectedTab -eq "Artifacts") { $snapshot.boxes["Artifacts"] = Get-PanelText "Artifacts" { Build-ArtifactsText } }
    if ($full -or $selectedTab -eq "Journal") { $snapshot.boxes["Journal"] = Get-PanelText "Journal" { Build-JournalText } }
    if ($full) {
      try {
        $snapshot.lastBrief = Build-AgentBrief
      } catch {
        Write-FallbackLog "Build-AgentBrief failed: $($_.Exception.Message)"
      }
    }
    $snapshot.formTitle = "chatgpt-local-agent-mcp-fallback-dashboard - $(if ($script:ConnectedStatus) { 'server connected' } else { 'fallback mode' })"
    $snapshot.lastRefreshText = "Last refresh: $(Get-Date -Format 'HH:mm:ss')"
    return $snapshot
  } catch {
    throw $_
  }
}

function Apply-RefreshSnapshot {
  param($Snapshot)
  if ($null -eq $Snapshot) { throw "Refresh returned no snapshot." }
  $boxMap = @{
    "Status" = $script:StatusBox
    "GPT Activity" = $script:ActivityBox
    "Security" = $script:SecurityBox
    "Files" = $script:FilesBox
    "Browser Desktop" = $script:BrowserBox
    "Processes" = $script:ProcessesBox
    "Tests" = $script:TestsBox
    "Config" = $script:ConfigBox
    "Maintenance" = $script:MaintenanceBox
    "Auth" = $script:AuthBox
    "Sessions" = $script:SessionsBox
    "Monitor" = $script:MonitorBox
    "Cloudflare" = $script:CloudflareBox
    "Tools" = $script:ToolsBox
    "Artifacts" = $script:ArtifactsBox
    "Journal" = $script:JournalBox
  }
  foreach ($key in $Snapshot.boxes.Keys) {
    if ($boxMap.ContainsKey($key)) {
      try {
        Set-Box $boxMap[$key] ([string]$Snapshot.boxes[$key])
      } catch {
        Write-FallbackLog "Failed to render $key panel: $($_.Exception.GetType().FullName): $($_.Exception.Message)"
      }
    }
  }
  $script:LastBrief = [string]$Snapshot.lastBrief
  if ($script:Form -and -not $script:Form.IsDisposed) {
    $script:Form.Text = [string]$Snapshot.formTitle
  }
  $script:LastRefreshText = [string]$Snapshot.lastRefreshText
  Write-AppConsole "Refresh completed."
}

function Start-Refresh {
  param([bool]$Full = $true)
  if ($script:IsRefreshing -or $script:IsBusy) { return }
  $script:IsRefreshing = $true
  $selectedTab = if ($tabs.SelectedTab) { $tabs.SelectedTab.Text } else { "" }
  Set-UiBusy $true "Loading current status..."
  try {
    $snapshot = Build-RefreshSnapshot @{ Full = $Full; SelectedTab = $selectedTab }
    Apply-RefreshSnapshot $snapshot
  } catch {
    $message = "Refresh failed: $($_.Exception.Message)"
    Write-AppConsole $message
    Write-FallbackLog "$message`n$($_.ScriptStackTrace)"
    [System.Windows.Forms.MessageBox]::Show($message, "Refresh failed") | Out-Null
  } finally {
    $script:IsRefreshing = $false
    Set-UiBusy $false
  }
}

function Run-ConnectedTests {
  $script:ConnectedTests = Invoke-JsonUrl "$(Get-LocalBaseUrl)/dashboard/api/smoke-tests" 12
  return (Build-TestsText)
}

function Start-ConnectedTests {
  Invoke-BackgroundAction "Checks" { Run-ConnectedTests } {
    param($text)
    Set-Box $script:TestsBox ([string]$text)
  }
}

Read-EnvMap | Out-Null

[System.Windows.Forms.Application]::EnableVisualStyles()

$script:Form = New-Object System.Windows.Forms.Form
$script:Form.Text = "chatgpt-local-agent-mcp-fallback-dashboard"
$script:Form.Size = New-Object System.Drawing.Size(1220, 800)
$script:Form.MinimumSize = New-Object System.Drawing.Size(1040, 680)
$script:Form.StartPosition = "CenterScreen"

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = [System.Windows.Forms.DockStyle]::Fill
$root.ColumnCount = 1
$root.RowCount = 3
$root.Padding = New-Object System.Windows.Forms.Padding(10)
[void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 74)))
[void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 145)))
$script:Form.Controls.Add($root)

$commandPanel = New-Object System.Windows.Forms.TableLayoutPanel
$commandPanel.Dock = [System.Windows.Forms.DockStyle]::Fill
$commandPanel.ColumnCount = 1
$commandPanel.RowCount = 2
[void]$commandPanel.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 50)))
[void]$commandPanel.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 50)))
$root.Controls.Add($commandPanel, 0, 0)

$topActions = New-Object System.Windows.Forms.FlowLayoutPanel
$topActions.Dock = [System.Windows.Forms.DockStyle]::Fill
$topActions.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
$topActions.WrapContents = $true
$topActions.Padding = New-Object System.Windows.Forms.Padding(0, 0, 0, 0)
$commandPanel.Controls.Add($topActions, 0, 0)

$opsActions = New-Object System.Windows.Forms.FlowLayoutPanel
$opsActions.Dock = [System.Windows.Forms.DockStyle]::Fill
$opsActions.FlowDirection = [System.Windows.Forms.FlowDirection]::LeftToRight
$opsActions.WrapContents = $true
$opsActions.Padding = New-Object System.Windows.Forms.Padding(0, 0, 0, 0)
$commandPanel.Controls.Add($opsActions, 0, 1)

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = [System.Windows.Forms.DockStyle]::Fill
$root.Controls.Add($tabs, 0, 1)

$consolePanel = New-Object System.Windows.Forms.TableLayoutPanel
$consolePanel.Dock = [System.Windows.Forms.DockStyle]::Fill
$consolePanel.ColumnCount = 2
$consolePanel.RowCount = 1
[void]$consolePanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$consolePanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 116)))
$root.Controls.Add($consolePanel, 0, 2)

$script:ConsoleBox = New-Object System.Windows.Forms.TextBox
$script:ConsoleBox.Dock = [System.Windows.Forms.DockStyle]::Fill
$script:ConsoleBox.Multiline = $true
$script:ConsoleBox.ScrollBars = "Vertical"
$script:ConsoleBox.ReadOnly = $true
$script:ConsoleBox.WordWrap = $false
$script:ConsoleBox.Font = New-Object System.Drawing.Font("Consolas", 9)
$script:ConsoleBox.BackColor = [System.Drawing.Color]::FromArgb(28, 28, 28)
$script:ConsoleBox.ForeColor = [System.Drawing.Color]::Gainsboro
$consolePanel.Controls.Add($script:ConsoleBox, 0, 0)

$consoleButtons = New-Object System.Windows.Forms.FlowLayoutPanel
$consoleButtons.Dock = [System.Windows.Forms.DockStyle]::Fill
$consoleButtons.FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
$consoleButtons.WrapContents = $false
$consoleButtons.Padding = New-Object System.Windows.Forms.Padding(8, 0, 0, 0)
$consolePanel.Controls.Add($consoleButtons, 1, 0)

$script:AutoRefreshTimer = New-Object System.Windows.Forms.Timer
$script:AutoRefreshTimer.Interval = 10000
$script:AutoRefreshTimer.Add_Tick({
  if ($script:AutoRefreshEnabled -and -not $script:IsRefreshing) {
    Start-Refresh $false
  }
})

$script:StatusLabel = New-Object System.Windows.Forms.Label
$script:StatusLabel.AutoSize = $false
$script:StatusLabel.Size = New-Object System.Drawing.Size(220, 30)
$script:StatusLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$script:StatusLabel.Text = $script:LastRefreshText
$script:StatusLabel.Margin = New-Object System.Windows.Forms.Padding(0, 0, 8, 8)
$topActions.Controls.Add($script:StatusLabel)

$topRefresh = New-Button "Refresh" 86 28
$topRefresh.Add_Click({ Start-Refresh $true })
$topActions.Controls.Add($topRefresh)

$script:AutoRefreshButton = New-Button "Auto: Off" 98 28
$script:AutoRefreshButton.Add_Click({
  $script:AutoRefreshEnabled = -not $script:AutoRefreshEnabled
  $script:AutoRefreshButton.Text = if ($script:AutoRefreshEnabled) { "Auto: On" } else { "Auto: Off" }
  if ($script:AutoRefreshEnabled) {
    $script:AutoRefreshTimer.Start()
    $script:LastRefreshText = "Auto refresh enabled."
  } else {
    $script:AutoRefreshTimer.Stop()
    $script:LastRefreshText = "Auto refresh disabled."
  }
  Set-UiBusy $false
})
$topActions.Controls.Add($script:AutoRefreshButton)

$clearConsole = New-Button "Clear" 96
$clearConsole.Add_Click({ $script:ConsoleBox.Clear(); Write-AppConsole "Console cleared." })
$consoleButtons.Controls.Add($clearConsole)

$copyConsole = New-Button "Copy" 96
$copyConsole.Add_Click({ if ($script:ConsoleBox.Text) { [System.Windows.Forms.Clipboard]::SetText($script:ConsoleBox.Text) } })
$consoleButtons.Controls.Add($copyConsole)

$openFallbackLog = New-Button "Open Log" 96
$openFallbackLog.Add_Click({ if (Test-Path -LiteralPath $script:FallbackLog) { Start-Process $script:FallbackLog } else { Write-AppConsole "Fallback log has not been created yet." } })
$consoleButtons.Controls.Add($openFallbackLog)

$copyBrief = New-Button "Copy Brief" 98 28
$copyBrief.Add_Click({ Write-AppConsole "Copying agent brief..."; $script:LastBrief = Build-AgentBrief; [System.Windows.Forms.Clipboard]::SetText($script:LastBrief); Write-AppConsole "Agent brief copied." })
$topActions.Controls.Add($copyBrief)

$openWeb = New-Button "Web Dashboard" 118 28
$openWeb.Add_Click({ Write-AppConsole "Opening web dashboard."; Start-Process "$(Get-LocalBaseUrl)/dashboard" })
$topActions.Controls.Add($openWeb)

$openRepo = New-Button "Repo" 70 28
$openRepo.Add_Click({ Write-AppConsole "Opening repository folder."; Start-Process $RepoRoot })
$topActions.Controls.Add($openRepo)

$runTests = New-Button "Checks" 80 28
$runTests.Add_Click({ Start-ConnectedTests })
$topActions.Controls.Add($runTests)

$serverLabel = New-Object System.Windows.Forms.Label
$serverLabel.AutoSize = $false
$serverLabel.Size = New-Object System.Drawing.Size(52, 28)
$serverLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$serverLabel.Text = "Server"
$serverLabel.Margin = New-Object System.Windows.Forms.Padding(0, 0, 4, 8)
$opsActions.Controls.Add($serverLabel)

$startServer = New-Button "Start" 74 28
$startServer.Add_Click({ Write-AppConsole "Starting local server..."; Invoke-ControlAction { Start-McpServer } "Start Server"; Write-AppConsole "Start server action completed." })
$opsActions.Controls.Add($startServer)

$stopServer = New-Button "Stop" 74 28
$stopServer.Add_Click({ Write-AppConsole "Stopping local server..."; Invoke-ControlAction { Stop-McpServer } "Stop Server"; Write-AppConsole "Stop server action completed." })
$opsActions.Controls.Add($stopServer)

$restartServer = New-Button "Restart" 82 28
$restartServer.Add_Click({ Write-AppConsole "Restarting local server..."; Invoke-ControlAction { Restart-McpServer } "Restart Server"; Write-AppConsole "Restart server action completed." })
$opsActions.Controls.Add($restartServer)

$divider = New-Object System.Windows.Forms.Label
$divider.AutoSize = $false
$divider.Size = New-Object System.Drawing.Size(20, 28)
$divider.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$divider.Text = "|"
$divider.Margin = New-Object System.Windows.Forms.Padding(6, 0, 6, 8)
$opsActions.Controls.Add($divider)

$tunnelLabel = New-Object System.Windows.Forms.Label
$tunnelLabel.AutoSize = $false
$tunnelLabel.Size = New-Object System.Drawing.Size(52, 28)
$tunnelLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$tunnelLabel.Text = "Tunnel"
$tunnelLabel.Margin = New-Object System.Windows.Forms.Padding(0, 0, 4, 8)
$opsActions.Controls.Add($tunnelLabel)

$startTunnel = New-Button "Start" 74 28
$startTunnel.Add_Click({ Write-AppConsole "Starting Cloudflare tunnel..."; Invoke-ControlAction { Start-Tunnel } "Start Tunnel"; Write-AppConsole "Start tunnel action completed." })
$opsActions.Controls.Add($startTunnel)

$stopTunnel = New-Button "Stop" 74 28
$stopTunnel.Add_Click({ Write-AppConsole "Stopping Cloudflare tunnel..."; Invoke-ControlAction { Stop-Tunnel } "Stop Tunnel"; Write-AppConsole "Stop tunnel action completed." })
$opsActions.Controls.Add($stopTunnel)

$restartTunnel = New-Button "Restart" 82 28
$restartTunnel.Add_Click({ Write-AppConsole "Restarting Cloudflare tunnel..."; Invoke-ControlAction { Restart-Tunnel } "Restart Tunnel"; Write-AppConsole "Restart tunnel action completed." })
$opsActions.Controls.Add($restartTunnel)

function Add-Tab {
  param([string]$Title)
  $tab = New-Object System.Windows.Forms.TabPage
  $tab.Text = $Title
  $tab.Padding = New-Object System.Windows.Forms.Padding(8)
  $box = New-TextBox
  $box.Text = "Ready. Press Refresh to load current status."
  $tab.Controls.Add($box)
  $tabs.Controls.Add($tab)
  return $box
}

$script:StatusBox = Add-Tab "Status"
$script:ActivityBox = Add-Tab "GPT Activity"
$script:SecurityBox = Add-Tab "Security"
$script:FilesBox = Add-Tab "Files"
$script:BrowserBox = Add-Tab "Browser Desktop"
$script:ProcessesBox = Add-Tab "Processes"
$script:TestsBox = Add-Tab "Tests"
$script:ConfigBox = Add-Tab "Config"
$script:MaintenanceBox = Add-Tab "Maintenance"
$script:AuthBox = Add-Tab "Auth"
$script:SessionsBox = Add-Tab "Sessions"
$script:MonitorBox = Add-Tab "Monitor"
$script:CloudflareBox = Add-Tab "Cloudflare"
$script:ToolsBox = Add-Tab "Tools"
$script:ArtifactsBox = Add-Tab "Artifacts"
$script:JournalBox = Add-Tab "Journal"

$tabs.Add_SelectedIndexChanged({
  # Keep tab switching instant. Data loading is explicit through Refresh.
})

$script:Form.Add_Shown({
  Set-Box $script:StatusBox "Ready. Press Refresh to load current status. The app will stay responsive while idle."
  Write-AppConsole "App ready."
})
$script:Form.Add_FormClosing({
  $script:IsClosing = $true
  if ($script:AutoRefreshTimer) {
    $script:AutoRefreshTimer.Stop()
    $script:AutoRefreshTimer.Dispose()
  }
})

[void][System.Windows.Forms.Application]::Run($script:Form)
