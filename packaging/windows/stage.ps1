# Put together what the Windows installer and portable archive carry: the Flutter app and the backend beside it.
# The Antigravity CLI is not in it: the backend finds it on the machine, and the app installs it with its official installer.
#
# Usage: pwsh packaging\windows\stage.ps1 [-SkipPortableZip]
# Needs: bun, flutter.
# Output:
#   - dist\windows-stage (ready for packaging\windows\neo-agent.iss)
#   - dist\Neo-<version>-windows-x64-portable.zip (unless -SkipPortableZip is given)
param(
  [switch]$SkipPortableZip
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$version = (Get-Content (Join-Path $root "backend\package.json") -Raw | ConvertFrom-Json).version
if (-not $version) { throw "could not read version from backend/package.json" }

$distDir = Join-Path $root "dist"
$stage = Join-Path $distDir "windows-stage"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null

Write-Host "[1/4] Building Windows backend binary (neo-agent.exe)..."
Push-Location (Join-Path $root "backend")
try {
  bun install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "bun install failed" }
  $hostArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  if ($hostArch -eq [System.Runtime.InteropServices.Architecture]::X64) {
    bun build --compile --minify --bytecode src/main.ts --outfile dist/neo-agent.exe
  } else {
    bun build --compile --minify --bytecode --target=bun-windows-x64 src/main.ts --outfile dist/neo-agent.exe
  }
  if ($LASTEXITCODE -ne 0) { throw "the backend did not build" }
} finally {
  Pop-Location
}

Write-Host "[2/4] Building Flutter Windows desktop app..."
Push-Location (Join-Path $root "app")
try {
  flutter pub get
  if ($LASTEXITCODE -ne 0) { throw "flutter pub get failed" }
  flutter build windows --release
  if ($LASTEXITCODE -ne 0) { throw "the app did not build" }
} finally {
  Pop-Location
}

Write-Host "[3/4] Staging desktop bundle and smoke-testing neo-agent.exe..."
Copy-Item -Recurse (Join-Path $root "app\build\windows\x64\runner\Release\*") $stage
Copy-Item (Join-Path $root "backend\dist\neo-agent.exe") $stage
Copy-Item (Join-Path $root "LICENSE") $stage

$stagedExe = Join-Path $stage "neo-agent.exe"
$stagedApp = Join-Path $stage "neo_agent.exe"
if (-not (Test-Path $stagedApp)) { throw "missing staged desktop app at $stagedApp" }
if (-not (Test-Path $stagedExe)) { throw "missing staged backend at $stagedExe" }

$versionOutput = (& $stagedExe version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "staged neo-agent.exe version failed (exit $LASTEXITCODE): $versionOutput"
}
if ($versionOutput -notmatch [regex]::Escape($version)) {
  throw "staged neo-agent.exe reported '$versionOutput', expected '$version'"
}
Write-Host "Verified staged backend: $versionOutput"

if (-not $SkipPortableZip) {
  Write-Host "[4/4] Creating portable ZIP archive..."
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $portableName = "Neo-$version-windows-x64"
  $portableTemp = Join-Path $distDir "$portableName-zip-stage"
  $portableRoot = Join-Path $portableTemp $portableName
  $portableZip = Join-Path $distDir "$portableName-portable.zip"
  if (Test-Path $portableTemp) { Remove-Item -Recurse -Force $portableTemp }
  if (Test-Path $portableZip) { Remove-Item -Force $portableZip }
  New-Item -ItemType Directory -Force $portableRoot | Out-Null
  try {
    Copy-Item -Recurse (Join-Path $stage "*") $portableRoot
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
      $portableTemp,
      $portableZip,
      [System.IO.Compression.CompressionLevel]::Optimal,
      $false
    )
  } finally {
    if (Test-Path $portableTemp) { Remove-Item -Recurse -Force $portableTemp }
  }
  Write-Output $portableZip
}

Write-Output $stage
