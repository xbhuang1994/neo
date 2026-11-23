# Put together what the Windows installer installs: the Flutter app and the backend beside it. The Antigravity CLI is
# not in it: the backend finds it on the machine, and the app installs it with its official installer.
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
Copy-Item (Join-Path $root "LICENSE") $stage
Write-Output $stage
