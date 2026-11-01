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
  Write-Host 'ok: managed Node discovery works without a junction and rejects a missing executable'
} finally {
  Remove-Item -LiteralPath $BaseRoot -Recurse -Force -ErrorAction SilentlyContinue
}
