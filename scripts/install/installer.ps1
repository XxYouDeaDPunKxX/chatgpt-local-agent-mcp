$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ([Threading.Thread]::CurrentThread.ApartmentState -ne "STA") {
  [System.Windows.Forms.MessageBox]::Show("This WinForms installer must be launched with powershell.exe -STA.", "Unsupported PowerShell host") | Out-Null
  exit 1
}

$SourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$DefaultInstallRoot = Join-Path $env:LOCALAPPDATA "AgenticFilesystemMCP"
$script:InstallRoot = $DefaultInstallRoot
$SourceEnvExamplePath = Join-Path $SourceRoot ".env.example"
$InstallLog = Join-Path ([System.IO.Path]::GetTempPath()) "agentic-filesystem-mcp-installer.log"
$script:State = [ordered]@{
  IsClosing = $false
  IsBusy = $false
  LastAction = ""
  EnvMap = @{}
}
$script:InstallLogLines = New-Object System.Collections.Generic.List[string]
$script:MaxInstallLogLines = 500
$script:Form = $null
$script:LogBox = $null
$script:StatusLabel = $null
$script:PreflightList = $null
$script:ChecksList = $null

function Invoke-InstallerUi {
  param(
    [System.Windows.Forms.Control]$Control,
    [System.Delegate]$Callback,
    [object[]]$Arguments = @()
  )
  if ($script:State.IsClosing -or !$Control -or $Control.IsDisposed -or !$Control.IsHandleCreated) { return }
  try {
    [void]$Control.BeginInvoke($Callback, $Arguments)
  } catch {
    Add-Content -LiteralPath $InstallLog -Value ("{0:s} UI dispatch failed: {1}" -f (Get-Date), $_.Exception.Message)
  }
}

function Get-InstallRoot {
  return $script:InstallRoot
}

function Set-InstallRoot {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { $Path = $DefaultInstallRoot }
  $script:InstallRoot = [System.IO.Path]::GetFullPath($Path)
  if ($script:InstallFolderText -and -not $script:InstallFolderText.IsDisposed) {
    $script:InstallFolderText.Text = $script:InstallRoot
  }
}

function Get-InstalledEnvExamplePath { Join-Path (Get-InstallRoot) ".env.example" }
function Get-InstalledEnvPath { Join-Path (Get-InstallRoot) ".env" }

