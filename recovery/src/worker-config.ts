/**
 * Read-only discovery of Neo's backend-configured worker from `<dataDir>/orchestrator.sqlite`,
 * plus discovery of the Antigravity CLI (`agy`) binary.
 *
 * Never writes to Neo's database, never holds the DB open beyond a single read, and falls back
 * gracefully if the DB is missing, locked, or corrupted (which might be the very reason Neo is down).
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { homeDir, type DaemonConfig } from "./config.ts";

export interface ResolvedWorkerConfig {
  kernel: string;
  provider: string;
  model: string | null;
  binary: string | null;
  customCommand?: string;
  customArgs: string[];
  settingsRevision: number | null;
  source: "sqlite" | "override" | "custom" | "fallback";
  dbPath: string;
  blockedCommands: string[];
  recoveryMode: boolean;
  recoveryModeSource: "sqlite" | "default";
  warning?: string;
}

export interface RecoveryModeSetting {
  enabled: boolean;
  source: "sqlite" | "default";
  revision: number | null;
  warning?: string;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function splitPathEnv(pathEnv: string): string[] {
  if (process.platform !== "win32") {
    return pathEnv.split(":").filter((s) => s.length > 0);
  }
  return pathEnv
    .split(";")
    .map((s) => s.replace(/^"+|"+$/g, ""))
    .filter((s) => s.length > 0);
}

function candidateBinaryNames(name: string): string[] {
  if (process.platform === "win32") {
    return [`${name}.exe`, `${name}.cmd`, name];
  }
  return [name];
}

export function defaultInstallDirs(): string[] {
  const home = homeDir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(localAppData, "agy", "bin"), path.join(home, ".local", "bin")];
  }
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

export function findWorkerBinary(
  programName: string,
  overridePath?: string,
  envBin?: string,
  pathEnv: string | undefined = process.env.PATH,
  extraDirs: readonly string[] = defaultInstallDirs(),
): string | null {
  const explicit = overridePath ?? envBin;
  if (explicit && explicit.trim().length > 0) {
    const resolved = path.resolve(explicit.trim());
    return isExecutableFile(resolved) ? resolved : null;
  }

  const dirs = [...(pathEnv ? splitPathEnv(pathEnv) : []), ...extraDirs];
  const names = candidateBinaryNames(programName);
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const file of names) {
      const candidate = path.join(dir, file);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SqliteSettingsSummary {
  revision: number | null;
  kernel: string;
  provider: string;
  model: string | null;
  blockedCommands: string[];
  recoveryMode: boolean;
  hasRecoveryModeField: boolean;
}

function readSettingsFromSqlite(dbPath: string): { ok: true; value: SqliteSettingsSummary } | { ok: false; error: string } {
  if (!fs.existsSync(dbPath)) {
    return { ok: false, error: `Neo database not found at ${dbPath}` };
  }
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const revRow = db
      .query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'settings-revision'")
      .get();
    if (!revRow) {
      return { ok: false, error: "No settings-revision saved in orchestrator.sqlite yet" };
    }
    const revision = Number(JSON.parse(revRow.value));
    if (!Number.isInteger(revision) || revision < 1) {
      return { ok: false, error: `Invalid settings-revision value: ${revRow.value}` };
    }
    const verRow = db
      .query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?1")
      .get(`settings-version:${revision}`);
    if (!verRow) {
      return { ok: false, error: `settings-version:${revision} not found in orchestrator.sqlite` };
    }
    const parsed = JSON.parse(verRow.value);
    const settings = isRecord(parsed) && isRecord(parsed.settings) ? parsed.settings : null;
    if (!settings) {
      return { ok: false, error: `Malformed settings-version:${revision} JSON` };
    }
    const kernel = typeof settings.kernel === "string" && settings.kernel.length > 0 ? settings.kernel : "antigravity";
    let provider = kernel;
    let model: string | null = null;
    if (isRecord(settings.models) && isRecord(settings.models[kernel])) {
      const roleModels = settings.models[kernel] as Record<string, unknown>;
      const execModel = roleModels.executor;
      if (isRecord(execModel) && typeof execModel.model === "string" && execModel.model.trim().length > 0) {
        model = execModel.model.trim();
        if (typeof execModel.provider === "string" && execModel.provider.trim().length > 0) {
          provider = execModel.provider.trim();
        }
      }
    }
    const blockedCommands: string[] = [];
    if (isRecord(settings.executor) && Array.isArray(settings.executor.blockedCommands)) {
      for (const item of settings.executor.blockedCommands) {
        if (typeof item === "string" && item.trim().length > 0) {
          blockedCommands.push(item.trim());
        }
      }
    }
    const hasRecoveryModeField = typeof settings.recoveryMode === "boolean";
    const recoveryMode = hasRecoveryModeField ? (settings.recoveryMode as boolean) : true;
    return {
      ok: true,
      value: {
        revision,
        kernel,
        provider,
        model,
        blockedCommands,
        recoveryMode,
        hasRecoveryModeField,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}

export function kernelBinaryName(kernel: string): string {
  switch (kernel) {
    case "antigravity":
      return "agy";
    default:
      return "agy";
  }
}

/**
 * Lightweight read-only check of Neo's `recoveryMode` toggle in `<dataDir>/orchestrator.sqlite`.
 * Defaults to `enabled: true` when unset or if the database is missing/corrupt so recovery stays fail-safe.
 */
