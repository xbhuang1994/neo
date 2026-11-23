# 010 Packaging

How the installers are made and what they carry. It builds on [008 Cookbook](008-cookbook.md).

## What a package holds

| Part | Linux server tarball | macOS app | Windows installer |
| --- | --- | --- | --- |
| Backend | `neo-agent` | `Contents/Helpers/neo-agent` | `neo-agent.exe` |
| Interface | `web/` (the web build) | The app itself | `neo_agent.exe` and its files |

The backend finds the web app relative to itself, so a package runs from wherever it is put.

## The runtime

No package carries the agent runtime. The Antigravity CLI (`agy`) is a third-party program under its own terms and updates itself. The backend finds it on the machine ([006 Deployment](006-deployment.md) says where), and the settings install it when missing using its official script: `https://antigravity.google/cli/install.sh`, or `.ps1` on Windows.

## Building

| Platform | Command | Result |
| --- | --- | --- |
| Linux server | `packaging/linux/build-server.sh` | `dist/neo-agent-<version>-linux-x64.tar.gz`, with `neo-agent.service` (system) and `neo-agent-user.service` (user, restarts on any exit) |
| macOS, on a Mac of the wanted architecture | `packaging/macos/build-dmg.sh` | `dist/Neo-<version>-macos-<arch>.dmg` |
| Windows | `packaging\windows\stage.ps1`, then Inno Setup with `packaging\windows\neo-agent.iss` | `dist\Neo-<version>-windows-x64-setup.exe` |

The macOS app is built per architecture, not universal, because its backend is built for one. The Windows installer installs for the current user without administrator rights.

`.github/workflows/release.yml` runs all three for a version tag — on `macos-13` for Intel, `macos-14` for Apple silicon, `windows-latest` and `ubuntu-latest` — and attaches the results and their checksums to a draft release. `.github/workflows/ci.yml` lints and tests the backend on the three systems, tests the app, and builds each desktop runner.

## Signing on macOS

Without a signing identity the app is signed ad hoc, which Apple silicon needs to run it at all; Gatekeeper then asks the person to allow it once (`SETUP.md` says how). With `MACOS_SIGN_IDENTITY` set to a Developer ID identity, `build-dmg.sh` signs the backend, with the entitlements in `packaging/macos/helper.entitlements`, and the app with the hardened runtime. The runtime the backend starts is signed by its vendor. The app is not sandboxed: it starts its backend as a child process, and workers work in the user's folders.

The release workflow imports a certificate and notarizes when these secrets exist: `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`.

## The web font

A browser cannot reach the system's fonts, so the web build carries `app/fonts/NotoSansSC-Regular.otf`: Latin, punctuation and the GB 2312 characters of Noto Sans CJK SC, under the SIL Open Font License. `packaging/make-web-font.py` makes it again. A character outside it shows as a box in the web app; the desktop apps draw with the system's fonts.

## What was verified

The Linux server package is built and tested on Linux: unpacked elsewhere, it finds its web app and passes the browser test of [008 Cookbook](008-cookbook.md) with it. The backend compiles without warnings for the Windows and macOS targets. The macOS and Windows installers, the desktop runners' window code and signing are exercised only by the workflows; treat a first release build on those systems as the test of them.