function Normalize-DirectoryPath {
  param([string]$Path)
  return [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Test-IsSameOrChildPath {
  param([string]$ParentPath, [string]$CandidatePath)
  $parent = Normalize-DirectoryPath $ParentPath
  $candidate = Normalize-DirectoryPath $CandidatePath
  if ($candidate.Equals($parent, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $candidate.StartsWith($parent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-InstallRootSafe {
  $installRoot = Get-InstallRoot
  if ([string]::IsNullOrWhiteSpace($installRoot)) { throw "Install folder is required." }
  if ((Test-IsSameOrChildPath $SourceRoot $installRoot) -or (Test-IsSameOrChildPath $installRoot $SourceRoot)) {
    throw "Install folder must not overlap the source repo. Choose a runtime folder such as $DefaultInstallRoot."
  }
}

function Write-InstallLog {
  param([string]$Message)
  $line = "{0:s} {1}" -f (Get-Date), $Message
  Add-Content -LiteralPath $InstallLog -Value $line
  if ($script:LogBox -and -not $script:LogBox.IsDisposed -and $script:LogBox.IsHandleCreated) {
    $appendLogLine = [Action[string]]{
      param([string]$Text)
      if ($script:State.IsClosing -or $script:LogBox.IsDisposed) { return }
      $script:InstallLogLines.Add($Text)
      while ($script:InstallLogLines.Count -gt $script:MaxInstallLogLines) {
        $script:InstallLogLines.RemoveAt(0)
      }
      $script:LogBox.Text = ($script:InstallLogLines -join [Environment]::NewLine)
      $script:LogBox.SelectionStart = $script:LogBox.TextLength
      $script:LogBox.ScrollToCaret()
    }
    Invoke-InstallerUi $script:LogBox $appendLogLine @($line)
  }
}

function Set-UiStatus {
  param([string]$Message, [string]$Kind = "info")
  if (!$script:StatusLabel -or $script:StatusLabel.IsDisposed -or !$script:StatusLabel.IsHandleCreated) { return }
  $setStatus = [Action[string,string]]{
    param([string]$Text, [string]$StatusKind)
    if ($script:State.IsClosing -or $script:StatusLabel.IsDisposed) { return }
    $script:StatusLabel.Text = $Text
    switch ($StatusKind) {
      "ok" { $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(0, 128, 80) }
      "warn" { $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(170, 105, 0) }
      "bad" { $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(180, 40, 40) }
      default { $script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(40, 55, 70) }
    }
  }
  Invoke-InstallerUi $script:StatusLabel $setStatus @($Message, $Kind)
}

function Set-Busy {
  param([bool]$Busy, [string]$Message = "")
  $script:State.IsBusy = $Busy
  if ($script:Form -and -not $script:Form.IsDisposed -and $script:Form.IsHandleCreated) {
    $setBusyUi = [Action[bool,string]]{
      param([bool]$IsBusy, [string]$Text)
      if ($script:State.IsClosing -or $script:Form.IsDisposed) { return }
      foreach ($button in $script:ActionButtons) {
        if ($button -and -not $button.IsDisposed) { $button.Enabled = -not $IsBusy }
      }
      $script:Form.Cursor = if ($IsBusy) { [System.Windows.Forms.Cursors]::WaitCursor } else { [System.Windows.Forms.Cursors]::Default }
      if ($Text) { $script:StatusLabel.Text = $Text }
    }
    Invoke-InstallerUi $script:Form $setBusyUi @($Busy, $Message)
  }
}

function Invoke-BackgroundAction {
  param(
    [string]$Name,
    [scriptblock]$Action,
    [object]$Data = $null
  )
  if ($script:State.IsBusy) {
    [System.Windows.Forms.MessageBox]::Show("Another installer action is already running.", "Installer busy") | Out-Null
    return
  }

  $script:State.LastAction = $Name
  Set-Busy $true "Running: $Name"
  Write-InstallLog "START $Name"

  try {
    & $Action $Data
    Write-InstallLog "OK $Name"
    Set-UiStatus "$Name completed." "ok"
  } catch {
    Write-InstallLog "FAIL $Name - $($_.Exception.Message)"
    Set-UiStatus "$Name failed. See installer log." "bad"
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "$Name failed") | Out-Null
  } finally {
    Set-Busy $false
  }
}

function Read-KeyValueFile {
  param([string]$Path)
  $map = @{}
  if (!(Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*#') { continue }
    if ($line -notmatch '^\s*([^=]+)=(.*)$') { continue }
    $map[$matches[1].Trim()] = $matches[2].Trim()
  }
  return $map
}

function Read-InstallerEnv {
  $envExamplePath = if (Test-Path -LiteralPath (Get-InstalledEnvExamplePath)) { Get-InstalledEnvExamplePath } else { $SourceEnvExamplePath }
  $base = Read-KeyValueFile $envExamplePath
  $actual = Read-KeyValueFile (Get-InstalledEnvPath)
  foreach ($key in $actual.Keys) { $base[$key] = $actual[$key] }
  $script:State.EnvMap = $base
  return $base
}

function Get-MapValue {
  param([hashtable]$Map, [string]$Name, [string]$Fallback = "")
  if ($Map.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace([string]$Map[$Name])) { return [string]$Map[$Name] }
  return $Fallback
}

function Set-MapValue {
  param([hashtable]$Map, [string]$Name, [string]$Value)
  $Map[$Name] = $Value
}

function Redact-Value {
  param([string]$Name, [string]$Value)
  if ($Name -match '(?i)(SECRET|TOKEN|PASSWORD|API_KEY)') {
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    return "[REDACTED]"
  }
  return $Value
}

function Join-ProcessArguments {
  param([string[]]$Arguments)
  return ($Arguments | ForEach-Object {
    if ($_ -match '[\s"]') {
      '"' + ($_.Replace('\', '\\').Replace('"', '\"')) + '"'
    } else {
      $_
    }
  }) -join " "
}

function Write-EnvFromMap {
  param([hashtable]$Map)
  $envExamplePath = if (Test-Path -LiteralPath (Get-InstalledEnvExamplePath)) { Get-InstalledEnvExamplePath } else { $SourceEnvExamplePath }
  $envPath = Get-InstalledEnvPath
  if (!(Test-Path -LiteralPath $envExamplePath)) {
    throw ".env.example not found. Cannot create .env safely."
  }
  $templateKeys = @{}
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($line in Get-Content -LiteralPath $envExamplePath) {
    if ($line -match '^\s*#' -or $line -notmatch '^\s*([^=]+)=') {
      $lines.Add($line)
      continue
    }
    $key = $matches[1].Trim()
    $templateKeys[$key.ToLowerInvariant()] = $true
    $value = if ($Map.ContainsKey($key)) { [string]$Map[$key] } else { "" }
    $lines.Add("$key=$value")
  }
  $customLines = New-Object System.Collections.Generic.List[string]
  if (Test-Path -LiteralPath $envPath) {
    foreach ($line in Get-Content -LiteralPath $envPath) {
      if ($line -notmatch '^\s*([^#][^=]*)=(.*)$') { continue }
      $key = $matches[1].Trim()
      if (!$templateKeys.ContainsKey($key.ToLowerInvariant())) {
        $customLines.Add($line)
      }
    }
  }
  if ($customLines.Count -gt 0) {
    $lines.Add("")
    $lines.Add("# Custom local settings preserved by installer")
    foreach ($line in $customLines) {
      $lines.Add($line)
    }
  }
  New-Item -ItemType Directory -Force -Path (Get-InstallRoot) | Out-Null
  Set-Content -LiteralPath $envPath -Value $lines -Encoding UTF8
  Write-InstallLog ".env written with secrets redacted from installer log."
}

function Test-CommandAvailable {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  return [bool]$cmd
}

function Copy-DirectoryContents {
  param([string]$Source, [string]$Destination)
  if (!(Test-Path -LiteralPath $Source)) { return }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    $target = Join-Path $Destination $_.Name
    if ($_.PSIsContainer) {
      Copy-DirectoryContents $_.FullName $target
    } else {
      Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
  }
}

function Install-AppFiles {
  $installRoot = Get-InstallRoot
  if ([string]::IsNullOrWhiteSpace($installRoot)) { throw "Install folder is required." }
  Assert-InstallRootSafe
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  Write-InstallLog "Installing app files from $SourceRoot to $installRoot"

  $directories = @("src", "scripts", "apps", "dashboard", "tests")
  foreach ($name in $directories) {
    $source = Join-Path $SourceRoot $name
    $destination = Join-Path $installRoot $name
    if (Test-Path -LiteralPath $source) {
      Copy-DirectoryContents $source $destination
    }
  }

  $files = @(
    ".env.example",
    ".gitignore",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "Agentic Filesystem MCP Control.bat",
    "Start Live Monitor.bat",
    "Install Agentic Filesystem MCP.bat",
    "AI_WINFORMS_UI_CONTRACT.md"
  )
  foreach ($name in $files) {
    $source = Join-Path $SourceRoot $name
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $installRoot $name) -Force
    }
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $installRoot "data") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $installRoot "logs") | Out-Null
  Write-InstallLog "App files installed. Existing .env, data, logs, node_modules, and dist were preserved unless overwritten by build/dependency steps."
}

function Invoke-ProcessLogged {
  param(
    [string]$FileName,
    [string[]]$Arguments,
    [int]$TimeoutSeconds = 600
  )
  Write-InstallLog ("RUN {0} {1}" -f $FileName, ($Arguments -join " "))
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $FileName
  $psi.Arguments = Join-ProcessArguments $Arguments
  $psi.WorkingDirectory = Get-InstallRoot
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $process = [System.Diagnostics.Process]::Start($psi)
  if (!$process) { throw "Failed to start $FileName" }
  $stdout = New-Object System.Collections.Concurrent.ConcurrentQueue[string]
  $stderr = New-Object System.Collections.Concurrent.ConcurrentQueue[string]
  $process.add_OutputDataReceived({
    param($sender, $eventArgs)
    if ($eventArgs.Data) { $stdout.Enqueue($eventArgs.Data); Write-InstallLog $eventArgs.Data }
  })
  $process.add_ErrorDataReceived({
    param($sender, $eventArgs)
    if ($eventArgs.Data) { $stderr.Enqueue($eventArgs.Data); Write-InstallLog $eventArgs.Data }
  })
  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()
  if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
    try {
      $process.Kill()
    } catch {
      Write-InstallLog "Failed to kill timed-out process: $($_.Exception.Message)"
    }
    throw "$FileName timed out after $TimeoutSeconds seconds"
  }
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    throw "$FileName exited with code $($process.ExitCode)"
  }
}

function Add-CheckLine {
  param([string]$Name, [bool]$Ok, [string]$Detail)
  $prefix = if ($Ok) { "OK" } else { "NEEDS ACTION" }
  $text = "$prefix - $Name - $Detail"
  Write-InstallLog $text
  if ($script:PreflightList -and -not $script:PreflightList.IsDisposed -and $script:PreflightList.IsHandleCreated) {
    $addPreflightLine = [Action[string]]{
      param([string]$Line)
      [void]$script:PreflightList.Items.Add($Line)
    }
    Invoke-InstallerUi $script:PreflightList $addPreflightLine @($text)
  }
}

function Run-Preflight {
  $installRoot = Get-InstallRoot
  if ($script:PreflightList -and $script:PreflightList.IsHandleCreated) {
    Invoke-InstallerUi $script:PreflightList ([Action]{ $script:PreflightList.Items.Clear() })
  }
  Add-CheckLine "Windows desktop" ($env:OS -eq "Windows_NT") "WinForms requires interactive Windows."
  Add-CheckLine "STA host" ([Threading.Thread]::CurrentThread.ApartmentState -eq "STA") "Current apartment: $([Threading.Thread]::CurrentThread.ApartmentState)"
  Add-CheckLine "source package.json" (Test-Path -LiteralPath (Join-Path $SourceRoot "package.json")) "Source package manifest"
  Add-CheckLine "source package-lock.json" (Test-Path -LiteralPath (Join-Path $SourceRoot "package-lock.json")) "Source lockfile"
  Add-CheckLine "install folder" (Test-Path -LiteralPath $installRoot) $installRoot
  Add-CheckLine "installed package.json" (Test-Path -LiteralPath (Join-Path $installRoot "package.json")) "Run Install/Update App Files if missing"
  Add-CheckLine "node" (Test-CommandAvailable "node") "Required runtime"
  Add-CheckLine "npm" (Test-CommandAvailable "npm") "Required package manager"
  Add-CheckLine "git" (Test-CommandAvailable "git") "Optional but recommended"
  Add-CheckLine ".env.example" (Test-Path -LiteralPath (Get-InstalledEnvExamplePath)) "Installed template config"
  Add-CheckLine ".env" (Test-Path -LiteralPath (Get-InstalledEnvPath)) "Installed local private config"
  Add-CheckLine "node_modules" (Test-Path -LiteralPath (Join-Path $installRoot "node_modules")) "Installed dependencies"
  Add-CheckLine "dist" (Test-Path -LiteralPath (Join-Path $installRoot "dist\index.js")) "Built server"
  $cloudflared = Get-MapValue (Read-InstallerEnv) "CLOUDFLARED_EXE" ""
  Add-CheckLine "cloudflared" ([string]::IsNullOrWhiteSpace($cloudflared) -or (Test-Path -LiteralPath $cloudflared)) "Optional tunnel executable"
}

function Load-ConfigIntoUi {
  $map = Read-InstallerEnv
  $script:AuthRequired.Checked = (Get-MapValue $map "AUTH_REQUIRED" "true") -eq "true"
  $script:TunnelEnabled.Checked = (Get-MapValue $map "CLOUDFLARE_TUNNEL_ENABLED" "false") -eq "true"
  $script:PublicBaseUrl.Text = Get-MapValue $map "PUBLIC_BASE_URL" "http://127.0.0.1:8789"
  $script:AllowedGithubLogins.Text = Get-MapValue $map "ALLOWED_GITHUB_LOGINS" ""
  $script:GithubClientId.Text = Get-MapValue $map "GITHUB_CLIENT_ID" ""
  $script:GithubClientSecret.Text = Get-MapValue $map "GITHUB_CLIENT_SECRET" ""
  $script:OauthClientId.Text = Get-MapValue $map "OAUTH_CLIENT_ID" ""
  $script:OauthClientSecret.Text = Get-MapValue $map "OAUTH_CLIENT_SECRET" ""
  $script:OauthRedirectUris.Text = Get-MapValue $map "OAUTH_REDIRECT_URIS" ""
  $script:DefaultCwd.Text = Get-MapValue $map "GPT_FS_MCP_DEFAULT_CWD" ""
  $script:CloudflaredExe.Text = Get-MapValue $map "CLOUDFLARED_EXE" ""
  $script:CloudflaredConfig.Text = Get-MapValue $map "CLOUDFLARED_CONFIG" ""
  $script:TunnelName.Text = Get-MapValue $map "CLOUDFLARE_TUNNEL_NAME" "agentic-filesystem-mcp"
}

function Get-ConfigSnapshotFromUi {
  return @{
    AUTH_REQUIRED = $script:AuthRequired.Checked.ToString().ToLowerInvariant()
    CLOUDFLARE_TUNNEL_ENABLED = $script:TunnelEnabled.Checked.ToString().ToLowerInvariant()
    PUBLIC_BASE_URL = $script:PublicBaseUrl.Text.Trim()
    ALLOWED_GITHUB_LOGINS = $script:AllowedGithubLogins.Text.Trim()
    GITHUB_CLIENT_ID = $script:GithubClientId.Text.Trim()
    GITHUB_CLIENT_SECRET = $script:GithubClientSecret.Text
    OAUTH_CLIENT_ID = $script:OauthClientId.Text.Trim()
    OAUTH_CLIENT_SECRET = $script:OauthClientSecret.Text
    OAUTH_REDIRECT_URIS = $script:OauthRedirectUris.Text.Trim()
    GPT_FS_MCP_DEFAULT_CWD = $script:DefaultCwd.Text.Trim()
    CLOUDFLARED_EXE = $script:CloudflaredExe.Text.Trim()
    CLOUDFLARED_CONFIG = $script:CloudflaredConfig.Text.Trim()
    CLOUDFLARE_TUNNEL_NAME = $script:TunnelName.Text.Trim()
  }
}

function Assert-ConfigSnapshotSafe {
  param([hashtable]$Snapshot)
  $authRequired = ([string]$Snapshot.AUTH_REQUIRED) -eq "true"
  $tunnelEnabled = ([string]$Snapshot.CLOUDFLARE_TUNNEL_ENABLED) -eq "true"
  $publicBaseUrl = [string]$Snapshot.PUBLIC_BASE_URL
  $parsedPublicBaseUrl = $null
  $isLocalBaseUrl = $false
  if ([System.Uri]::TryCreate($publicBaseUrl, [System.UriKind]::Absolute, [ref]$parsedPublicBaseUrl)) {
    $isLocalBaseUrl = $parsedPublicBaseUrl.Scheme -in @("http", "https") -and $parsedPublicBaseUrl.Host -in @("127.0.0.1", "localhost", "::1", "[::1]")
  }

  if (!$authRequired -and ($tunnelEnabled -or !$isLocalBaseUrl)) {
    throw "AUTH_REQUIRED=false is allowed only for localhost development with no tunnel. Enable OAuth auth before using a public URL or Cloudflare Tunnel."
  }

  if ($authRequired) {
    $required = @(
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "ALLOWED_GITHUB_LOGINS",
      "OAUTH_CLIENT_ID",
      "OAUTH_CLIENT_SECRET",
      "OAUTH_REDIRECT_URIS"
    )
    $missing = @()
    foreach ($key in $required) {
      if ([string]::IsNullOrWhiteSpace([string]$Snapshot[$key])) {
        $missing += $key
      }
    }
    if ($missing.Count -gt 0) {
      throw "AUTH_REQUIRED=true requires: $($missing -join ', ')"
    }
  }
}

function Save-ConfigSnapshot {
  param([hashtable]$Snapshot)
  Assert-ConfigSnapshotSafe $Snapshot
  $map = Read-InstallerEnv
  foreach ($key in $Snapshot.Keys) {
    Set-MapValue $map $key ([string]$Snapshot[$key])
  }
  Write-EnvFromMap $map
  $script:State.EnvMap = $map
}

function Install-And-Build {
  if (!(Test-CommandAvailable "npm")) { throw "npm not found. Install Node.js first." }
  if (!(Test-Path -LiteralPath (Join-Path (Get-InstallRoot) "package.json"))) {
    throw "Installed package.json not found. Run Install/Update App Files first."
  }
  Invoke-ProcessLogged "npm" @("ci") 900
  Invoke-ProcessLogged "npm" @("run", "build") 600
}

function Create-Shortcut {
  param(
    [string]$Path,
    [string]$TargetPath,
    [string]$Arguments = "",
    [string]$WorkingDirectory = ""
  )
  if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $WorkingDirectory = Get-InstallRoot
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $TargetPath
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.Description = "Agentic Filesystem MCP"
  $shortcut.Save()
}

function Create-InstallerShortcuts {
  $installRoot = Get-InstallRoot
  $desktop = [Environment]::GetFolderPath("DesktopDirectory")
  $startMenu = Join-Path ([Environment]::GetFolderPath("Programs")) "Agentic Filesystem MCP"
  New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
  $controlBat = Join-Path $installRoot "Agentic Filesystem MCP Control.bat"
  $installBat = Join-Path $installRoot "Install Agentic Filesystem MCP.bat"
  $fallbackLauncher = Join-Path $installRoot "scripts\launch-fallback.ps1"
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source

  Create-Shortcut (Join-Path $desktop "Agentic Filesystem MCP Control.lnk") $controlBat
  Create-Shortcut (Join-Path $startMenu "Agentic Filesystem MCP Control.lnk") $controlBat
  Create-Shortcut (Join-Path $startMenu "Agentic Filesystem MCP Installer.lnk") $installBat
  Create-Shortcut (Join-Path $startMenu "Agentic Filesystem MCP Fallback Dashboard.lnk") $powershell "-STA -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$fallbackLauncher`""
  Write-InstallLog "Shortcuts created in Desktop and Start Menu."
}

function Invoke-TextUrl {
  param([string]$Url, [int]$TimeoutSec = 5)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    return "OK $($response.StatusCode)"
  } catch {
    return "FAIL $($_.Exception.Message)"
  }
}

function Run-SmokeChecks {
  $map = Read-InstallerEnv
  $installRoot = Get-InstallRoot
  $port = Get-MapValue $map "GPT_FS_MCP_PORT" "8789"
  $public = (Get-MapValue $map "PUBLIC_BASE_URL" "http://127.0.0.1:$port").TrimEnd("/")
  $local = "http://127.0.0.1:$port"
  if ($script:ChecksList -and $script:ChecksList.IsHandleCreated) {
    Invoke-InstallerUi $script:ChecksList ([Action]{ $script:ChecksList.Items.Clear() })
  }
  $checks = @(
    "Local health|$(Invoke-TextUrl "$local/healthz" 3)",
    "Local dashboard|$(Invoke-TextUrl "$local/dashboard" 3)",
    "Public health|$(Invoke-TextUrl "$public/healthz" 5)",
    "Protected resource metadata|$(Invoke-TextUrl "$public/.well-known/oauth-protected-resource" 5)",
    "Authorization server metadata|$(Invoke-TextUrl "$public/.well-known/oauth-authorization-server" 5)",
    "Build output|$(if (Test-Path -LiteralPath (Join-Path $installRoot 'dist\index.js')) { 'OK dist/index.js' } else { 'FAIL missing dist/index.js' })",
    "Journal path|$(Get-MapValue $map 'GPT_FS_MCP_JOURNAL_PATH' '.\data\journal.jsonl')"
  )
  foreach ($check in $checks) {
    Write-InstallLog $check
    if ($script:ChecksList -and $script:ChecksList.IsHandleCreated) {
      $addCheckLine = [Action[string]]{
        param([string]$Line)
        [void]$script:ChecksList.Items.Add($Line)
      }
      Invoke-InstallerUi $script:ChecksList $addCheckLine @($check)
    }
  }
}

function New-Label {
  param([string]$Text)
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.AutoSize = $true
  $label.Margin = New-Object System.Windows.Forms.Padding(0, 8, 8, 2)
  return $label
}

function New-TextBox {
  param([bool]$Secret = $false)
  $box = New-Object System.Windows.Forms.TextBox
  $box.Dock = [System.Windows.Forms.DockStyle]::Fill
  $box.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 4)
  if ($Secret) { $box.UseSystemPasswordChar = $true }
  return $box
}

function Add-Field {
  param(
    [System.Windows.Forms.TableLayoutPanel]$Panel,
    [string]$Label,
    [System.Windows.Forms.Control]$Control
  )
  $row = $Panel.RowCount
  $Panel.RowCount += 1
  [void]$Panel.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
  $Panel.Controls.Add((New-Label $Label), 0, $row)
  $Panel.Controls.Add($Control, 1, $row)
}

[System.Windows.Forms.Application]::EnableVisualStyles()

$script:Form = New-Object System.Windows.Forms.Form
$script:Form.Text = "Agentic Filesystem MCP Installer"
$script:Form.Size = New-Object System.Drawing.Size(1180, 780)
$script:Form.MinimumSize = New-Object System.Drawing.Size(980, 660)
$script:Form.StartPosition = "CenterScreen"
$script:Form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = [System.Windows.Forms.DockStyle]::Fill
$root.ColumnCount = 2
$root.RowCount = 3
$root.Padding = New-Object System.Windows.Forms.Padding(12)
[void]$root.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 235)))
[void]$root.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 54)))
[void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 182)))
$script:Form.Controls.Add($root)

