# Aru Host for Windows — instance control tool.
# Same eight-verb contract as aru-selfhostctl-linux / aru-selfhostctl-macos,
# expressed over the per-user Scheduled Task and junction release slots.
param(
  [string]$Instance = "home",
  [string]$BaseRoot = "",
  [Parameter(Position = 0)][string]$Command = "",
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest = @()
)

$ErrorActionPreference = "Stop"

function Fail([string]$message) {
  Write-Error "aru-selfhost: $message"
  exit 1
}

function Usage {
  Write-Host @"
Usage: aru-selfhost [-Instance NAME] <command>

  status                 Show Scheduled Task state and installed release.
  pairing                Restart and print a fresh ten-minute pairing link.
  setup-runtime          Verify installed containers, prepare images, and restart Host.
  doctor                 Verify runtime, task, manifest, capabilities, firewall.
  logs                   Follow the private Host log.
  upgrade                Install a new release with persisted choices.
  rollback               Switch to the previous healthy release.
  uninstall              Remove program/config and preserve durable data.
  uninstall -PurgeData   Remove this instance including durable data.
"@
}

if ($Instance -notmatch "^[a-z0-9][a-z0-9-]{0,31}$") { Fail "invalid instance" }
if (-not $BaseRoot) {
  if ($env:ARU_WINDOWS_BASE_ROOT) { $BaseRoot = $env:ARU_WINDOWS_BASE_ROOT }
  else { $BaseRoot = Join-Path $env:LOCALAPPDATA "AruHost" }
}

$instanceRoot = Join-Path $BaseRoot "instances\$Instance"
$configDir = Join-Path $instanceRoot "config"
$installEnv = Join-Path $configDir "install.env"
$nodeEnv = Join-Path $configDir "node.env"
$currentLink = Join-Path $instanceRoot "current"
$currentPointer = Join-Path $instanceRoot "current.release"
$previousPointer = Join-Path $instanceRoot "previous.release"
$releasesDir = Join-Path $instanceRoot "releases"
$logFile = Join-Path $instanceRoot "logs\host.log"
$taskName = "Aru Host ($Instance)"

function ReadEnvFile([string]$path) {
  $values = @{}
  if (Test-Path -LiteralPath $path) {
    foreach ($line in [IO.File]::ReadAllLines($path)) {
      $separator = $line.IndexOf("=")
      if ($separator -gt 0) {
        $values[$line.Substring(0, $separator)] = $line.Substring($separator + 1).Trim('"')
      }
    }
  }
  return $values
}

function ReadPointer([string]$pointerPath) {
  if (Test-Path -LiteralPath $pointerPath) {
    $value = ([IO.File]::ReadAllText($pointerPath)).Trim()
    if ($value) { return $value }
  }
  return $null
}

function RequireInstalled {
  if (-not (Test-Path -LiteralPath $installEnv)) { Fail "instance not installed" }
}

function SwapLink([string]$linkPath, [string]$target, [string]$pointerPath) {
  if (Test-Path -LiteralPath $linkPath) { [IO.Directory]::Delete($linkPath, $false) }
  New-Item -ItemType Junction -Path $linkPath -Value $target | Out-Null
  [IO.File]::WriteAllText($pointerPath, ([IO.Path]::GetFileName($target) + "`n"), [Text.UTF8Encoding]::new($false))
}

function StatusCommand {
  Write-Host "instance: $Instance"
  $release = ReadPointer $currentPointer
  if (-not $release) { $release = "(none)" }
  Write-Host "release: $release"
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = $task | Get-ScheduledTaskInfo
    Write-Host "task: $($task.State) (last result $($info.LastTaskResult), last run $($info.LastRunTime))"
  } else {
    Write-Host "task: not registered"
  }
}

function PairingCommand {
  RequireInstalled
  # The supervisor keeps its writer open. Preserve the log and only accept a
  # new token from the next boot; truncation races with that Windows file lock.
  $previousLinks = @()
  if (Test-Path -LiteralPath $logFile) {
    $previousLinks = @(Select-String -LiteralPath $logFile -Pattern "^aru://pair\?" |
      ForEach-Object { $_.Line })
  }
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $taskName
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (Test-Path -LiteralPath $logFile) {
      $link = Select-String -LiteralPath $logFile -Pattern "^aru://pair\?" -ErrorAction SilentlyContinue |
        Where-Object { $_.Line -notin $previousLinks } |
        Select-Object -Last 1
      if ($link) {
        Write-Host $link.Line
        Write-Host "Single use; expires in ten minutes. The next restart invalidates it."
        return
      }
    }
    Start-Sleep -Milliseconds 250
  }
  Fail "service restarted but no pairing link appeared"
}

