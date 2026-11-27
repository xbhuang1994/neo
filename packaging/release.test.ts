import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bumpReleaseVersions,
  checkReleaseVersions,
  expectedAssets,
  isPrerelease,
  isValidSemver,
  normalizeTag,
  readManifestVersions,
  renderReleaseNotes,
  verifyDistArtifacts,
} from "./release.ts";

const ROOT = path.resolve(import.meta.dir, "..");

function makeTempRepo(version = "0.6.0", buildNumber = 6): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-release-test-"));
  fs.mkdirSync(path.join(dir, "backend", "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "backend", "package.json"),
    JSON.stringify({ name: "neo-backend", version, private: true }, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "backend", "src", "version.ts"),
    `/** Neo backend version. */\nexport const VERSION = "${version}";\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "app", "pubspec.yaml"),
    `name: neo_agent\nversion: ${version}+${buildNumber}\n`,
    "utf8",
  );
  return dir;
}

describe("packaging/release.ts", () => {
  test("repo manifests are currently in sync and valid semver", () => {
    const info = checkReleaseVersions(ROOT);
    expect(isValidSemver(info.version)).toBe(true);
    expect(info.tag).toBe(`v${info.version}`);
    expect(info.versions.backendPackage).toBe(info.versions.backendSource);
    expect(info.versions.backendPackage).toBe(info.versions.appPubspec);
  });

  test("validates matching and mismatched tags including refs/tags/ prefix", () => {
    const dir = makeTempRepo("1.2.3", 12);
    try {
      expect(normalizeTag("refs/tags/v1.2.3")).toBe("v1.2.3");
      const ok = checkReleaseVersions(dir, "refs/tags/v1.2.3");
      expect(ok.version).toBe("1.2.3");
      expect(ok.tag).toBe("v1.2.3");
      expect(ok.prerelease).toBe(false);

      expect(() => checkReleaseVersions(dir, "v1.2.4")).toThrow(/does not match manifest version/);
      expect(() => checkReleaseVersions(dir, "1.2.3")).toThrow(/must start with "v"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects manifest drift between package.json, version.ts, and pubspec.yaml", () => {
    const dir = makeTempRepo("0.6.0", 6);
    try {
      fs.writeFileSync(
        path.join(dir, "backend", "src", "version.ts"),
        `export const VERSION = "0.6.1";\n`,
        "utf8",
      );
      expect(() => checkReleaseVersions(dir)).toThrow(/backend\/src\/version\.ts/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bumps all manifests including Cargo.toml (when present) and increments pubspec build number", () => {
    const dir = makeTempRepo("0.6.0", 6);
    try {
      fs.mkdirSync(path.join(dir, "agents", "neo-agent-os"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "agents", "neo-agent-os", "Cargo.toml"),
        `[package]\nname = "neo-agent-os"\nversion = "0.6.0"\nedition = "2021"\n\n[dependencies]\nserde = { version = "1" }\n`,
        "utf8",
      );

      const bumped = bumpReleaseVersions(dir, "0.7.0-rc.1");
      expect(bumped.backendPackage).toBe("0.7.0-rc.1");
      expect(bumped.backendSource).toBe("0.7.0-rc.1");
      expect(bumped.appPubspec).toBe("0.7.0-rc.1");
      expect(bumped.appBuildNumber).toBe(7);

      const cargoRc = fs.readFileSync(path.join(dir, "agents", "neo-agent-os", "Cargo.toml"), "utf8");
      expect(cargoRc).toContain('version = "0.7.0-rc.1"');
      expect(cargoRc).toContain('serde = { version = "1" }');

      const checked = checkReleaseVersions(dir, "v0.7.0-rc.1");
      expect(checked.prerelease).toBe(true);
      expect(isPrerelease("0.7.0")).toBe(false);
      expect(isPrerelease("0.7.0-rc.1")).toBe(true);

      const finalRel = bumpReleaseVersions(dir, "0.7.0");
      expect(finalRel.appBuildNumber).toBe(8);
      expect(readManifestVersions(dir).backendPackage).toBe("0.7.0");
      const cargoFinal = fs.readFileSync(path.join(dir, "agents", "neo-agent-os", "Cargo.toml"), "utf8");
      expect(cargoFinal).toContain('version = "0.7.0"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("verifyDistArtifacts checks completeness and non-empty files, and notes renders all artifacts", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "neo-dist-test-"));
    try {
      const version = "0.7.0";
      const assets = expectedAssets(version);
      expect(assets.length).toBe(16);
      const filenames = assets.map((a) => a.filename);
      expect(filenames).toContain(`neo-agent-os-${version}-macos-arm64.tar.gz`);
      expect(filenames).toContain(`neo-agent-os-${version}-macos-x64.tar.gz`);
      expect(filenames).toContain(`neo-agent-os-${version}-windows-x64.zip`);

      expect(() => verifyDistArtifacts(version, dist)).toThrow(/Missing release artifacts/);

      for (const a of assets) {
        fs.writeFileSync(path.join(dist, a.filename), "mock-artifact-bytes", "utf8");
      }
      const verified = verifyDistArtifacts(version, dist);
      expect(verified.length).toBe(16);

      const notes = renderReleaseNotes(version, dist);
      for (const a of assets) {
        expect(notes).toContain(a.filename);
      }
      expect(notes).toContain("SHA256SUMS.txt");

      // Empty file should fail verification
      fs.writeFileSync(path.join(dist, assets[0]!.filename), "", "utf8");
      expect(() => verifyDistArtifacts(version, dist)).toThrow(/Empty release artifacts/);
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe("GitHub Actions multi-platform workflow contracts", () => {
  test("release.yml covers macOS arm64/x64, Windows installer/portable, Linux desktop deb/tar.gz, Linux server x64/arm64, multi-platform neo-agent-os, and SHA256SUMS", () => {
    const releaseYml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    expect(releaseYml).toContain('tags: ["v*"]');
    expect(releaseYml).toContain("workflow_dispatch:");
    expect(releaseYml).toContain("packaging/release.ts check");
    expect(releaseYml).toContain("packaging/macos/build-dmg.sh --arch ${{ matrix.arch }}");
    expect(releaseYml).toContain("packaging/macos/build-agent-os.sh --arch ${{ matrix.arch }}");
    expect(releaseYml).toContain("dist/neo-agent-os-*-macos-${{ matrix.arch }}.tar.gz");
    expect(releaseYml).toContain("./packaging/windows/stage.ps1");
    expect(releaseYml).toContain("./packaging/windows/build-agent-os.ps1");
    expect(releaseYml).toContain("dist/neo-agent-os-*-windows-x64.zip");
    expect(releaseYml).toContain("packaging\\windows\\neo-agent.iss");
    expect(releaseYml).toContain("packaging/linux/build-desktop.sh --arch x64");
    expect(releaseYml).toContain("packaging/linux/build-server.sh --arch x64");
    expect(releaseYml).toContain("packaging/linux/build-server.sh --arch arm64 --skip-web-build");
    expect(releaseYml).toContain("packaging/linux/build-multi-device.sh");
    expect(releaseYml).toContain("packaging/release.ts verify-dist");
    expect(releaseYml).toContain("SHA256SUMS.txt");
    expect(releaseYml).toContain("softprops/action-gh-release@v2");
  });

  test("macos build-dmg.sh performs inside-out signing without clobbering helper entitlements", () => {
    const dmgScript = fs.readFileSync(path.join(ROOT, "packaging", "macos", "build-dmg.sh"), "utf8");
    const entitlements = fs.readFileSync(path.join(ROOT, "packaging", "macos", "helper.entitlements"), "utf8");
    expect(dmgScript).not.toContain('codesign --force --deep');
    expect(dmgScript).toContain("codesign --verify --deep --strict");
    expect(dmgScript).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
    expect(entitlements).toContain("com.apple.security.cs.disable-executable-page-protection");
  });
});