$header = New-Object System.Windows.Forms.Label
$header.Text = "Install and verify the local workstation MCP bridge. Secrets are written only to local .env."
$header.Dock = [System.Windows.Forms.DockStyle]::Fill
$header.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$header.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$root.Controls.Add($header, 0, 0)
$root.SetColumnSpan($header, 2)

$steps = New-Object System.Windows.Forms.ListBox
$steps.Dock = [System.Windows.Forms.DockStyle]::Fill
$steps.Items.AddRange([object[]]@(
  "1. Preflight",
  "2. Install folder",
  "3. Configure .env",
  "4. Install and build",
  "5. Create shortcuts",
  "6. Smoke checks",
  "7. Finish"
))
$root.Controls.Add($steps, 0, 1)

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = [System.Windows.Forms.DockStyle]::Fill
$root.Controls.Add($tabs, 1, 1)

$targetTab = New-Object System.Windows.Forms.TabPage
$targetTab.Text = "Install Folder"
$targetPanel = New-Object System.Windows.Forms.TableLayoutPanel
$targetPanel.Dock = [System.Windows.Forms.DockStyle]::Top
$targetPanel.AutoSize = $true
$targetPanel.ColumnCount = 3
[void]$targetPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 145)))
[void]$targetPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$targetPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 110)))
$targetTab.Controls.Add($targetPanel)
$tabs.Controls.Add($targetTab)

