# 010 Packaging

How the installers are made and what they carry. It builds on [008 Cookbook](008-cookbook.md).

## What a package holds

| Part | Linux server tarball | macOS app | Windows installer |
| --- | --- | --- | --- |
| Backend | `neo-agent` | `Contents/Helpers/neo-agent` | `neo-agent.exe` |
| Interface | `web/` (the web build) | The app itself | `neo_agent.exe` and its files |
| Oh My Pi extension | `shim/` | `Contents/Resources/shim/` | `shim\` |
| Runtimes | `runtimes/claude`, `runtimes/omp` | `Contents/Resources/runtimes/` | `runtimes\claude.exe`, `runtimes\omp.exe` |

The backend finds the other parts relative to itself, so a package runs from wherever it is put. With both runtimes a package is about 700 MB.

## The runtimes

`packaging/runtimes.lock.json` pins the two runtimes by version, address and checksum for each platform: Claude Code's per-platform npm packages, and Oh My Pi's release programs. `packaging/fetch-runtimes.py <platform> <dir>` downloads them, checks each against its checksum before writing anything, and stops on a mismatch. The pinned versions are the ones the tests with real runtimes ran against; raise them together with a run of those tests.

Every packaging script takes `--without-runtimes` (`-WithoutRuntimes` on Windows). Such a package uses the runtimes it finds on the machine's `PATH` or by `NEO_CLAUDE_BIN` / `NEO_OMP_BIN`. The Antigravity CLI (`agy`) is never bundled: it signs in to a Google account of its own and is found on the machine like an unbundled runtime.

The runtimes are other parties' programs under their own terms. Claude Code in particular is not open source: check its terms before you pass a package that contains it to anyone else, and build without runtimes when in doubt.

## Building

| Platform | Command | Result |
| --- | --- | --- |
| Linux server | `packaging/linux/build-server.sh` | `dist/neo-agent-<version>-linux-x64.tar.gz`, with `neo-agent.service` (system) and `neo-agent-user.service` (user, restarts on any exit) |
| macOS, on a Mac of the wanted architecture | `packaging/macos/build-dmg.sh` | `dist/Neo-Agent-<version>-macos-<arch>.dmg` |
| Windows | `packaging\windows\stage.ps1`, then Inno Setup with `packaging\windows\neo-agent.iss` | `dist\Neo-Agent-<version>-windows-x64-setup.exe` |

The macOS app is built per architecture, not universal, because each bundled runtime is for one. The Windows installer installs for the current user without administrator rights.

`.github/workflows/release.yml` runs all three for a version tag — on `macos-13` for Intel, `macos-14` for Apple silicon, `windows-latest` and `ubuntu-latest` — and attaches the results and their checksums to a draft release. `.github/workflows/ci.yml` lints and tests the backend on the three systems, tests the app, and builds each desktop runner.

## Signing on macOS

Without a signing identity the app is signed ad hoc, which Apple silicon needs to run it at all; Gatekeeper then asks the person to allow it once (`SETUP.md` says how). With `MACOS_SIGN_IDENTITY` set to a Developer ID identity, `build-dmg.sh` signs the runtimes, the backend and the app with the hardened runtime. The runtimes are JavaScript engines and get the entitlements in `packaging/macos/helper.entitlements` to make code at run time. The app is not sandboxed: it starts its backend as a child process, and workers work in the user's folders.

The release workflow imports a certificate and notarizes when these secrets exist: `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`.

## The web font

A browser cannot reach the system's fonts, so the web build carries `app/fonts/NotoSansSC-Regular.otf`: Latin, punctuation and the GB 2312 characters of Noto Sans CJK SC, under the SIL Open Font License. `packaging/make-web-font.py` makes it again. A character outside it shows as a box in the web app; the desktop apps draw with the system's fonts.

## What was verified

The Linux server package is built and tested on Linux: unpacked elsewhere, it finds its bundled runtimes, extension and web app, and passes the browser test of [008 Cookbook](008-cookbook.md) with them. The backend compiles without warnings for the Windows and macOS targets. The macOS and Windows installers, the desktop runners' window code and signing are exercised only by the workflows; treat a first release build on those systems as the test of them.