function DoctorCommand {
  RequireInstalled
  $node = ReadEnvFile $nodeEnv
  $failed = $false
  Write-Host "instance: $Instance"
  $release = ReadPointer $currentPointer
  if (-not $release) { $release = "(none)" }
  Write-Host "release: $release"
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq "Running") { Write-Host "task: running" }
  else { Write-Host "task: not running"; $failed = $true }
  $nodeBinary = $node["ARU_NODE_BINARY"]
  if ($nodeBinary -and (Get-Command $nodeBinary -ErrorAction SilentlyContinue)) {
    Write-Host "node: $(& $nodeBinary --version)"
  } else { Write-Host "node: missing"; $failed = $true }
  $containerRuntime = $node["ARU_CONTAINER_RUNTIME"]
  if ($containerRuntime -eq "none" -or -not $containerRuntime) {
    Write-Host "container: unavailable (workspace/OCI plugin execution disabled)"
  } else {
    $command = Get-Command $containerRuntime -ErrorAction SilentlyContinue
    $healthy = $false
    if ($command) {
      & $command.Source info *> $null
      if ($LASTEXITCODE -eq 0) { $healthy = $true }
    }
    if ($healthy) { Write-Host "container: $(& $command.Source --version | Select-Object -First 1)" }
    else { Write-Host "container: configured but unavailable"; $failed = $true }
  }
  try {
    $manifest = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$($node['ARU_PORT'])/.well-known/aru.json" -TimeoutSec 5
    Write-Host "manifest: ok ($($manifest.serverId), $($manifest.nodeKind))"
  } catch {
    Write-Host "manifest: unreachable"
    $failed = $true
  }
  $rule = Get-NetFirewallRule -DisplayName $taskName -ErrorAction SilentlyContinue
  if ($rule) { Write-Host "firewall: inbound rule present" }
  else { Write-Host "firewall: no inbound rule (LAN pairing may be blocked; loopback unaffected)" }
  if ($failed) { exit 1 }
}

function UpgradeCommand {
  RequireInstalled
  $persisted = ReadEnvFile $installEnv
  $sourceDir = $persisted["ARU_INSTALL_SOURCE_DIR"]
  $bundleUrl = $persisted["ARU_INSTALL_BUNDLE_URL"]
  $arguments = @(
    "-Instance", $Instance,
    "-BaseRoot", $BaseRoot,
    "-BaseUrl", $persisted["ARU_INSTALL_BASE_URL"],
    "-DisplayName", $persisted["ARU_INSTALL_DISPLAY_NAME"],
    "-Port", $persisted["ARU_INSTALL_PORT"]
  )
  if ($sourceDir -and (Test-Path -LiteralPath $sourceDir)) {
    $installer = Join-Path $sourceDir "install-windows.ps1"
    $arguments += @("-SourceDir", $sourceDir)
  } elseif ($bundleUrl) {
    $installer = Join-Path $currentLink "install-windows.ps1"
    $arguments += @("-BundleUrl", $bundleUrl)
  } else {
    Fail "no persisted upgrade source; reinstall from a Console or bundle"
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer @arguments
  exit $LASTEXITCODE
}

function RollbackCommand {
  $current = ReadPointer $currentPointer
  $previous = ReadPointer $previousPointer
  if (-not $current -or -not $previous) { Fail "no previous release" }
  $currentTarget = Join-Path $releasesDir $current
  $previousTarget = Join-Path $releasesDir $previous
  if (-not (Test-Path -LiteralPath $previousTarget)) { Fail "previous release is missing" }
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  SwapLink (Join-Path $instanceRoot "previous") $currentTarget $previousPointer
  SwapLink $currentLink $previousTarget $currentPointer
  Start-ScheduledTask -TaskName $taskName
  Write-Host "rolled back to $previous"
}

function UninstallCommand([string[]]$extra) {
  RequireInstalled
  $installer = Join-Path $currentLink "install-windows.ps1"
  $arguments = @("-Instance", $Instance, "-BaseRoot", $BaseRoot, "-Uninstall")
  if ($extra -contains "-PurgeData" -or $extra -contains "--purge-data") { $arguments += "-PurgeData" }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer @arguments
  exit $LASTEXITCODE
}

function SetupRuntimeCommand {
  RequireInstalled
  $node = ReadEnvFile $nodeEnv
  & $node["ARU_NODE_BINARY"] (Join-Path $currentLink "container-runtime-setup.mjs") $nodeEnv
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $taskName
}

switch ($Command) {
  "setup-runtime" { SetupRuntimeCommand }

  "status" { StatusCommand }
  "pairing" { PairingCommand }
  "doctor" { DoctorCommand }
  "logs" {
    if (-not (Test-Path -LiteralPath $logFile)) {
      New-Item -ItemType File -Force -Path $logFile | Out-Null
    }
    Get-Content -LiteralPath $logFile -Wait -Tail 50
  }
  "upgrade" { UpgradeCommand }
  "rollback" { RollbackCommand }
  "uninstall" { UninstallCommand $Rest }
  "help" { Usage }
  "" { Usage; exit 1 }
  default { Usage; Fail "unknown command: $Command" }
}