$targetLabel = New-Label "Install folder"
$script:InstallFolderText = New-TextBox
$script:InstallFolderText.Text = $DefaultInstallRoot
$browseInstall = New-Object System.Windows.Forms.Button
$browseInstall.Text = "Browse"
$browseInstall.Width = 92
$browseInstall.Add_Click({
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = "Choose the final install folder"
  $dialog.SelectedPath = Get-InstallRoot
  if ($dialog.ShowDialog($script:Form) -eq [System.Windows.Forms.DialogResult]::OK) {
    Set-InstallRoot $dialog.SelectedPath
  }
})
$targetPanel.Controls.Add($targetLabel, 0, 0)
$targetPanel.Controls.Add($script:InstallFolderText, 1, 0)
$targetPanel.Controls.Add($browseInstall, 2, 0)

$targetInfo = New-Object System.Windows.Forms.TextBox
$targetInfo.Multiline = $true
$targetInfo.ReadOnly = $true
$targetInfo.Dock = [System.Windows.Forms.DockStyle]::Top
$targetInfo.Height = 130
$targetInfo.Text = "The extracted repo is only the source package. The installer copies public app files into the install folder, then builds there. Existing .env, data, logs, node_modules, and dist in the install folder are preserved for repair/update flows."
$targetTab.Controls.Add($targetInfo)

