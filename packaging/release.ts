#!/usr/bin/env bun
/**
 * Release metadata helper for Neo's multi-platform GitHub Actions pipeline.
 *
 * Commands:
 *   bun packaging/release.ts check [--tag <vX.Y.Z>] [--github-output] [--root <dir>]
 *   bun packaging/release.ts bump <X.Y.Z[-pre]> [--root <dir>]
 *   bun packaging/release.ts verify-dist <version> <dist-dir>
 *   bun packaging/release.ts notes <version> [--dist <dir>] [--out <file>]
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ManifestVersions {
  backendPackage: string;
  backendSource: string;
  appPubspec: string;
  appBuildNumber: number;
}

export interface ExpectedAsset {
  filename: string;
  platform: string;
  description: string;
}

export function expectedAssets(version: string): ExpectedAsset[] {
  return [
    {
      filename: `Neo-${version}-macos-arm64.dmg`,
      platform: "macOS (Apple Silicon)",
      description: "Desktop app + bundled `neo-agent` (`arm64`)",
    },
    {
      filename: `Neo-${version}-macos-x64.dmg`,
      platform: "macOS (Intel)",
      description: "Desktop app + bundled `neo-agent` (`x64`)",
    },
    {
      filename: `Neo-${version}-windows-x64-setup.exe`,
      platform: "Windows x64 (Installer)",
      description: "Per-user Inno Setup installer (no admin required)",
    },
    {
      filename: `Neo-${version}-windows-x64-portable.zip`,
      platform: "Windows x64 (Portable)",
      description: "Portable archive — extract and run `neo_agent.exe`",
    },
    {
      filename: `Neo-${version}-linux-x64.deb`,
      platform: "Linux Desktop x64 (.deb)",
      description: "Debian/Ubuntu package (`/opt/neo`, `/usr/bin/neo`, desktop entry)",
    },
    {
      filename: `Neo-${version}-linux-x64.tar.gz`,
      platform: "Linux Desktop x64 (Tarball)",
      description: "Portable desktop bundle + `neo-agent` + desktop installer script",
    },
    {
      filename: `neo-agent-${version}-linux-x64.tar.gz`,
      platform: "Linux Server x64",
      description: "Headless `neo-agent` + `neo-recovery` + web UI + systemd units",
    },
    {
      filename: `neo-agent-${version}-linux-arm64.tar.gz`,
      platform: "Linux Server arm64",
      description: "Headless `neo-agent` + `neo-recovery` + web UI + systemd units",
    },
    {
      filename: `neo-agent-os-${version}-linux-x64.tar.gz`,
      platform: "Tier 1 Agent (`neo-agent-os` x64)",
      description: "Static Rust Tier 1 OS agent + `--relay` bridge + multi-master templates",
    },
    {
      filename: `neo-agent-os-${version}-linux-arm64.tar.gz`,
      platform: "Tier 1 Agent (`neo-agent-os` arm64)",
      description: "Static Rust Tier 1 OS agent for Raspberry Pi / ARM64 SBCs + `--relay`",
    },
    {
      filename: `neo-relayd-${version}-linux-x64.tar.gz`,
      platform: "Companion Relay (`neo-relayd` x64)",
      description: "Multi-master isolated P2P signaling + WSS binary relay + STUN daemon",
    },
    {
      filename: `neo-relayd-${version}-linux-arm64.tar.gz`,
      platform: "Companion Relay (`neo-relayd` arm64)",
      description: "Multi-master isolated P2P signaling + WSS binary relay + STUN daemon",
    },
    {
      filename: `neo-agent-mcu-${version}-sdk.tar.gz`,
      platform: "Tier 2 MCU SDK (`neo-agent-mcu` C99)",
      description: "Zero-heap C99 embedded MCU SDK, tests, and Linux MQTT simulator",
    },
  ];
}

export function normalizeTag(rawTag: string): string {
  return rawTag.startsWith("refs/tags/") ? rawTag.slice("refs/tags/".length) : rawTag;
}

export function isValidSemver(version: string): boolean {
  return SEMVER_RE.test(version);
}

export function isPrerelease(version: string): boolean {
  const match = SEMVER_RE.exec(version);
  return Boolean(match?.[4]);
}

export function readManifestVersions(root: string): ManifestVersions {
  const pkgPath = path.join(root, "backend", "package.json");
  const versionTsPath = path.join(root, "backend", "src", "version.ts");
  const pubspecPath = path.join(root, "app", "pubspec.yaml");

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string") {
    throw new Error(`${pkgPath}: missing string "version" field`);
  }

  const versionTs = fs.readFileSync(versionTsPath, "utf8");
  const tsMatch = /^export const VERSION = "([^"]+)";/m.exec(versionTs);
  if (!tsMatch) {
    throw new Error(`${versionTsPath}: could not find 'export const VERSION = "..."'`);
  }

  const pubspec = fs.readFileSync(pubspecPath, "utf8");
  const pubMatch = /^version:\s*([^\s+]+)(?:\+(\d+))?\s*$/m.exec(pubspec);
  if (!pubMatch) {
    throw new Error(`${pubspecPath}: could not find 'version: X.Y.Z+N'`);
  }

  return {
    backendPackage: pkg.version,
    backendSource: tsMatch[1]!,
    appPubspec: pubMatch[1]!,
    appBuildNumber: pubMatch[2] ? Number.parseInt(pubMatch[2], 10) : 1,
  };
}

export function checkReleaseVersions(
  root: string,
  rawTag?: string,
): { version: string; tag: string; prerelease: boolean; versions: ManifestVersions } {
  const versions = readManifestVersions(root);
  const errors: string[] = [];

  if (!isValidSemver(versions.backendPackage)) {
    errors.push(`backend/package.json version "${versions.backendPackage}" is not valid semver`);
  }
  if (versions.backendSource !== versions.backendPackage) {
    errors.push(
      `backend/src/version.ts (${versions.backendSource}) does not match backend/package.json (${versions.backendPackage})`,
    );
  }
  if (versions.appPubspec !== versions.backendPackage) {
    errors.push(
      `app/pubspec.yaml (${versions.appPubspec}) does not match backend/package.json (${versions.backendPackage})`,
    );
  }

  let tag = `v${versions.backendPackage}`;
  if (rawTag && rawTag.trim().length > 0) {
    tag = normalizeTag(rawTag.trim());
    if (!tag.startsWith("v")) {
      errors.push(`release tag "${tag}" must start with "v" (expected "v${versions.backendPackage}")`);
    } else {
      const tagVersion = tag.slice(1);
      if (!isValidSemver(tagVersion)) {
        errors.push(`release tag "${tag}" is not a valid semver tag (e.g. v0.7.0 or v0.7.0-rc.1)`);
      } else if (tagVersion !== versions.backendPackage) {
        errors.push(
          `release tag "${tag}" does not match manifest version "${versions.backendPackage}" (run: bun packaging/release.ts bump ${tagVersion})`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Release version check failed:\n- ${errors.join("\n- ")}`);
  }

  return {
    version: versions.backendPackage,
    tag,
    prerelease: isPrerelease(versions.backendPackage),
    versions,
  };
}

export function bumpReleaseVersions(root: string, nextVersion: string): ManifestVersions {
  if (!isValidSemver(nextVersion)) {
    throw new Error(`Invalid semver version "${nextVersion}" (expected e.g. 0.7.0 or 0.7.0-rc.1)`);
  }
  const current = readManifestVersions(root);
  const nextBuild = current.appBuildNumber + 1;

  const pkgPath = path.join(root, "backend", "package.json");
  const pkgRaw = fs.readFileSync(pkgPath, "utf8");
  const pkgUpdated = pkgRaw.replace(
    /("version"\s*:\s*)"[^"]+"/,
    `$1"${nextVersion}"`,
  );
  if (pkgUpdated === pkgRaw && current.backendPackage !== nextVersion) {
    throw new Error(`Failed to update version in ${pkgPath}`);
  }
  fs.writeFileSync(pkgPath, pkgUpdated, "utf8");

  const versionTsPath = path.join(root, "backend", "src", "version.ts");
  const tsRaw = fs.readFileSync(versionTsPath, "utf8");
  const tsUpdated = tsRaw.replace(
    /^(export const VERSION = )"[^"]+";/m,
    `$1"${nextVersion}";`,
  );
  if (tsUpdated === tsRaw && current.backendSource !== nextVersion) {
    throw new Error(`Failed to update VERSION in ${versionTsPath}`);
  }
  fs.writeFileSync(versionTsPath, tsUpdated, "utf8");

  const pubspecPath = path.join(root, "app", "pubspec.yaml");
  const pubRaw = fs.readFileSync(pubspecPath, "utf8");
  const pubUpdated = pubRaw.replace(
    /^version:\s*[^\s+]+(?:\+\d+)?\s*$/m,
    `version: ${nextVersion}+${nextBuild}`,
  );
  if (pubUpdated === pubRaw) {
    throw new Error(`Failed to update version in ${pubspecPath}`);
  }
  fs.writeFileSync(pubspecPath, pubUpdated, "utf8");

  return checkReleaseVersions(root, `v${nextVersion}`).versions;
}

export function verifyDistArtifacts(version: string, distDir: string): { filename: string; bytes: number }[] {
  if (!isValidSemver(version)) {
    throw new Error(`Invalid version "${version}"`);
  }
  const results: { filename: string; bytes: number }[] = [];
  const missing: string[] = [];
  const empty: string[] = [];

  for (const asset of expectedAssets(version)) {
    const full = path.join(distDir, asset.filename);
    if (!fs.existsSync(full)) {
      missing.push(asset.filename);
      continue;
    }
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size === 0) {
      empty.push(asset.filename);
      continue;
    }
    results.push({ filename: asset.filename, bytes: stat.size });
  }

  if (missing.length > 0 || empty.length > 0) {
    const lines: string[] = [];
    if (missing.length > 0) lines.push(`Missing release artifacts: ${missing.join(", ")}`);
    if (empty.length > 0) lines.push(`Empty release artifacts: ${empty.join(", ")}`);
    throw new Error(lines.join("\n"));
  }
  return results;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function renderReleaseNotes(version: string, distDir?: string): string {
  const assets = expectedAssets(version);
  const rows = assets.map((asset) => {
    let sizeCol = "";
    if (distDir) {
      const full = path.join(distDir, asset.filename);
      sizeCol = fs.existsSync(full) ? ` | ${formatSize(fs.statSync(full).size)}` : " | —";
    }
    return `| ${asset.platform} | \`${asset.filename}\`${sizeCol} | ${asset.description} |`;
  });

  const header = distDir
    ? "| Platform | Artifact | Size | Notes |\n| --- | --- | ---: | --- |"
    : "| Platform | Artifact | Notes |\n| --- | --- | --- |";

  return [
    `## Downloads (v${version})`,
    "",
    header,
    ...rows,
    "",
    "### Verify checksums",
    "",
    "```sh",
    "sha256sum -c SHA256SUMS.txt --ignore-missing",
    "```",
    "",
    "Each package bundles the pure-TypeScript (Bun-compiled) `neo-agent` backend. Antigravity CLI (`agy`) is not bundled and can be installed directly from **Settings → Kernel and models**.",
    "",
  ].join("\n");
}

function appendGithubOutput(entries: Record<string, string>): void {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  const lines = Object.entries(entries).map(([k, v]) => `${k}=${v}`);
  fs.appendFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
}

function defaultRoot(): string {
  return path.resolve(import.meta.dir, "..");
}

function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(
      [
        "Usage:",
        "  bun packaging/release.ts check [--tag <vX.Y.Z>] [--github-output] [--root <dir>]",
        "  bun packaging/release.ts bump <X.Y.Z[-pre]> [--root <dir>]",
        "  bun packaging/release.ts verify-dist <version> <dist-dir>",
        "  bun packaging/release.ts notes <version> [--dist <dir>] [--out <file>]",
        "",
      ].join("\n"),
    );
    return 0;
  }

  let root = defaultRoot();
  const rootIdx = argv.indexOf("--root");
  if (rootIdx !== -1 && argv[rootIdx + 1]) {
    root = path.resolve(argv[rootIdx + 1]!);
  }

  switch (cmd) {
    case "check": {
      const tagIdx = argv.indexOf("--tag");
      const rawTag = tagIdx !== -1 ? argv[tagIdx + 1] : undefined;
      const writeGh = argv.includes("--github-output");
      const forcePrerelease = argv.includes("--prerelease");
      const info = checkReleaseVersions(root, rawTag);
      const prerelease = info.prerelease || forcePrerelease;
      if (writeGh) {
        appendGithubOutput({
          version: info.version,
          tag: info.tag,
          is_prerelease: String(prerelease),
        });
      }
      process.stdout.write(
        `OK: version=${info.version} tag=${info.tag} prerelease=${prerelease} (pubspec build +${info.versions.appBuildNumber})\n`,
      );
      return 0;
    }
    case "bump": {
      const nextVersion = argv[1];
      if (!nextVersion || nextVersion.startsWith("-")) {
        throw new Error("bump requires <version>, e.g. bun packaging/release.ts bump 0.7.0");
      }
      const updated = bumpReleaseVersions(root, nextVersion);
      process.stdout.write(
        `Bumped Neo to ${updated.backendPackage} (app/pubspec.yaml: ${updated.appPubspec}+${updated.appBuildNumber})\n`,
      );
      process.stdout.write(
        `Next steps:\n  git commit -am "chore: release ${updated.backendPackage}"\n  git tag v${updated.backendPackage}\n  git push origin main --tags\n`,
      );
      return 0;
    }
    case "verify-dist": {
      const version = argv[1];
      const distDir = argv[2];
      if (!version || !distDir) {
        throw new Error("verify-dist requires <version> <dist-dir>");
      }
      const found = verifyDistArtifacts(version, path.resolve(distDir));
      for (const item of found) {
        process.stdout.write(`OK: ${item.filename} (${formatSize(item.bytes)})\n`);
      }
      return 0;
    }
    case "notes": {
      const version = argv[1];
      if (!version) {
        throw new Error("notes requires <version>");
      }
      const distIdx = argv.indexOf("--dist");
      const outIdx = argv.indexOf("--out");
      const distDir = distIdx !== -1 && argv[distIdx + 1] ? path.resolve(argv[distIdx + 1]!) : undefined;
      const outFile = outIdx !== -1 && argv[outIdx + 1] ? path.resolve(argv[outIdx + 1]!) : undefined;
      const md = renderReleaseNotes(version, distDir);
      if (outFile) {
        fs.writeFileSync(outFile, md, "utf8");
      } else {
        process.stdout.write(md);
      }
      return 0;
    }
    default:
      throw new Error(`Unknown command "${cmd}"; see --help`);
  }
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
