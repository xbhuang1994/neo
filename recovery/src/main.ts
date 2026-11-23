/**
 * Independent Neo Recovery Daemon CLI entry point.
 * Zero dependency on Neo's application, HTTP, store, or kernel source modules.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { parseCli, USAGE, VERSION, type DaemonConfig } from "./config.ts";
import { RecoverySupervisor } from "./supervisor.ts";
import { resolveWorkerConfig } from "./worker-config.ts";

function cliArgs(): string[] {
  const argv = process.argv;
  const execBase = path.basename(process.execPath).toLowerCase();
  if (execBase !== "bun" && execBase !== "bun.exe") {
    if (argv.length >= 2 && (argv[1]?.startsWith("/$bunfs/") || argv[1]?.startsWith("B:\\~BUN\\"))) {
      return argv.slice(2);
    }
    return argv.slice(1);
  }
  return argv.slice(2);
}

function runDoctor(config: DaemonConfig): number {
  const worker = resolveWorkerConfig(config);
  const targetExists = fs.existsSync(config.targetBin);
  const repoExists = fs.existsSync(config.repoDir);
  const webExists = config.webDir ? fs.existsSync(path.join(config.webDir, "index.html")) : false;

  process.stdout.write(`neo-recovery ${VERSION}\n`);
  process.stdout.write(`Mode:             ${config.mode}\n`);
  process.stdout.write(`Entry point:      http://${config.host}:${config.port}/\n`);
  process.stdout.write(`Target binary:    ${config.targetBin} (${targetExists ? "ok" : "missing"})\n`);
  process.stdout.write(`Target args:      ${JSON.stringify(config.targetArgs)}\n`);
  process.stdout.write(`Web dir:          ${config.webDir ?? "(auto)"} (${webExists ? "ok" : "not checked/missing"})\n`);
  process.stdout.write(`Repo dir:         ${config.repoDir} (${repoExists ? "ok" : "missing"})\n`);
  process.stdout.write(`Neo data dir:     ${config.dataDir}\n`);
  process.stdout.write(`Recovery state:   ${config.stateDir}\n`);
  process.stdout.write(`Recovery mode:    ${worker.recoveryMode ? "enabled" : "disabled"} (source: ${worker.recoveryModeSource})\n`);
  process.stdout.write(`Worker kernel:    ${worker.kernel} (source: ${worker.source}${
    worker.settingsRevision !== null ? `, rev ${worker.settingsRevision}` : ""
  })\n`);
  process.stdout.write(`Worker model:     ${worker.model ?? "(runtime default)"}\n`);
  process.stdout.write(`Worker binary:    ${worker.binary ?? "MISSING"}\n`);
  if (worker.warning) {
    process.stdout.write(`Warning:          ${worker.warning}\n`);
  }
  return worker.binary ? 0 : 1;
}

async function runStatus(baseUrl: string, token?: string): Promise<number> {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const target = new URL(`${trimmed}/_recovery/status`);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const result = await new Promise<{ status: number; body: string } | { error: string }>((resolve) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port ? Number(target.port) : 80,
        path: target.pathname + target.search,
        method: "GET",
        headers,
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (err) => resolve({ error: err.message }));
    req.end();
  });

  if ("error" in result) {
    process.stderr.write(`Cannot reach recovery daemon at ${target.href}: ${result.error}\n`);
    return 1;
  }
  process.stdout.write(`${result.body}\n`);
  return result.status === 200 ? 0 : 1;
}

function waitForShutdownSignal(): Promise<string> {
  return new Promise<string>((resolve) => {
    let done = false;
    const finish = (why: string) => {
      if (done) return;
      done = true;
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      if (process.platform !== "win32") process.off("SIGHUP", onHup);
      resolve(why);
    };
    const onInt = () => finish("SIGINT");
    const onTerm = () => finish("SIGTERM");
    const onHup = () => finish("SIGHUP");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    if (process.platform !== "win32") process.on("SIGHUP", onHup);
  });
}

async function runStart(config: DaemonConfig): Promise<number> {
  const supervisor = new RecoverySupervisor(config);
  const started = await supervisor.start();
  if (!started.ok) {
    process.stderr.write(`${started.error}\n`);
    return started.exitCode;
  }

  const shownHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  process.stdout.write(
    `${JSON.stringify({
      pid: process.pid,
      version: VERSION,
      mode: config.mode,
      entryUrl: `http://${shownHost}:${started.entryPort}/`,
      recoveryUrl: `http://${shownHost}:${started.entryPort}/_recovery`,
      entryPort: started.entryPort,
      targetPort: started.targetPort,
    })}\n`,
  );
  process.stderr.write(
    `[neo-recovery] Ready (${config.mode} mode) on http://${config.host}:${started.entryPort}/ -> target port ${started.targetPort}\n`,
  );

  const why = await waitForShutdownSignal();
  process.stderr.write(`[neo-recovery] Stopping (${why})...\n`);
  await supervisor.stop();
  return 0;
}

async function main(): Promise<void> {
  const parsed = parseCli(cliArgs());
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }

  const cmd = parsed.value;
  switch (cmd.kind) {
    case "help":
      process.stdout.write(USAGE);
      process.exit(0);
    case "version":
      process.stdout.write(`neo-recovery ${VERSION}\n`);
      process.exit(0);
    case "doctor":
      process.exit(runDoctor(cmd.config));
    case "status":
      process.exit(await runStatus(cmd.url, cmd.token));
    case "start":
      process.exit(await runStart(cmd.config));
  }
}

if (import.meta.main) {
  void main();
}