$preflightTab = New-Object System.Windows.Forms.TabPage
$preflightTab.Text = "Preflight"
$script:PreflightList = New-Object System.Windows.Forms.ListBox
$script:PreflightList.Dock = [System.Windows.Forms.DockStyle]::Fill
$preflightTab.Controls.Add($script:PreflightList)
$tabs.Controls.Add($preflightTab)

$configTab = New-Object System.Windows.Forms.TabPage
$configTab.Text = "Configuration"
$configPanel = New-Object System.Windows.Forms.TableLayoutPanel
$configPanel.Dock = [System.Windows.Forms.DockStyle]::Top
$configPanel.AutoSize = $true
$configPanel.ColumnCount = 2
[void]$configPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 185)))
[void]$configPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$configTab.AutoScroll = $true
$configTab.Controls.Add($configPanel)
$tabs.Controls.Add($configTab)

$script:AuthRequired = New-Object System.Windows.Forms.CheckBox
$script:AuthRequired.Text = "Require OAuth auth"
$script:AuthRequired.AutoSize = $true
$script:TunnelEnabled = New-Object System.Windows.Forms.CheckBox
$script:TunnelEnabled.Text = "Cloudflare tunnel enabled"
$script:TunnelEnabled.AutoSize = $true
$script:PublicBaseUrl = New-TextBox
$script:AllowedGithubLogins = New-TextBox
$script:GithubClientId = New-TextBox
$script:GithubClientSecret = New-TextBox -Secret $true
$script:OauthClientId = New-TextBox
$script:OauthClientSecret = New-TextBox -Secret $true
$script:OauthRedirectUris = New-TextBox
$script:DefaultCwd = New-TextBox
$script:CloudflaredExe = New-TextBox
$script:CloudflaredConfig = New-TextBox
$script:TunnelName = New-TextBox

