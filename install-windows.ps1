# Aru Host for Windows — current-user installer.
# Windows owner of: %LOCALAPPDATA%\AruHost layout, versioned release slots with
# current/previous junctions, per-user Scheduled Task background lifetime,
# health-checked rollback, firewall receipt, and data-preserving uninstall.
# It deliberately mirrors the product boundary of install-linux-desktop.sh /
# install-macos.sh without being a shell translation: junctions instead of
# symlinks, a logon Scheduled Task instead of systemd --user, DPAPI-protected
# secrets written elsewhere by Host Core rather than any plaintext fallback.
param(
  [string]$Instance = "home",
  [string]$BaseUrl = "",
  [string]$DisplayName = "",
  [int]$Port = 8787,
  [string]$SourceDir = "",
  [string]$BundleUrl = "",
  [string]$ReleaseVersion = "",
  [string]$BaseRoot = "",
  [switch]$SkipDependencies,
  [switch]$SkipStart,
  [switch]$Uninstall,
  [switch]$PurgeData,
  [string]$Root = ""
)

$ErrorActionPreference = "Stop"
$product = "Aru Host for Windows"

function Fail([string]$message) {
  Write-Error "${product} installer: $message"
  exit 1
}
function Log([string]$message) {
  Write-Host "[$product] $message"
}

$coreFiles = @(
  "aru-selfhost-stub.mjs", "backup-settings.mjs", "conversation-turn-relay.mjs",
  "collaborator-host.mjs", "mobile-collaborator-replicas.mjs", "mobile-collaborator-identities.mjs", "container-runtime-setup.mjs", "collaborator-cognition.mjs", "collaborator-surfaces.mjs",
  "collaborator-surface-bundles.mjs", "collaborator-conversations.mjs", "collaborator-conversation-attachments.mjs",
  "collaborator-initiative.mjs", "collaborator-projects.mjs", "apns-push.mjs", "wake-bridge.mjs",
  "codex-app-server-driver.mjs",
  "direct-api-driver.mjs", "provider-profiles.mjs",
  "provider-secret-store.mjs", "node-control.mjs", "node-workspaces.mjs",
  "plugin-supervisor.mjs", "plugin-workshop.mjs", "source-plugin-runtime.mjs",
  "source-plugin-runner.mjs", "run-node.ps1", "install-windows.ps1",
  "aru-selfhostctl-windows.ps1"
)

if ($Instance -notmatch "^[a-z0-9][a-z0-9-]{0,31}$") { Fail "invalid instance" }
if ($DisplayName -match "[`r`n]") { Fail "display name must be one line" }
if ($Port -lt 1 -or $Port -gt 65535) { Fail "invalid port" }
if ($SourceDir -and $BundleUrl) { Fail "choose SourceDir or BundleUrl" }
if ($ReleaseVersion -and $ReleaseVersion -notmatch "^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$") {
  Fail "invalid release version"
}

$homeRoot = $env:USERPROFILE
if ($Root) {
  if (-not [IO.Path]::IsPathRooted($Root)) { Fail "-Root must be absolute" }
  $homeRoot = Join-Path $Root "home"
  $BaseRoot = Join-Path $Root "data\AruHost"
  $SkipDependencies = $true
  $SkipStart = $true
}
if (-not $BaseRoot) {
  if ($env:ARU_WINDOWS_BASE_ROOT) { $BaseRoot = $env:ARU_WINDOWS_BASE_ROOT }
  else { $BaseRoot = Join-Path $env:LOCALAPPDATA "AruHost" }
}
if (-not $DisplayName) { $DisplayName = "$env:COMPUTERNAME Aru" }

$instanceRoot = Join-Path $BaseRoot "instances\$Instance"
$configDir = Join-Path $instanceRoot "config"
$installEnv = Join-Path $configDir "install.env"
$nodeEnv = Join-Path $configDir "node.env"
$dataDir = Join-Path $instanceRoot "data"
$logDir = Join-Path $instanceRoot "logs"
$releasesDir = Join-Path $instanceRoot "releases"
$currentLink = Join-Path $instanceRoot "current"
$previousLink = Join-Path $instanceRoot "previous"
$currentPointer = Join-Path $instanceRoot "current.release"
$previousPointer = Join-Path $instanceRoot "previous.release"
$taskName = "Aru Host ($Instance)"
$binDir = Join-Path $BaseRoot "bin"
$controlShim = Join-Path $binDir "aru-selfhost.cmd"
$managedWorkspaceRoot = Join-Path $homeRoot "Aru Workspace"