export function readRecoveryModeSetting(dataDir: string): RecoveryModeSetting {
  const dbPath = path.join(dataDir, "orchestrator.sqlite");
  const sqlite = readSettingsFromSqlite(dbPath);
  if (!sqlite.ok) {
    return { enabled: true, source: "default", revision: null, warning: sqlite.error };
  }
  return {
    enabled: sqlite.value.recoveryMode,
    source: sqlite.value.hasRecoveryModeField ? "sqlite" : "default",
    revision: sqlite.value.revision,
  };
}

/**
 * Resolve the recovery worker configuration on demand (re-read on each recovery attempt
 * so updates saved in Neo's Settings take effect automatically without daemon restart).
 */
export function resolveWorkerConfig(config: DaemonConfig): ResolvedWorkerConfig {
  const dbPath = path.join(config.dataDir, "orchestrator.sqlite");
  const sqlite = readSettingsFromSqlite(dbPath);
  const recoveryMode = sqlite.ok ? sqlite.value.recoveryMode : true;
  const recoveryModeSource: "sqlite" | "default" =
    sqlite.ok && sqlite.value.hasRecoveryModeField ? "sqlite" : "default";

  if (config.workerCmd) {
    return {
      kernel: sqlite.ok ? sqlite.value.kernel : "custom",
      provider: sqlite.ok ? sqlite.value.provider : "custom",
      model: config.workerModel ?? (sqlite.ok ? sqlite.value.model : null),
      binary: config.workerCmd,
      customCommand: config.workerCmd,
      customArgs: [...config.workerArgs],
      settingsRevision: sqlite.ok ? sqlite.value.revision : null,
      source: "custom",
      dbPath,
      blockedCommands: sqlite.ok ? sqlite.value.blockedCommands : [],
      recoveryMode,
      recoveryModeSource,
      warning: sqlite.ok ? undefined : sqlite.error,
    };
  }

  const kernel = sqlite.ok ? sqlite.value.kernel : "antigravity";
  const provider = sqlite.ok ? sqlite.value.provider : kernel;
  const model = config.workerModel ?? (sqlite.ok ? sqlite.value.model : null);
  const envBin = kernel === "antigravity" ? process.env.NEO_AGY_BIN : undefined;
  const binary = findWorkerBinary(kernelBinaryName(kernel), config.workerBin, envBin);

  const source: ResolvedWorkerConfig["source"] = config.workerModel || config.workerBin
    ? "override"
    : sqlite.ok
      ? "sqlite"
      : "fallback";

  const warnings: string[] = [];
  if (!sqlite.ok) warnings.push(sqlite.error);
  if (!binary) warnings.push(`Worker runtime binary (${kernelBinaryName(kernel)}) not found on machine`);

  return {
    kernel,
    provider,
    model,
    binary,
    customArgs: [...config.workerArgs],
    settingsRevision: sqlite.ok ? sqlite.value.revision : null,
    source,
    dbPath,
    blockedCommands: sqlite.ok ? sqlite.value.blockedCommands : [],
    recoveryMode,
    recoveryModeSource,
    warning: warnings.length > 0 ? warnings.join("; ") : undefined,
  };
}