Add-Field $configPanel "Auth required" $script:AuthRequired
Add-Field $configPanel "Tunnel enabled" $script:TunnelEnabled
Add-Field $configPanel "Public base URL" $script:PublicBaseUrl
Add-Field $configPanel "GitHub allowlist" $script:AllowedGithubLogins
Add-Field $configPanel "GitHub client ID" $script:GithubClientId
Add-Field $configPanel "GitHub client secret" $script:GithubClientSecret
Add-Field $configPanel "OAuth client ID" $script:OauthClientId
Add-Field $configPanel "OAuth client secret" $script:OauthClientSecret
Add-Field $configPanel "OAuth redirect URIs" $script:OauthRedirectUris
Add-Field $configPanel "Default workspace" $script:DefaultCwd
Add-Field $configPanel "cloudflared.exe" $script:CloudflaredExe
Add-Field $configPanel "cloudflared config" $script:CloudflaredConfig
Add-Field $configPanel "Tunnel name" $script:TunnelName

$installTab = New-Object System.Windows.Forms.TabPage
$installTab.Text = "Install / Build"
$installInfo = New-Object System.Windows.Forms.TextBox
$installInfo.Multiline = $true
$installInfo.ReadOnly = $true
$installInfo.Dock = [System.Windows.Forms.DockStyle]::Fill
$installInfo.Text = "This step runs npm ci and npm run build. It is idempotent and can be run again for repair."
$installTab.Controls.Add($installInfo)
$tabs.Controls.Add($installTab)