function WriteLines([string]$destination, [string[]]$lines) {
  # LF endings on purpose: runtime.mjs / Console parsers share these files
  # across platforms and anchor their regexes on \n.
  [IO.File]::WriteAllText($destination, (($lines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
}

function RemoveLink([string]$path) {
  if (Test-Path -LiteralPath $path) {
    [IO.Directory]::Delete($path, $false)
  }
}

function SetLink([string]$path, [string]$target, [string]$pointerPath) {
  RemoveLink $path
  New-Item -ItemType Junction -Path $path -Value $target | Out-Null
  WriteLines $pointerPath @([IO.Path]::GetFileName($target))
}

function ReadPointer([string]$pointerPath) {
  if (Test-Path -LiteralPath $pointerPath) {
    $value = ([IO.File]::ReadAllText($pointerPath)).Trim()
    if ($value) { return $value }
  }
  return $null
}

function StopHostTask {
  if ($SkipStart) { return }
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
      $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      if (-not $task -or $task.State -notin @("Running", "Queued")) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($task -and $task.State -in @("Running", "Queued")) {
      Fail "Host task did not stop; installed files were left in place"
    }
  }
  $supervisor = Join-Path $PSScriptRoot "run-node.ps1"
  if ((Test-Path -LiteralPath $supervisor) -and (Test-Path -LiteralPath $nodeEnv)) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $supervisor -ConfigFile $nodeEnv -Stop
    if ($LASTEXITCODE -ne 0) { Fail "Host native process did not stop; installed files were left in place" }
  }
}

if ($Uninstall) {
  StopHostTask
  if (-not $SkipStart) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  # Remove junctions before deleting their targets.
  RemoveLink $currentLink
  RemoveLink $previousLink
  foreach ($path in @($releasesDir, $configDir, $logDir)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
  }
  foreach ($path in @($currentPointer, $previousPointer)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  }
  if ($Instance -eq "home" -and (Test-Path -LiteralPath $controlShim)) {
    Remove-Item -LiteralPath $controlShim -Force
  }
  if ($PurgeData) {
    if (Test-Path -LiteralPath $dataDir) {
      # Published surface versions can exceed MAX_PATH on Windows PowerShell 5.1.
      # Keep LiteralPath/Force semantics, using the native extended path prefix.
      $purgePath = [IO.Path]::GetFullPath($dataDir)
      if (-not $purgePath.StartsWith('\\?\')) {
        if ($purgePath.StartsWith('\\')) { $purgePath = '\\?\UNC\' + $purgePath.Substring(2) }
        else { $purgePath = '\\?\' + $purgePath }
      }
      Remove-Item -LiteralPath $purgePath -Recurse -Force
    }
    if ((Test-Path -LiteralPath $instanceRoot) -and -not (Get-ChildItem -LiteralPath $instanceRoot -Force)) {
      Remove-Item -LiteralPath $instanceRoot -Force
    }
    Log "instance $Instance program and durable data removed"
  } else {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    Log "instance $Instance program removed; durable data preserved at $dataDir"
  }
  exit 0
}
if ($PurgeData) { Fail "-PurgeData requires -Uninstall" }

if (Test-Path -LiteralPath $installEnv) {
  $persisted = @{}
  foreach ($line in [IO.File]::ReadAllLines($installEnv)) {
    $separator = $line.IndexOf("=")
    if ($separator -gt 0) {
      $persisted[$line.Substring(0, $separator)] = $line.Substring($separator + 1).Trim('"')
    }
  }
  if ($Port -eq 8787 -and $persisted["ARU_INSTALL_PORT"]) { $Port = [int]$persisted["ARU_INSTALL_PORT"] }
  if (-not $BaseUrl -and $persisted["ARU_INSTALL_BASE_URL"]) { $BaseUrl = $persisted["ARU_INSTALL_BASE_URL"] }
} elseif (-not $Root) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($listener) { Fail "port $Port is already in use" }
}

if (-not $BaseUrl) {
  if ($Root) {
    $BaseUrl = "http://127.0.0.1:$Port"
  } else {
    $lanAddress = $null
    try {
      $configuration = Get-NetIPConfiguration -ErrorAction Stop | Where-Object {
        $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up"
      } | Select-Object -First 1
      if ($configuration -and $configuration.IPv4Address) {
        $lanAddress = ($configuration.IPv4Address | Select-Object -First 1).IPAddress
      }
    } catch {}
    if ($lanAddress) { $BaseUrl = "http://${lanAddress}:$Port" }
    else { $BaseUrl = ("http://{0}.local:{1}" -f $env:COMPUTERNAME.ToLower(), $Port) }
  }
}
if ($BaseUrl -notmatch "^https?://[^\s/]+(:[0-9]+)?$") { Fail "base URL must be an origin" }

function Sha256File([string]$path) {
  (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
}

function ManagedNodeBinary {
  $candidate = Join-Path $BaseRoot "runtime\current-node\node.exe"
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  return $null
}

function InstallManagedNode {
  $architecture = $env:PROCESSOR_ARCHITECTURE
  switch ($architecture) {
    "AMD64" { $nodeArch = "x64" }
    "ARM64" { $nodeArch = "arm64" }
    default { Fail "unsupported Windows architecture: $architecture" }
  }
  $temp = Join-Path ([IO.Path]::GetTempPath()) ("aru-node-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  try {
    $checksums = Join-Path $temp "SHASUMS256.txt"
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" -OutFile $checksums
    $suffix = "win-$nodeArch.zip"
    $entry = [IO.File]::ReadAllLines($checksums) | Where-Object { $_ -match [regex]::Escape($suffix) + "$" } | Select-Object -First 1
    if (-not $entry) { Fail "Node.js manifest lacks $nodeArch Windows" }
    $expected, $fileName = ($entry -split "\s+", 2)
    $fileName = $fileName.Trim()
    $archive = Join-Path $temp $fileName
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/latest-v22.x/$fileName" -OutFile $archive
    if ((Sha256File $archive) -ne $expected.ToLower()) { Fail "Node.js SHA-256 mismatch" }
    Expand-Archive -LiteralPath $archive -DestinationPath $temp -Force
    $extracted = $fileName -replace "\.zip$", ""
    $runtimeRoot = Join-Path $BaseRoot "runtime"
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
    $versionRoot = Join-Path $runtimeRoot $extracted
    if (Test-Path -LiteralPath $versionRoot) { Remove-Item -LiteralPath $versionRoot -Recurse -Force }
    Move-Item -LiteralPath (Join-Path $temp $extracted) -Destination $versionRoot
    $currentNode = Join-Path $runtimeRoot "current-node"
    RemoveLink $currentNode
    New-Item -ItemType Junction -Path $currentNode -Value $versionRoot | Out-Null
  } finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function ResolveNodeBinary {
  $candidate = $null
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { $candidate = $command.Source }
  if (-not $candidate) { $candidate = ManagedNodeBinary }
  if ($candidate -and (Test-Path -LiteralPath $candidate)) {
    $versionText = & $candidate --version
    if ($versionText -match "^v([0-9]+)\." -and [int]$Matches[1] -ge 22) { return $candidate }
  }
  if ($SkipDependencies) { Fail "Node.js 22 or newer is required" }
  Log "installing a user-owned Node.js 22 runtime"
  InstallManagedNode
  return (ManagedNodeBinary)
}

if ($SkipDependencies -and -not (Get-Command node.exe -ErrorAction SilentlyContinue) -and -not (ManagedNodeBinary)) {
  if ($Root) {
    # Test-only fake root still needs some Node for release metadata parsing;
    # fall back to any node on PATH via plain name resolution.
    $nodeBinary = "node.exe"
  } else {
    Fail "Node.js 22 or newer is required"
  }
} else {
  $nodeBinary = ResolveNodeBinary
}

function DetectContainerRuntime {
  foreach ($candidate in @("docker", "podman")) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if (-not $command) { continue }
    # Windows PowerShell turns stderr from a native command into an ErrorRecord.
    # A CLI may exist while its daemon is stopped, which is an optional-capability
    # miss rather than an installation failure.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = "SilentlyContinue"
      & $command.Source info *> $null
      $runtimeAvailable = $LASTEXITCODE -eq 0
    } catch {
      $runtimeAvailable = $false
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($runtimeAvailable) { return $candidate }
  }
  return "none"
}
if ($Root) { $containerRuntime = "none" } else { $containerRuntime = DetectContainerRuntime }

$sourceTemp = $null
try {
  if ($SourceDir) {
    $SourceDir = (Resolve-Path -LiteralPath $SourceDir).Path
  } elseif ($BundleUrl) {
    $sourceTemp = Join-Path ([IO.Path]::GetTempPath()) ("aru-bundle-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $sourceTemp | Out-Null
    $bundle = Join-Path $sourceTemp "bundle.tar.gz"
    Invoke-WebRequest -UseBasicParsing -Uri $BundleUrl -OutFile $bundle
    Invoke-WebRequest -UseBasicParsing -Uri "$BundleUrl.sha256" -OutFile "$bundle.sha256"
    $expected = (([IO.File]::ReadAllText("$bundle.sha256")).Trim() -split "\s+")[0].ToLower()
    if ((Sha256File $bundle) -ne $expected) { Fail "bundle SHA-256 mismatch" }
    $payload = Join-Path $sourceTemp "payload"
    New-Item -ItemType Directory -Force -Path $payload | Out-Null
    tar -xzf $bundle -C $payload
    if ($LASTEXITCODE -ne 0) { Fail "bundle extraction failed" }
    $SourceDir = $payload
  } else {
    Fail "a Windows install needs -SourceDir or -BundleUrl (the Console supplies its embedded Host Core)"
  }

  foreach ($file in $coreFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDir $file))) { Fail "payload missing $file" }
  }
  $releaseMetadata = Join-Path $SourceDir "release.json"
  if (-not $ReleaseVersion -and (Test-Path -LiteralPath $releaseMetadata)) {
    $release = Get-Content -LiteralPath $releaseMetadata -Raw | ConvertFrom-Json
    if ($release.schema -ne "aru.host.release.v1") { Fail "invalid release metadata" }
    $ReleaseVersion = $release.version
  }

  # Admission is read-only and precedes service changes and rollback setup.
  function AssertStateReadable {
    & $nodeBinary (Join-Path $SourceDir "aru-selfhost-stub.mjs") --data-dir $dataDir --container-runtime none --check-state
    if ($LASTEXITCODE -ne 0) { Fail "Host state check failed; previous release was not restarted." }
  }
  AssertStateReadable

  $releaseStamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  if ($ReleaseVersion) { $releaseRef = "host-$ReleaseVersion" } else { $releaseRef = "host-source" }
  $releaseId = "$releaseRef-$releaseStamp"
  $releaseDir = Join-Path $releasesDir $releaseId
  $uniquifier = 1
  while (Test-Path -LiteralPath $releaseDir) {
    $uniquifier += 1
    $releaseDir = Join-Path $releasesDir "$releaseId-$uniquifier"
  }
  $releaseId = [IO.Path]::GetFileName($releaseDir)

  foreach ($path in @($releaseDir, $configDir, $dataDir, $logDir, $binDir)) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
  }
  foreach ($file in $coreFiles) {
    Copy-Item -LiteralPath (Join-Path $SourceDir $file) -Destination (Join-Path $releaseDir $file) -Force
  }
  Move-Item -LiteralPath (Join-Path $releaseDir "aru-selfhost-stub.mjs") -Destination (Join-Path $releaseDir "server.mjs") -Force
  if (Test-Path -LiteralPath $releaseMetadata) {
    Copy-Item -LiteralPath $releaseMetadata -Destination (Join-Path $releaseDir "release.json") -Force
  } elseif ($ReleaseVersion) {
    if ($ReleaseVersion -notmatch '^\d+\.\d+\.\d+([+-][0-9A-Za-z.-]+)?$') { Fail "invalid release version" }
    $metadata = @{ schema = "aru.host.release.v1"; version = $ReleaseVersion } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $releaseDir "release.json"), $metadata, (New-Object Text.UTF8Encoding($false)))
  }

  $oldRelease = ReadPointer $currentPointer
  $oldPrevious = ReadPointer $previousPointer
  $rollbackTemp = Join-Path $instanceRoot (".rollback-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $rollbackTemp | Out-Null
  foreach ($path in @($nodeEnv, $installEnv)) {
    if (Test-Path -LiteralPath $path) {
      Copy-Item -LiteralPath $path -Destination (Join-Path $rollbackTemp ([IO.Path]::GetFileName($path))) -Force
    }
  }
  StopHostTask
  if ($oldRelease -and (Test-Path -LiteralPath (Join-Path $releasesDir $oldRelease))) {
    SetLink $previousLink (Join-Path $releasesDir $oldRelease) $previousPointer
  }
  SetLink $currentLink $releaseDir $currentPointer

  WriteLines $nodeEnv @(
    "ARU_SERVER_ENTRY=$currentLink\server.mjs",
    "ARU_NODE_BINARY=$nodeBinary",
    "ARU_LISTEN_HOST=0.0.0.0",
    "ARU_PORT=$Port",
    "ARU_DATA_DIR=$dataDir",
    "ARU_MANAGED_WORKSPACE_ROOT=$managedWorkspaceRoot",
    "ARU_BASE_URL=$BaseUrl",
    "ARU_TRANSPORT_KIND=lan",
    "ARU_DISPLAY_NAME=$DisplayName",
    "ARU_NODE_KIND=home-windows",
    "ARU_CONTAINER_RUNTIME=$containerRuntime",
    "ARU_MAX_PACKAGE_MB=2048",
    "ARU_MAX_WORKSPACE_MB=512",
    "ARU_MAX_WORKSPACE_OUTPUT_MB=32",
    "ARU_CONTAINER_MEMORY=1g",
    "ARU_CONTAINER_CPUS=2",
    "ARU_NODE_IMAGE=node:22-alpine",
    "ARU_PYTHON_IMAGE=python:3.13-alpine",
    "ARU_SHELL_IMAGE=alpine:3.22"
  )

  $firewallState = "unconfigured"
  if (-not $Root) {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      try {
        Get-NetFirewallRule -DisplayName $taskName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        New-NetFirewallRule -DisplayName $taskName -Direction Inbound -Action Allow -Protocol TCP `
          -LocalPort $Port -Profile Private, Domain -Program $nodeBinary | Out-Null
        $firewallState = "configured"
      } catch {
        $firewallState = "unconfigured"
      }
    } else {
      $existingRule = Get-NetFirewallRule -DisplayName $taskName -ErrorAction SilentlyContinue
      if ($existingRule) { $firewallState = "configured" }
    }
  }

  WriteLines $installEnv @(
    "ARU_INSTALL_INSTANCE=$Instance",
    "ARU_INSTALL_BASE_ROOT=$BaseRoot",
    "ARU_INSTALL_BASE_URL=$BaseUrl",
    "ARU_INSTALL_DISPLAY_NAME=$DisplayName",
    "ARU_INSTALL_PORT=$Port",
    "ARU_INSTALL_BUNDLE_URL=$BundleUrl",
    "ARU_INSTALL_RELEASE_VERSION=$ReleaseVersion",
    "ARU_INSTALL_SOURCE_DIR=$SourceDir",
    "ARU_INSTALL_FIREWALL=$firewallState"
  )

  WriteLines $controlShim @(
    "@echo off",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0..\instances\home\current\aru-selfhostctl-windows.ps1`" %*"
  )

  function RegisterHostTask {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
      -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$currentLink\run-node.ps1`" -ConfigFile `"$nodeEnv`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
      -StartWhenAvailable -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  }

  function StartHostAndProbe {
    Start-ScheduledTask -TaskName $taskName
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/.well-known/aru.json" -TimeoutSec 2 | Out-Null
        return $true
      } catch {
        Start-Sleep -Milliseconds 250
      }
    }
    return $false
  }

  if (-not $SkipStart) {
    RegisterHostTask
    if (-not (StartHostAndProbe)) {
      StopHostTask
      AssertStateReadable
      foreach ($name in @("node.env", "install.env")) {
        $backup = Join-Path $rollbackTemp $name
        if (Test-Path -LiteralPath $backup) {
          Copy-Item -LiteralPath $backup -Destination (Join-Path $configDir $name) -Force
        }
      }
      if ($oldRelease -and (Test-Path -LiteralPath (Join-Path $releasesDir $oldRelease))) {
        SetLink $currentLink (Join-Path $releasesDir $oldRelease) $currentPointer
        RegisterHostTask
        StartHostAndProbe | Out-Null
      } else {
        RemoveLink $currentLink
        if (Test-Path -LiteralPath $currentPointer) { Remove-Item -LiteralPath $currentPointer -Force }
      }
      if ($oldPrevious -and (Test-Path -LiteralPath (Join-Path $releasesDir $oldPrevious))) {
        SetLink $previousLink (Join-Path $releasesDir $oldPrevious) $previousPointer
      } else {
        RemoveLink $previousLink
        if (Test-Path -LiteralPath $previousPointer) { Remove-Item -LiteralPath $previousPointer -Force }
      }
      Remove-Item -LiteralPath $releaseDir -Recurse -Force
      Remove-Item -LiteralPath $rollbackTemp -Recurse -Force -ErrorAction SilentlyContinue
      Fail "new release failed health check; previous release restored"
    }
  }

  Remove-Item -LiteralPath $rollbackTemp -Recurse -Force -ErrorAction SilentlyContinue
  Log "installed instance $Instance release $releaseId"
  Log "canonical URL: $BaseUrl"
  if ($containerRuntime -eq "none") {
    Log "Optional scripts/OCI plugins: open Console > Runtime for Podman installation and verification. Project files, page publication and phone pairing remain available."
    Log "workspace jobs and OCI plugins are unavailable; source plugins remain available"
  }
  if ($firewallState -ne "configured" -and -not $Root) {
    Log "firewall rule not created; LAN pairing may be blocked until the Console adds it with one admin approval"
  }
  if (-not $SkipStart) {
    Log "Host keeps running through the per-user Scheduled Task after the Console closes"
  }
} finally {
  if ($sourceTemp) { Remove-Item -LiteralPath $sourceTemp -Recurse -Force -ErrorAction SilentlyContinue }
}
