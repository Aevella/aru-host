# Real-Windows installer smoke. Runs only on a Windows machine (CI runner or
# dev box) with Node.js 22+ available. Exercises the complete current-user
# lifecycle against the real Scheduled Task service, real Host Core boot, and
# real DPAPI: fresh install, manifest identity, pairing link, upgrade with
# previous-release retention, rollback, data-preserving uninstall, reinstall,
# explicit purge, and a provider-secret DPAPI round trip.
param(
  [string]$Instance = "smoke",
  [int]$Port = 8890
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { Write-Error "windows-installer-smoke requires Windows"; exit 1 }

$selfhost = Split-Path -Parent $PSScriptRoot
$baseRoot = Join-Path ([IO.Path]::GetTempPath()) ("aru-windows-smoke-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
$installer = Join-Path $selfhost "install-windows.ps1"
$taskName = "Aru Host ($Instance)"
$instanceRoot = Join-Path $baseRoot "instances\$Instance"
$failures = 0

function Check([string]$label, [bool]$condition) {
  if ($condition) { Write-Host "ok: $label" }
  else { Write-Host "FAIL: $label"; $script:failures += 1 }
}

function Cleanup {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
    -Instance $Instance -BaseRoot $baseRoot -Uninstall -PurgeData *> $null
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $baseRoot -Recurse -Force -ErrorAction SilentlyContinue
}

try {
  # 0. Host Core modules parse.
  $modules = Get-ChildItem -LiteralPath $selfhost -Filter "*.mjs" -File
  foreach ($module in $modules) {
    & node --check $module.FullName
    if ($LASTEXITCODE -ne 0) { Write-Error "node --check failed for $($module.Name)"; exit 1 }
  }
  Write-Host "ok: $($modules.Count) Host Core modules parse"

  # 1. Fresh install with real task registration and health probe.
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
    -Instance $Instance -BaseRoot $baseRoot -Port $Port -DisplayName "Windows Smoke" -SourceDir $selfhost
  Check "fresh install exits 0" ($LASTEXITCODE -eq 0)
  Check "config/node.env exists" (Test-Path (Join-Path $instanceRoot "config\node.env"))
  $nodeEnv = [IO.File]::ReadAllText((Join-Path $instanceRoot "config\node.env"))
  Check "node kind is home-windows" ($nodeEnv -match "(?m)^ARU_NODE_KIND=home-windows$")
  Check "current junction resolves" (Test-Path (Join-Path $instanceRoot "current\server.mjs"))

  $manifest = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/.well-known/aru.json" -TimeoutSec 5
  Check "manifest reachable" ($null -ne $manifest.serverId)
  Check "manifest reports home-windows" ($manifest.nodeKind -eq "home-windows")
  Check "node-workspaces capability enabled" ($manifest.capabilities."node-workspaces".enabled -eq $true)

  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Check "scheduled task registered" ($null -ne $task)
  Check "scheduled task running" ($task.State -eq "Running")

  # 2. Control tool: status, doctor, pairing.
  $control = Join-Path $instanceRoot "current\aru-selfhostctl-windows.ps1"
  $status = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $control -Instance $Instance -BaseRoot $baseRoot status
  Check "status names the release" (($status -join "`n") -match "release: host-")
  $pairing = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $control -Instance $Instance -BaseRoot $baseRoot pairing
  Check "pairing link issued" (($pairing -join "`n") -match "aru://pair\?")
  $pairingAgain = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $control -Instance $Instance -BaseRoot $baseRoot pairing
  $firstLink = @($pairing | Where-Object { $_ -match '^aru://pair\?' })
  $nextLink = @($pairingAgain | Where-Object { $_ -match '^aru://pair\?' })
  Check "repeat pairing issues a fresh link" ($nextLink.Count -eq 1 -and $nextLink[0] -notin $firstLink)
  $logText = Get-Content -LiteralPath (Join-Path $instanceRoot "logs\host.log") -Raw
  Check "pairing preserves previous log entries" ($firstLink.Count -eq 1 -and $logText.Contains($firstLink[0]))
  function PairWithLink([string]$link) {
    $token = [Uri]::UnescapeDataString([regex]::Match($link, '[?&]pairingToken=([^&]+)').Groups[1].Value)
    $body = @{ pairingToken = $token; deviceLabel = "Windows Smoke"; deviceRole = "host-console" } | ConvertTo-Json
    return Invoke-RestMethod -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$Port/aru/v1/pair" -ContentType "application/json" -Body $body
  }
  $oldTokenRejected = $false
  try { $null = PairWithLink $firstLink[0] }
  catch { $oldTokenRejected = [int]$_.Exception.Response.StatusCode -eq 401 }
  Check "previous boot pairing token rejected" $oldTokenRejected
  $grant = PairWithLink $nextLink[0]
  $devices = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/aru/v1/devices" -Headers @{ Authorization = "Bearer $($grant.credentialSecret)" }
  Check "fresh pairing grants authenticated access" (@($devices.devices | Where-Object { $_.isCurrent -and $_.label -eq "Windows Smoke" }).Count -eq 1)
  # Phone artifact ownership does not require a computer collaborator or driver.
  $headers = @{ Authorization = "Bearer $($grant.credentialSecret)" }
  $sourceIdentity = [Guid]::NewGuid().ToString()
  $identityURL = "http://127.0.0.1:$Port/aru/v1/mobile-collaborator-identities/$sourceIdentity"
  $identityBody = @{ displayName = "Phone identity smoke" } | ConvertTo-Json
  $identity = Invoke-RestMethod -Method Put -Uri $identityURL -Headers $headers -ContentType 'application/json' -Body $identityBody
  Check "phone identity has no computer execution" ($identity.authority -eq 'phone' -and -not $identity.turnExecution)
  $mcpURL = "http://127.0.0.1:$Port/aru/v1/mcp"
  $init = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $mcpURL -Headers $headers -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  $headers['mcp-session-id'] = $init.Headers['mcp-session-id']
  function IdentityTool([string]$name, $arguments) {
    $body = @{ jsonrpc = '2.0'; id = 2; method = 'tools/call'; params = @{ name = $name; arguments = $arguments } } | ConvertTo-Json -Depth 10
    $response = Invoke-RestMethod -Method Post -Uri $mcpURL -Headers $headers -ContentType 'application/json' -Body $body
    if ($response.error -or $response.result.isError) { throw "Identity tool failed: $name" }
    return $response.result.structuredContent
  }
  $project = IdentityTool 'aru_collaborator_project_create' @{ collaboratorId = $identity.collaboratorId; title = 'Driver-free page' }
  $publication = IdentityTool 'aru_collaborator_project_publish' @{ collaboratorId = $identity.collaboratorId; projectId = $project.projectId; expectedRevision = $project.revision; networkAccess = 'none' }
  Check "phone identity publishes a real page over MCP" (-not [string]::IsNullOrWhiteSpace($publication.project.surfaceId))
  Start-Sleep -Seconds 1

  # 3. Upgrade retains previous release; rollback swaps back and stays healthy.
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
    -Instance $Instance -BaseRoot $baseRoot -Port $Port -DisplayName "Windows Smoke" -SourceDir $selfhost
  Check "upgrade exits 0" ($LASTEXITCODE -eq 0)
  $restoredIdentity = Invoke-RestMethod -Method Put -Uri $identityURL -Headers @{ Authorization = "Bearer $($grant.credentialSecret)" } -ContentType 'application/json' -Body $identityBody
  Check "upgrade preserves phone artifact owner" ($restoredIdentity.collaboratorId -eq $identity.collaboratorId)
  Check "previous release retained" (Test-Path (Join-Path $instanceRoot "previous.release"))
  $releaseCount = (Get-ChildItem -LiteralPath (Join-Path $instanceRoot "releases") -Directory).Count
  Check "two release slots exist" ($releaseCount -eq 2)

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $control -Instance $Instance -BaseRoot $baseRoot rollback
  Check "rollback exits 0" ($LASTEXITCODE -eq 0)
  Start-Sleep -Seconds 2
  $manifestAfterRollback = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/.well-known/aru.json" -TimeoutSec 10
  Check "manifest healthy after rollback" ($null -ne $manifestAfterRollback.serverId)
  Check "server identity survives rollback" ($manifestAfterRollback.serverId -eq $manifest.serverId)

  # 4. DPAPI round trip through the real provider secret store.
  $secretStoreUri = ([Uri](Join-Path $selfhost "provider-secret-store.mjs")).AbsoluteUri
  $dpapiProbe = @"
import { createProviderSecretStore } from '$secretStoreUri';
const store = createProviderSecretStore();
const availability = store.availability();
if (!availability.supported || availability.storage !== 'windows-dpapi') { console.error(availability); process.exit(1); }
const id = 'provider_0000abcd0000';
store.write(id, 'smoke-secret-value');
if (store.read(id) !== 'smoke-secret-value') { console.error('read mismatch'); process.exit(1); }
store.remove(id);
if (store.read(id) !== null) { console.error('remove failed'); process.exit(1); }
console.log('dpapi-roundtrip-ok');
"@
  $probePath = Join-Path $baseRoot "dpapi-probe.mjs"
  [IO.File]::WriteAllText($probePath, $dpapiProbe)
  $previousSecretRoot = $env:ARU_WINDOWS_SECRET_ROOT
  try {
    $env:ARU_WINDOWS_SECRET_ROOT = Join-Path $baseRoot "secrets"
    $probeResult = & node $probePath
  } finally {
    $env:ARU_WINDOWS_SECRET_ROOT = $previousSecretRoot
  }
  Check "DPAPI provider-secret round trip" (($probeResult -join "`n") -match "dpapi-roundtrip-ok")

  # 5. Uninstall preserves durable data; purge removes it.
  $dataMarker = Join-Path $instanceRoot "data\state.json"
  Check "durable state exists before uninstall" (Test-Path $dataMarker)
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $control -Instance $Instance -BaseRoot $baseRoot uninstall
  Check "uninstall exits 0" ($LASTEXITCODE -eq 0)
  Check "task removed by uninstall" ($null -eq (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue))
  Check "durable data preserved" (Test-Path $dataMarker)
  Check "releases removed" (-not (Test-Path (Join-Path $instanceRoot "releases")))

  # 6. Reinstall over preserved data keeps the server identity.
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
    -Instance $Instance -BaseRoot $baseRoot -Port $Port -DisplayName "Windows Smoke" -SourceDir $selfhost
  Check "reinstall exits 0" ($LASTEXITCODE -eq 0)
  $manifestAfterReinstall = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/.well-known/aru.json" -TimeoutSec 10
  Check "server identity survives reinstall" ($manifestAfterReinstall.serverId -eq $manifest.serverId)

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer `
    -Instance $Instance -BaseRoot $baseRoot -Uninstall -PurgeData
  Check "purge exits 0" ($LASTEXITCODE -eq 0)
  Check "durable data purged" (-not (Test-Path $dataMarker))
} finally {
  Cleanup
}

if ($failures -gt 0) {
  Write-Error "windows-installer-smoke: $failures check(s) failed"
  exit 1
}
Write-Host "ARU_WINDOWS_INSTALLER_SMOKE_OK"