$checksTab = New-Object System.Windows.Forms.TabPage
$checksTab.Text = "Smoke Checks"
$script:ChecksList = New-Object System.Windows.Forms.ListBox
$script:ChecksList.Dock = [System.Windows.Forms.DockStyle]::Fill
$checksTab.Controls.Add($script:ChecksList)
$tabs.Controls.Add($checksTab)

$finishTab = New-Object System.Windows.Forms.TabPage
$finishTab.Text = "Finish"
$finishText = New-Object System.Windows.Forms.TextBox
$finishText.Multiline = $true
$finishText.ReadOnly = $true
$finishText.Dock = [System.Windows.Forms.DockStyle]::Fill
$finishText.Text = "Recommended final flow:`r`n`r`n1. Choose the install folder.`r`n2. Install/Update App Files.`r`n3. Run Preflight.`r`n4. Save .env.`r`n5. Install Dependencies + Build.`r`n6. Create Shortcuts.`r`n7. Start the local server from Control or Fallback app.`r`n8. Run Smoke Checks.`r`n9. Configure GitHub OAuth and ChatGPT connector when ready.`r`n`r`nAfter a successful install, the extracted source folder can be deleted if you no longer need it."
$finishTab.Controls.Add($finishText)
$tabs.Controls.Add($finishTab)

