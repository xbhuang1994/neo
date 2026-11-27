# 010 Packaging

How the installers and multi-platform GitHub Actions releases are made, and what each package carries. It builds on [008 Cookbook](008-cookbook.md).

## What a package holds

| Part | Linux server tarball (`x64` / `arm64`) | Linux desktop (`.deb` / `.tar.gz`) | macOS app (`.dmg`) | Windows (`.exe` / portable `.zip`) |
| --- | --- | --- | --- | --- |
| Backend | `neo-agent` | `neo-agent` beside `neo_agent` | `Contents/Helpers/neo-agent` | `neo-agent.exe` beside `neo_agent.exe` |
| Recovery daemon | `neo-recovery` + `neo-recovery-user.service` | — | — | — |
| Interface | `web/` (the web build) | `neo_agent`, `lib/`, `data/` | `Neo.app` (universal Flutter bundle) | `neo_agent.exe`, DLLs, `data/` |

The backend finds the web app relative to itself, and `neo-recovery` finds `neo-agent` and `web/` relative to itself, so server packages run from wherever they are unpacked. The desktop apps locate `neo-agent` right beside the app binary (or in `Contents/Helpers/` on macOS).

## The runtime

No package carries the agent runtime. The Antigravity CLI (`agy`) is a third-party program under its own terms and updates itself. The backend finds it on the machine ([006 Deployment](006-deployment.md) says where), and the settings install it when missing using its official script: `https://antigravity.google/cli/install.sh`, or `.ps1` on Windows.

## Building locally

| Platform | Command | Result |
| --- | --- | --- |
| Linux server (`x64` / `arm64`) | `packaging/linux/build-server.sh --arch x64` (or `arm64`, optional `--skip-web-build`) | `dist/neo-agent-<version>-linux-<arch>.tar.gz` with `neo-agent`, `neo-recovery`, `web/`, and systemd units (`neo-agent.service`, `neo-agent-user.service`, `neo-recovery-user.service`) |
| Multi-device agents & relay (`x64` / `arm64` / C99 SDK) | `packaging/linux/build-multi-device.sh [--targets ...]` | `dist/neo-agent-os-<version>-linux-{x64,arm64}.tar.gz`, `dist/neo-relayd-<version>-linux-{x64,arm64}.tar.gz`, and `dist/neo-agent-mcu-<version>-sdk.tar.gz` |
| Linux desktop (`x64`) | `packaging/linux/build-desktop.sh --arch x64` | `dist/Neo-<version>-linux-x64.tar.gz` (relocatable + `install-desktop.sh`) and `dist/Neo-<version>-linux-x64.deb` (`/opt/neo`, `/usr/bin/neo`, desktop entry & icon) |
| macOS (`arm64` / `x64`) | `packaging/macos/build-dmg.sh --arch arm64` (or `x64`) | `dist/Neo-<version>-macos-<arch>.dmg` |
| Windows (`x64`) | `pwsh packaging\windows\stage.ps1`, then Inno Setup with `packaging\windows\neo-agent.iss` | `dist\Neo-<version>-windows-x64-portable.zip` and `dist\Neo-<version>-windows-x64-setup.exe` |

The macOS app is built per architecture, not universal, because its bundled `neo-agent` backend is compiled for one architecture. The Windows installer installs for the current user without administrator rights.

## Multi-platform GitHub Actions release

Version numbers live in three manifests (`backend/package.json`, `backend/src/version.ts`, and `app/pubspec.yaml`). Use `packaging/release.ts` to bump and verify them together:

```sh
bun packaging/release.ts bump 0.7.0          # updates all 3 manifests and increments pubspec build number
bun packaging/release.ts check --tag v0.7.0  # verifies manifests match the release tag
git commit -am "chore: release 0.7.0"
git tag v0.7.0
git push origin main --tags
```

`.github/workflows/release.yml` runs on any `v*` tag push and via manual `workflow_dispatch`:

1. **`prepare` (`ubuntu-latest`)**: validates that `backend/package.json`, `backend/src/version.ts`, `app/pubspec.yaml`, and the release tag match, then runs the backend, recovery, packaging, and Flutter test suites.
2. **`macos` (`macos-15-intel`, matrix `x64` & `arm64`)**: builds universal `Neo.app` with Bun cross-compiled `neo-agent` per arch, performs inside-out signing preserving `helper.entitlements`, verifies Mach-O arch and entitlements, optionally notarizes, and uploads both `.dmg` images.
3. **`windows` (`windows-latest`)**: compiles `neo-agent.exe` and Flutter Windows release, smoke-tests `neo-agent.exe version`, builds `Neo-<version>-windows-x64-portable.zip` and Inno Setup `Neo-<version>-windows-x64-setup.exe`.
4. **`linux-desktop` (`ubuntu-latest`)**: builds Flutter Linux release + `neo-agent`, packages and verifies both `Neo-<version>-linux-x64.tar.gz` and `Neo-<version>-linux-x64.deb`.
5. **`linux-server` (`ubuntu-latest`)**: builds the web app once, compiles `neo-agent` and `neo-recovery` for both `x64` and `arm64`, smoke-tests the unpacked `x64` server (including live `/api/health` and `/` web serving), and verifies `arm64` ELF binaries.
6. **`multi-device` (`ubuntu-latest`)**: tests `neo-relay`, `neo-agent-os`, and `neo-agent-mcu`, then runs `packaging/linux/build-multi-device.sh` to build `neo-agent-os` (`x64`/`arm64`), `neo-relayd` (`x64`/`arm64`), and the `neo-agent-mcu` C99 SDK tarball.
7. **`publish` (`ubuntu-latest`)**: verifies all 13 artifacts exist and are non-empty, computes and self-checks sorted `SHA256SUMS.txt`, generates structured release notes alongside GitHub's changelog, and publishes a GitHub Release (`draft: false` on `v*` tag push; `workflow_dispatch` defaults to `draft: true`; semver prereleases like `v0.7.0-rc.1` are marked `prerelease: true` automatically).

Running `workflow_dispatch` with an empty `tag` performs a full multi-platform dry-run build and attaches workflow artifacts without creating a GitHub Release; passing a matching `tag` publishes a release (with selectable `draft`, `prerelease`, and `skip_tests` options).

`.github/workflows/ci.yml` verifies manifest consistency, typechecks and tests `backend` and `recovery` across Linux, macOS, and Windows, tests the Flutter app, and builds each desktop runner.

## Signing on macOS

Without a signing identity the app is signed ad hoc, which Apple silicon needs to run it at all; Gatekeeper then asks the person to allow it once (`SETUP.md` says how). With `MACOS_SIGN_IDENTITY` set to a Developer ID identity, `build-dmg.sh` signs nested frameworks first, then `Contents/Helpers/neo-agent` with `packaging/macos/helper.entitlements` (Bun/JavaScriptCore hardened runtime JIT entitlements), and finally the outer `Neo.app` bundle without `--deep` so helper entitlements are preserved.

The release workflow imports a certificate and notarizes when these secrets exist: `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`.

## The web font

A browser cannot reach the system's fonts, so the web build carries `app/fonts/NotoSansSC-Regular.otf`: Latin, punctuation and the GB 2312 characters of Noto Sans CJK SC, under the SIL Open Font License. `packaging/make-web-font.py` makes it again. A character outside it shows as a box in the web app; the desktop apps draw with the system's fonts.

## What was verified

On Linux: `packaging/release.ts` unit/contract tests, full backend/recovery/Flutter tests, both `linux-x64` and `linux-arm64` server tarballs (with live HTTP + web smoke test for `x64` and ELF arch verification for `arm64`), and `build-desktop.sh` tarball + `.deb` packaging verification. The macOS `.dmg` signing/notarization, Windows installer/portable archive, and native Linux GTK compilation are exercised directly by `.github/workflows/release.yml` on GitHub's hosted runners.
