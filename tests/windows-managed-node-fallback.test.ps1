# Focused fixture; run with Windows PowerShell on Windows.
$ErrorActionPreference = 'Stop'
$installer = Join-Path (Split-Path -Parent $PSScriptRoot) 'install-windows.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "Installer does not parse: $errors" }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ManagedNodeBinary' }, $true)
if (-not $definition) { throw 'ManagedNodeBinary not found' }
Invoke-Expression $definition.Extent.Text
$BaseRoot = Join-Path ([IO.Path]::GetTempPath()) ('aru-node-fixture-' + [Guid]::NewGuid().ToString('N'))
try {
  $version = Join-Path $BaseRoot 'runtime\node-v22.1.0-win-x64'
  New-Item -ItemType Directory -Path $version -Force | Out-Null
  $expected = Join-Path $version 'node.exe'
  [IO.File]::WriteAllText($expected, 'fixture')
  if ((ManagedNodeBinary) -ne $expected) { throw 'Versioned Node was not usable without a junction' }
  Remove-Item -LiteralPath $expected -Force
  if ($null -ne (ManagedNodeBinary)) { throw 'Missing executable was accepted' }
  # Execute the real installer function with local synthetic download/extraction
  # and a junction-only failure. Ordinary directories use the real filesystem.
  $installDefinition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'InstallManagedNode' }, $true)
  Invoke-Expression $installDefinition.Extent.Text
  function Fail([string]$message) { throw $message }
  function Log([string]$message) { $script:diagnostic = $message }
  function Sha256File([string]$path) { return 'fixturehash' }
  function RemoveLink([string]$path) {}
  function Invoke-WebRequest($Uri, $OutFile, [switch]$UseBasicParsing) {
    if ($Uri -match 'SHASUMS256') { [IO.File]::WriteAllText($OutFile, 'fixturehash  node-v22.1.0-win-x64.zip') }
    else { [IO.File]::WriteAllText($OutFile, 'synthetic archive') }
  }
  function Expand-Archive($LiteralPath, $DestinationPath, [switch]$Force) {
    $target = Join-Path $DestinationPath 'node-v22.1.0-win-x64'
    Microsoft.PowerShell.Management\New-Item -ItemType Directory -Path $target -Force | Out-Null
    if (-not $script:missingNode) { [IO.File]::WriteAllText((Join-Path $target 'node.exe'), 'fixture') }
  }
  function New-Item($ItemType, $Path, $Value, [switch]$Force, $ErrorAction) {
    if ($ItemType -eq 'Junction') { throw 'synthetic junction permission denied' }
    Microsoft.PowerShell.Management\New-Item -ItemType $ItemType -Path $Path -Force:$Force
  }
  $oldArchitecture = $env:PROCESSOR_ARCHITECTURE
  try {
    $env:PROCESSOR_ARCHITECTURE = 'AMD64'
    InstallManagedNode
    if ($script:managedNodeFallback -ne $expected) { throw 'Junction failure did not select the versioned executable' }
    if ((ManagedNodeBinary) -ne $expected) { throw 'Retry cannot discover runtime after junction failure' }
    if ($script:diagnostic -notlike '*current-node*synthetic junction permission denied*') { throw 'Missing junction path/cause diagnostic' }
    $script:missingNode = $true
    try { InstallManagedNode; throw 'Expected extraction failure' }
    catch { if ($_.Exception.Message -notlike '*extraction did not produce*node.exe*') { throw } }
    if (-not (Test-Path -LiteralPath $expected)) { throw 'Failed extraction removed previous working runtime' }
  } finally { $env:PROCESSOR_ARCHITECTURE = $oldArchitecture }
  Write-Host 'ok: junction failure falls back, retry discovers runtime, and failed extraction preserves previous runtime'
} finally {
  Remove-Item -LiteralPath $BaseRoot -Recurse -Force -ErrorAction SilentlyContinue
}