$bottom = New-Object System.Windows.Forms.TableLayoutPanel
$bottom.Dock = [System.Windows.Forms.DockStyle]::Fill
$bottom.ColumnCount = 2
$bottom.RowCount = 2
[void]$bottom.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$bottom.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 424)))
[void]$bottom.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 32)))
[void]$bottom.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$root.Controls.Add($bottom, 0, 2)
$root.SetColumnSpan($bottom, 2)

$script:StatusLabel = New-Object System.Windows.Forms.Label
$script:StatusLabel.Dock = [System.Windows.Forms.DockStyle]::Fill
$script:StatusLabel.Text = "Ready. Start with Preflight."
$script:StatusLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$bottom.Controls.Add($script:StatusLabel, 0, 0)

$buttonPanel = New-Object System.Windows.Forms.TableLayoutPanel
$buttonPanel.Dock = [System.Windows.Forms.DockStyle]::Fill
$buttonPanel.ColumnCount = 2
$buttonPanel.RowCount = 4
$buttonPanel.Padding = New-Object System.Windows.Forms.Padding(4, 0, 4, 0)
[void]$buttonPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 50)))
[void]$buttonPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 50)))
for ($rowIndex = 0; $rowIndex -lt 4; $rowIndex++) {
  [void]$buttonPanel.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 25)))
}
$bottom.Controls.Add($buttonPanel, 1, 0)
$bottom.SetRowSpan($buttonPanel, 2)

$script:LogBox = New-Object System.Windows.Forms.TextBox
$script:LogBox.Multiline = $true
$script:LogBox.ReadOnly = $true
$script:LogBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Both
$script:LogBox.Dock = [System.Windows.Forms.DockStyle]::Fill
$script:LogBox.Font = New-Object System.Drawing.Font("Consolas", 8.5)
$bottom.Controls.Add($script:LogBox, 0, 1)

$script:ActionButtons = @()
$script:ActionButtonIndex = 0
function New-ActionButton {
  param([string]$Text, [scriptblock]$OnClick)
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Dock = [System.Windows.Forms.DockStyle]::Fill
  $button.Margin = New-Object System.Windows.Forms.Padding(4, 5, 4, 5)
  $button.Add_Click($OnClick)
  $script:ActionButtons += $button
  $column = $script:ActionButtonIndex % 2
  $row = [Math]::Floor($script:ActionButtonIndex / 2)
  $buttonPanel.Controls.Add($button, $column, $row)
  $script:ActionButtonIndex += 1
}

New-ActionButton "Install/Update App Files" { $tabs.SelectedTab = $targetTab; Set-InstallRoot $script:InstallFolderText.Text; Invoke-BackgroundAction "Install app files" { Install-AppFiles } }
New-ActionButton "Run Preflight" { Set-InstallRoot $script:InstallFolderText.Text; $tabs.SelectedTab = $preflightTab; Invoke-BackgroundAction "Preflight" { Run-Preflight } }
New-ActionButton "Save .env" { Set-InstallRoot $script:InstallFolderText.Text; $snapshot = Get-ConfigSnapshotFromUi; Invoke-BackgroundAction "Save .env" { param($data) Save-ConfigSnapshot $data } $snapshot }
New-ActionButton "Install Dependencies + Build" { Set-InstallRoot $script:InstallFolderText.Text; $tabs.SelectedTab = $installTab; Invoke-BackgroundAction "Install dependencies and build" { Install-And-Build } }
New-ActionButton "Create Shortcuts" { Set-InstallRoot $script:InstallFolderText.Text; Invoke-BackgroundAction "Create shortcuts" { Create-InstallerShortcuts } }
New-ActionButton "Run Smoke Checks" { Set-InstallRoot $script:InstallFolderText.Text; $tabs.SelectedTab = $checksTab; Invoke-BackgroundAction "Smoke checks" { Run-SmokeChecks } }
New-ActionButton "Open Control" { Set-InstallRoot $script:InstallFolderText.Text; Start-Process (Join-Path (Get-InstallRoot) "Agentic Filesystem MCP Control.bat") }
New-ActionButton "Open Log" { if (Test-Path -LiteralPath $InstallLog) { Start-Process $InstallLog } }

$script:Form.Add_Shown({
  Set-InstallRoot $DefaultInstallRoot
  Load-ConfigIntoUi
  Write-InstallLog "Installer ready."
})
$script:Form.Add_FormClosing({
  $script:State.IsClosing = $true
})

[void][System.Windows.Forms.Application]::Run($script:Form)
