# Build Windows x64 Tier 1 OS agent (neo-agent-os.exe) release ZIP archive:
#   - dist\neo-agent-os-<version>-windows-x64.zip
#
# Usage: pwsh packaging\windows\build-agent-os.ps1 [-Version X.Y.Z]
param(
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = (Get-Content (Join-Path $root "backend\package.json") -Raw | ConvertFrom-Json).version
}
if ([string]::IsNullOrWhiteSpace($Version)) {
  throw "could not determine version from backend/package.json"
}

$distDir = Join-Path $root "dist"
New-Item -ItemType Directory -Force $distDir | Out-Null

Write-Host "[1/3] Building Windows Tier 1 OS agent (neo-agent-os.exe + neo-agent-os-bg.exe)..."
Push-Location (Join-Path $root "agents\neo-agent-os")
try {
  cargo build --release --bins
  if ($LASTEXITCODE -ne 0) { throw "cargo build --release --bins failed for neo-agent-os" }
} finally {
  Pop-Location
}

$builtExe = Join-Path $root "agents\neo-agent-os\target\release\neo-agent-os.exe"
$builtBgExe = Join-Path $root "agents\neo-agent-os\target\release\neo-agent-os-bg.exe"
if (-not (Test-Path $builtExe)) {
  throw "expected compiled binary not found at $builtExe"
}
if (-not (Test-Path $builtBgExe)) {
  throw "expected compiled background launcher not found at $builtBgExe"
}

$name = "neo-agent-os-$Version-windows-x64"
$stageTemp = Join-Path $distDir "$name-zip-stage"
$stageRoot = Join-Path $stageTemp $name
$stageDeploy = Join-Path $stageRoot "deploy"
$zipPath = Join-Path $distDir "$name.zip"

if (Test-Path $stageTemp) { Remove-Item -Recurse -Force $stageTemp }
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
New-Item -ItemType Directory -Force $stageDeploy | Out-Null

try {
  Write-Host "[2/3] Staging neo-agent-os.exe, neo-agent-os-bg.exe and running --version smoke check..."
  Copy-Item $builtExe (Join-Path $stageRoot "neo-agent-os.exe")
  Copy-Item $builtBgExe (Join-Path $stageRoot "neo-agent-os-bg.exe")
  Copy-Item (Join-Path $root "LICENSE") $stageRoot
  Copy-Item -Recurse (Join-Path $root "deploy\multi-master\*") $stageDeploy

  $stagedExe = Join-Path $stageRoot "neo-agent-os.exe"
  $verOut = (& $stagedExe --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "neo-agent-os.exe --version smoke check failed (exit $LASTEXITCODE): $verOut"
  }
  if ($verOut -notmatch "neo-agent-os") {
    throw "unexpected neo-agent-os.exe --version output: $verOut"
  }
  Write-Host "Verified staged neo-agent-os.exe: $verOut"

  Write-Host "[3/3] Creating ZIP archive $zipPath..."
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageTemp,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
} finally {
  if (Test-Path $stageTemp) { Remove-Item -Recurse -Force $stageTemp }
}

Write-Output $zipPath
