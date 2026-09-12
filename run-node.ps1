# Windows sibling of run-node.sh: translate the ARU_* node.env vocabulary into
# Host Core argv. The supervisor loop stands in for systemd Restart=always /
# launchd KeepAlive, because a per-user Scheduled Task has no equivalent knob.
param(
  [string]$ConfigFile = $env:ARU_SELFHOST_CONFIG_FILE,
  [string]$LogFile = ""
)

$ErrorActionPreference = "Stop"

if (-not $ConfigFile -or -not (Test-Path -LiteralPath $ConfigFile)) {
  Write-Error "Aru self-hosted config is not readable: $ConfigFile"
  exit 78
}

$config = @{}
foreach ($line in [IO.File]::ReadAllLines($ConfigFile)) {
  $trimmed = $line.TrimEnd()
  if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
  $separator = $trimmed.IndexOf("=")
  if ($separator -lt 1) { continue }
  $name = $trimmed.Substring(0, $separator)
  $value = $trimmed.Substring($separator + 1)
  if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  $config[$name] = $value
}

foreach ($name in @("ARU_SERVER_ENTRY", "ARU_LISTEN_HOST", "ARU_PORT", "ARU_DATA_DIR", "ARU_BASE_URL", "ARU_TRANSPORT_KIND", "ARU_DISPLAY_NAME", "ARU_NODE_KIND")) {
  if (-not $config[$name]) {
    Write-Error "Aru self-hosted config is missing $name"
    exit 78
  }
}

function ConfigValue([string]$name, [string]$fallback) {
  if ($config[$name]) { return $config[$name] }
  return $fallback
}

$nodeBinary = ConfigValue "ARU_NODE_BINARY" "node.exe"
$arguments = @(
  $config["ARU_SERVER_ENTRY"],
  "--listen-host", $config["ARU_LISTEN_HOST"],
  "--port", $config["ARU_PORT"],
  "--data-dir", $config["ARU_DATA_DIR"],
  "--base-url", $config["ARU_BASE_URL"],
  "--transport-kind", $config["ARU_TRANSPORT_KIND"],
  "--display-name", $config["ARU_DISPLAY_NAME"],
  "--node-kind", $config["ARU_NODE_KIND"],
  "--max-package-mb", (ConfigValue "ARU_MAX_PACKAGE_MB" "2048"),
  "--max-workspace-mb", (ConfigValue "ARU_MAX_WORKSPACE_MB" "512"),
  "--max-workspace-output-mb", (ConfigValue "ARU_MAX_WORKSPACE_OUTPUT_MB" "32"),
  "--plugin-call-timeout-seconds", (ConfigValue "ARU_PLUGIN_CALL_TIMEOUT_SECONDS" "3600"),
  "--container-memory", (ConfigValue "ARU_CONTAINER_MEMORY" "1g"),
  "--container-cpus", (ConfigValue "ARU_CONTAINER_CPUS" "2"),
  "--node-image", (ConfigValue "ARU_NODE_IMAGE" "node:22-alpine"),
  "--python-image", (ConfigValue "ARU_PYTHON_IMAGE" "python:3.13-alpine"),
  "--shell-image", (ConfigValue "ARU_SHELL_IMAGE" "alpine:3.22")
)
if ($config["ARU_MANAGED_WORKSPACE_ROOT"]) {
  $arguments += @("--managed-workspace-root", $config["ARU_MANAGED_WORKSPACE_ROOT"])
}
if ($config["ARU_CONTAINER_RUNTIME"]) {
  $arguments += @("--container-runtime", $config["ARU_CONTAINER_RUNTIME"])
}

if (-not $LogFile) {
  $LogFile = Join-Path (Split-Path -Parent (Split-Path -Parent $ConfigFile)) "logs\host.log"
}
$logDirectory = Split-Path -Parent $LogFile
if (-not (Test-Path -LiteralPath $logDirectory)) {
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
}

while ($true) {
  $writer = [IO.StreamWriter]::new($LogFile, $true, [Text.UTF8Encoding]::new($false))
  try {
    $writer.WriteLine("[run-node] starting Host Core at $([DateTime]::UtcNow.ToString('o'))")
    $writer.Flush()
    & $nodeBinary @arguments 2>&1 | ForEach-Object {
      $writer.WriteLine($_.ToString())
      $writer.Flush()
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $writer.Dispose()
  }
  if ($exitCode -eq 0) { break }
  [IO.File]::AppendAllText($LogFile, "[run-node] Host Core exited with $exitCode; restarting in 3 seconds`n")
  Start-Sleep -Seconds 3
}
