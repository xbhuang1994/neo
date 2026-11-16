# Put together what the Windows installer installs: the Flutter app, the backend beside it and the Oh My Pi
# extension. The agent runtimes are not in it: the backend finds them on the machine, and the app installs them with
# their official installers.
#
# Usage: pwsh packaging\windows\stage.ps1
# Needs: cargo, flutter.  Output: dist\windows-stage, ready for neo-agent.iss.
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$stage = Join-Path $root "dist\windows-stage"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null

Push-Location (Join-Path $root "backend")
cargo build --release -p neo-agent
if ($LASTEXITCODE -ne 0) { throw "the backend did not build" }
Pop-Location
Push-Location (Join-Path $root "app")
flutter build windows --release
if ($LASTEXITCODE -ne 0) { throw "the app did not build" }
Pop-Location

Copy-Item -Recurse (Join-Path $root "app\build\windows\x64\runner\Release\*") $stage
Copy-Item (Join-Path $root "backend\target\release\neo-agent.exe") $stage
New-Item -ItemType Directory -Force (Join-Path $stage "shim") | Out-Null
Copy-Item (Join-Path $root "shim\neo-omp-shim.ts") (Join-Path $stage "shim")
Copy-Item (Join-Path $root "LICENSE") $stage
Write-Output $stage
