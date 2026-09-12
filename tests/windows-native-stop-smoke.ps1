# Exercise the native-process cleanup independently of Task Scheduler's varying
# child-termination behavior. Two real Hosts share an entry point; stopping one
# must release its port without touching the other's process or durable identity.
$ErrorActionPreference = 'Stop'
$selfhost = Split-Path -Parent $PSScriptRoot
$root = Join-Path ([IO.Path]::GetTempPath()) ('aru-native-stop-' + [Guid]::NewGuid().ToString('N'))
$node = (Get-Command node.exe).Source
$entry = Join-Path $selfhost 'aru-selfhost-stub.mjs'
$instances = @()
try {
  foreach ($index in 0..1) {
    $port = 8892 + $index
    $directory = Join-Path $root "instance-$index"
    $data = Join-Path $directory 'data'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $config = Join-Path $directory 'node.env'
    $lines = @(
      "ARU_NODE_BINARY=$node", "ARU_SERVER_ENTRY=$entry", 'ARU_LISTEN_HOST=127.0.0.1',
      "ARU_PORT=$port", "ARU_DATA_DIR=$data", "ARU_BASE_URL=http://127.0.0.1:$port",
      'ARU_TRANSPORT_KIND=http', 'ARU_DISPLAY_NAME=Native stop smoke', 'ARU_NODE_KIND=home-windows'
    )
    [IO.File]::WriteAllText($config, ($lines -join "`n"), [Text.UTF8Encoding]::new($false))
    $arguments = @("`"$entry`"", '--listen-host', '127.0.0.1', '--port', $port,
      '--data-dir', "`"$data`"", '--base-url', "http://127.0.0.1:$port", '--transport-kind', 'http',
      '--display-name', '"Native stop smoke"', '--node-kind', 'home-windows', '--container-runtime', 'none')
    $process = Start-Process -FilePath $node -ArgumentList $arguments -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $directory 'stdout.log') -RedirectStandardError (Join-Path $directory 'stderr.log')
    $instance = @{ Config = $config; Process = $process; URL = "http://127.0.0.1:$port/.well-known/aru.json" }
    $instances += $instance
    $manifest = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
      try { $manifest = Invoke-RestMethod -Uri $instance.URL -TimeoutSec 2 }
      catch { Start-Sleep -Milliseconds 100 }
    } while (-not $manifest -and [DateTime]::UtcNow -lt $deadline)
    if (-not $manifest) { throw 'Native Host did not become ready' }
    $instance.ServerId = $manifest.serverId
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $selfhost 'run-node.ps1') -ConfigFile $instances[0].Config -Stop
  if ($LASTEXITCODE -ne 0 -or -not $instances[0].Process.WaitForExit(5000)) { throw 'Selected native Host survived stop' }
  $stillReachable = $false
  try { $null = Invoke-RestMethod -Uri $instances[0].URL -TimeoutSec 2; $stillReachable = $true } catch {}
  if ($stillReachable) { throw 'Selected Host still owns its port' }
  $other = Invoke-RestMethod -Uri $instances[1].URL -TimeoutSec 5
  if ($instances[1].Process.HasExited -or $other.serverId -ne $instances[1].ServerId) { throw 'Unrelated Host was affected' }
  Write-Host 'ARU_WINDOWS_NATIVE_STOP_OK: selected Host stopped; unrelated Host remains healthy'
} finally {
  foreach ($instance in $instances) {
    if (-not $instance.Process.HasExited) { & taskkill.exe /PID $instance.Process.Id /T /F *> $null }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
