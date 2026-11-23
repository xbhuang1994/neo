/**
 * Neo's program entry point:
 * 1. Ultra-fast stand-in check when started from `<data>/worker-bin/<cmd>` (zero heavy imports, exit 126).
 * 2. Ultra-fast `agy-hook <url>` relay over loopback TCP_NODELAY (zero heavy imports).
 * 3. Lazy-loaded full CLI (`serve`, `desktop-sidecar`, `doctor`, `version`, `--help`).
 */

import * as path from "node:path";
import { runAgyHook } from "./agent/hook-fast.ts";

const REFUSED_STATUS = 126;

function isWorkerBinStandIn(programPath: string): boolean {
  if (!programPath) return false;
  return path.basename(path.dirname(programPath)) === "worker-bin";
}

function invokedAs(programPath: string): string {
  let name = path.basename(programPath);
  const lower = name.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".cmd")) {
    name = name.slice(0, -4);
  }
  return name.length > 0 ? name : "this command";
}

function refusalMessage(command: string): string {
  return `${command} is blocked in this installation by the Neo settings; do the work without it.`;
}

function cliArgs(): string[] {
  const argv = process.argv;
  const execBase = path.basename(process.execPath).toLowerCase();
  // Compiled Bun binary: argv = [exe, ...userArgs] or [exe, "/$bunfs/...", ...userArgs]
  if (execBase !== "bun" && execBase !== "bun.exe") {
    if (argv.length >= 2 && (argv[1]?.startsWith("/$bunfs/") || argv[1]?.startsWith("B:\\~BUN\\"))) {
      return argv.slice(2);
    }
    return argv.slice(1);
  }
  // `bun run src/main.ts ...`: argv = [bun, script, ...userArgs]
  return argv.slice(2);
}

async function main(): Promise<void> {
  const program = process.argv[0] ?? process.execPath;
  if (isWorkerBinStandIn(program)) {
    process.stderr.write(`${refusalMessage(invokedAs(program))}\n`);
    process.exit(REFUSED_STATUS);
  }

  const args = cliArgs();
  if (args[0] === "agy-hook") {
    const code = await runAgyHook(args[1] ?? "");
    process.exit(code);
  }

  if (isWorkerBinStandIn(process.execPath)) {
    process.stderr.write(`${refusalMessage(invokedAs(process.execPath))}\n`);
    process.exit(REFUSED_STATUS);
  }

  const { runCli } = await import("./agent/runner.ts");
  const code = await runCli(args);
  process.exit(code);
}

if (import.meta.main) {
  void main();
}
