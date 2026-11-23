/**
 * The command line and the optional configuration file. Both name only what belongs to the machine: where data is
 * kept and how the API is offered. Everything else is set in the app.
 */

import fs from "node:fs";

/** Result type for CLI parsing and config loading. */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

/** The usage text. */
export const USAGE = `Neo

Usage:
  neo-agent serve [options]            Run as a server: the API, and the web app when its files are found.
  neo-agent desktop-sidecar [options]  Run as the desktop app's backend (started by the app itself).
  neo-agent doctor [options]           Check what this machine provides: Antigravity CLI, git, directories.
  neo-agent version                    Print the version.

Options for serve:
  --config <file>         A JSON file with dataDir, host, port, token, webDir.
  --data-dir <dir>        Where state is kept. Default: the per-user data directory.
  --host <host>           Address to listen on. Default: 127.0.0.1.
  --port <port>           Port to listen on. Default: 3082; 0 picks a free one.
  --token <token>         Access token (at least 16 characters); also NEO_TOKEN. Required unless listening on loopback.
  --web-dir <dir>         The web app's files. Default: found beside the program.
  --init-settings <file>  Settings (JSON) to start from when none are stored yet.
  --allow-multiple        Allow another instance for a different data directory; also NEO_ALLOW_MULTIPLE=1.

Options for desktop-sidecar:
  --data-dir <dir>, --allow-multiple as above.
  --port <port>           Default: 0.
  --token-stdin           Read the access token from the first line of standard input.

Environment:
  NEO_AGY_BIN                   The Antigravity CLI program, when not on PATH or where its installer puts it.
  NEO_DATA_DIR                  Same as --data-dir.
`;

/** What every command takes. */
export interface Common {
  /** `--data-dir`. */
  dataDir?: string;
  /** `--allow-multiple`. */
  allowMultiple: boolean;
}

/** Default `Common` options. */
export function defaultCommon(): Common {
  return { allowMultiple: false };
}

/** `serve`. */
export interface Serve {
  /** Shared options. */
  common: Common;
  /** `--config`. */
  config?: string;
  /** `--host`. */
  host?: string;
  /** `--port`. */
  port?: number;
  /** `--token`. */
  token?: string;
  /** `--web-dir`. */
  webDir?: string;
  /** `--init-settings`. */
  initSettings?: string;
}

/** Default `Serve` options. */
export function defaultServe(): Serve {
  return { common: defaultCommon() };
}

/** `desktop-sidecar`. */
export interface Sidecar {
  /** Shared options. */
  common: Common;
  /** `--port`. */
  port: number;
  /** `--token-stdin`. */
  tokenStdin: boolean;
}

/** Default `Sidecar` options. */
export function defaultSidecar(): Sidecar {
  return { common: defaultCommon(), port: 0, tokenStdin: false };
}

/** A parsed command line. */
export type Command =
  | { kind: "serve"; options: Serve }
  | { kind: "sidecar"; options: Sidecar }
  | { kind: "doctor"; options: Common }
  | { kind: "version" }
  | { kind: "help" };

/** The configuration file of `serve`. */
export interface ConfigFile {
  /** Where state is kept. */
  dataDir?: string;
  /** Address to listen on. */
  host?: string;
  /** Port to listen on. */
  port?: number;
  /** Access token. */
  token?: string;
  /** The web app's files. */
  webDir?: string;
}

const ALLOWED_CONFIG_KEYS = new Set(["dataDir", "host", "port", "token", "webDir"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Helper namespace for `ConfigFile`. */
export const ConfigFile = {
  /** Empty default configuration. */
  default(): ConfigFile {
    return {};
  },

  /** Read and strictly validate a configuration file (camelCase, deny unknown fields). */
  read(filePath: string): Result<ConfigFile, string> {
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      return { ok: false, error: `Cannot read ${filePath}: ${errorMessage(error)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { ok: false, error: `${filePath}: ${errorMessage(error)}` };
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: `${filePath}: invalid type: expected a JSON object` };
    }

    const config: ConfigFile = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!ALLOWED_CONFIG_KEYS.has(key)) {
        return {
          ok: false,
          error: `${filePath}: unknown field \`${key}\`, expected one of \`dataDir\`, \`host\`, \`port\`, \`token\`, \`webDir\``,
        };
      }
      if (value === null || value === undefined) {
        continue;
      }
      if (key === "port") {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) {
          return {
            ok: false,
            error: `${filePath}: invalid value for field \`port\`, expected an integer from 0 to 65535`,
          };
        }
        config.port = value;
      } else {
        if (typeof value !== "string") {
          return {
            ok: false,
            error: `${filePath}: invalid type for field \`${key}\`, expected a string`,
          };
        }
        if (key === "dataDir") config.dataDir = value;
        else if (key === "host") config.host = value;
        else if (key === "token") config.token = value;
        else if (key === "webDir") config.webDir = value;
      }
    }

    return { ok: true, value: config };
  },
};

class Args {
  private readonly items: readonly string[];
  private index: number;

  constructor(items: readonly string[], startIndex: number) {
    this.items = items;
    this.index = startIndex;
  }

  /** The next option as `[name, inlineValue]`. */
  next(): [string, string | undefined] | undefined {
    if (this.index >= this.items.length) {
      return undefined;
    }
    const arg = this.items[this.index++];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        return [arg.slice(0, eq), arg.slice(eq + 1)];
      }
    }
    return [arg, undefined];
  }

  value(name: string, inline: string | undefined): Result<string, string> {
    let raw: string | undefined;
    if (inline !== undefined) {
      raw = inline;
    } else if (this.index < this.items.length) {
      raw = this.items[this.index++];
    }
    if (raw === undefined || raw.length === 0) {
      return { ok: false, error: `${name} needs a value` };
    }
    return { ok: true, value: raw };
  }
}

function parsePort(text: string): Result<number, string> {
  if (/^\+?[0-9]+$/.test(text)) {
    const num = Number(text);
    if (Number.isInteger(num) && num >= 0 && num <= 65535) {
      return { ok: true, value: num };
    }
  }
  return { ok: false, error: `--port takes a number from 0 to 65535, not ${JSON.stringify(text)}` };
}

function parseFlag(name: string, inline: string | undefined): Result<boolean, string> {
  if (inline === undefined) {
    return { ok: true, value: true };
  }
  return { ok: false, error: `${name} takes no value` };
}

/** Take an option every command has; false when `name` is not one. */
function parseShared(
  common: Common,
  name: string,
  inline: string | undefined,
  args: Args,
): Result<boolean, string> {
  if (name === "--data-dir") {
    const val = args.value(name, inline);
    if (!val.ok) return val;
    common.dataDir = val.value;
    return { ok: true, value: true };
  }
  if (name === "--allow-multiple") {
    const f = parseFlag(name, inline);
    if (!f.ok) return f;
    common.allowMultiple = f.value;
    return { ok: true, value: true };
  }
  return { ok: true, value: false };
}

function unknownOption(name: string, command: string): string {
  return `Unknown option ${name} for ${command}; see neo-agent help`;
}

/** Parse the arguments after the program's name. */
export function parse(args: readonly string[]): Result<Command, string> {
  if (args.length === 0) {
    return { ok: true, value: { kind: "help" } };
  }
  const command = args[0];
  const rest = new Args(args, 1);
  const common = defaultCommon();

  switch (command) {
    case "serve": {
      const serve = defaultServe();
      let entry: [string, string | undefined] | undefined;
      while ((entry = rest.next()) !== undefined) {
        const [name, inline] = entry;
        const shared = parseShared(common, name, inline, rest);
        if (!shared.ok) return shared;
        if (shared.value) continue;

        switch (name) {
          case "--config": {
            const val = rest.value(name, inline);
            if (!val.ok) return val;
            serve.config = val.value;
            break;
          }
          case "--host": {
            const val = rest.value(name, inline);
            if (!val.ok) return val;
            serve.host = val.value;
            break;
          }
          case "--port": {
            const val = rest.value(name, inline);
            if (!val.ok) return val;
            const p = parsePort(val.value);
            if (!p.ok) return p;
            serve.port = p.value;
            break;
          }
          case "--token": {
            const val = rest.value(name, inline);
            if (!val.ok) return val;
            serve.token = val.value;
            break;
          }
          case "--web-dir": {
            const val = rest.value(name, inline);
            if (!val.ok) return val;
            serve.webDir = val.value;
            break;
          }
          case "--init-settings": {
            const val = rest.value(name, inline);
            if (!val.ok) return val;
            serve.initSettings = val.value;
            break;
          }
          default:
            return { ok: false, error: unknownOption(name, "serve") };
        }
      }
      serve.common = common;
      return { ok: true, value: { kind: "serve", options: serve } };
    }
    case "desktop-sidecar": {
      const sidecar = defaultSidecar();
      let entry: [string, string | undefined] | undefined;
      while ((entry = rest.next()) !== undefined) {
        const [name, inline] = entry;
        const shared = parseShared(common, name, inline, rest);
        if (!shared.ok) return shared;
        if (shared.value) continue;

        switch (name) {
          case "--port": {
            const val = rest.value(name, inline);
            if (!val.ok) return val;
            const p = parsePort(val.value);
            if (!p.ok) return p;
            sidecar.port = p.value;
            break;
          }
          case "--token-stdin": {
            const f = parseFlag(name, inline);
            if (!f.ok) return f;
            sidecar.tokenStdin = f.value;
            break;
          }
          default:
            return { ok: false, error: unknownOption(name, "desktop-sidecar") };
        }
      }
      sidecar.common = common;
      return { ok: true, value: { kind: "sidecar", options: sidecar } };
    }
    case "doctor": {
      let entry: [string, string | undefined] | undefined;
      while ((entry = rest.next()) !== undefined) {
        const [name, inline] = entry;
        const shared = parseShared(common, name, inline, rest);
        if (!shared.ok) return shared;
        if (!shared.value) {
          return { ok: false, error: unknownOption(name, "doctor") };
        }
      }
      return { ok: true, value: { kind: "doctor", options: common } };
    }
    case "version":
    case "--version":
    case "-V":
      return { ok: true, value: { kind: "version" } };
    case "help":
    case "--help":
    case "-h":
      return { ok: true, value: { kind: "help" } };
    default:
      return { ok: false, error: `Unknown command ${command}; see neo-agent help` };
  }
}
