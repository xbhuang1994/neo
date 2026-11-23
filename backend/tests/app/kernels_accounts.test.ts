import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AccountManager,
  AccountsState,
  KEEP_OUTPUT,
  LOGIN_FAILS_ON,
  LOGIN_TIMEOUT_MS,
  NO_LOGIN_FILE_NOTE,
  agyTokenFile,
  antigravityLoginCommand,
  clean,
  emptyObject,
  inspectAntigravityAccount,
  links,
  loginEnv,
  logoutAntigravity,
  tail,
} from "../../src/app/accounts.ts";
import type { AccountKernels, LoginCommand } from "../../src/app/accounts.ts";
import {
  BaseKernels,
  INSTALL_TIMEOUT_MS,
  MAX_SUBAGENTS,
  OutputTail,
  RealKernels,
  buildAntigravityOptions,
  displayName,
  installCommand,
  installTimeoutMs,
  kernelAccount,
  kernelInstall,
  kernelInstallProgress,
  kernelInstalled,
  kernelInstalling,
  kernelLogin,
  kernelLogout,
  outputLines,
  plainText,
  programName,
  runtimeNoteForRole,
  toolKindsForRole,
} from "../../src/app/kernels.ts";
import type { Kernels, ModelOption, SessionSpec } from "../../src/app/kernels.ts";
import type { Kernel } from "../../src/app/kernel-types.ts";
import { key } from "../../src/core/ids.ts";
import { AntigravityDriver, UnboundedChannel, mcpServerName } from "../../src/kernel/index.ts";
import type { Driver, DriverEvent, ToolHost, ToolSpec } from "../../src/kernel/index.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix = "neo-kernels-accounts-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeToolHost(specs: ToolSpec[] = []): ToolHost {
  return {
    specs: () => specs,
    call: async () => ({ ok: true }),
  };
}

function writeExecutableScript(dir: string, name: string, body: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("accounts: terminal cleaning, link extraction, and tail", () => {
  test("cleans_terminal_escapes_and_finds_the_links_to_open", () => {
    const printed =
      "Opening browser…\r\nIf the browser didn't open, visit: \x1b]8;;https://accounts.google.com/o/oauth2/auth?code=true&x=1\x07https://accounts.google.com/o/oauth2/auth?code=true&x=1\x1b]8;;\x07\n\x1b[1;32mPaste code here\x1b[0m >";
    const text = clean(printed);
    expect(text).toBe(
      "Opening browser…\nIf the browser didn't open, visit: https://accounts.google.com/o/oauth2/auth?code=true&x=1\nPaste code here >",
    );
    expect(links(text)).toEqual([
      "https://accounts.google.com/o/oauth2/auth?code=true&x=1",
    ]);
    expect(
      links(
        "Open: https://a.example/x. Local shortcut (this machine only): http://localhost:1/launch",
      ),
    ).toEqual(["https://a.example/x"]);
  });

  test("strips OSC ST sequences, two-char escapes, and Cc controls while preserving tabs and newlines", () => {
    const raw =
      "\x1b]0;Window Title\x1b\\Hello\t\x00\x08\x7f\u0085World\x1bM\nNext\r\nDone";
    expect(clean(raw)).toBe("Hello\tWorld\nNext\nDone");
  });

  test("extracts deduplicated https links across angle brackets, quotes, and trailing punctuation", () => {
    const text =
      'Visit <https://example.com/a>, "https://example.com/b)", \'https://example.com/a.\' [https://example.com/c] https://';
    expect(links(text)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });

  test("tail trims and keeps at most KEEP_OUTPUT UTF-8 bytes without splitting multi-byte chars", () => {
    expect(tail("  hello world  ")).toBe("hello world");
    // Each CJK character is 3 UTF-8 bytes; 2100 * 3 = 6300 > 6000.
    const big = "中".repeat(2100);
    const sliced = tail(big);
    expect(Buffer.byteLength(sliced, "utf8")).toBeLessThanOrEqual(KEEP_OUTPUT);
    expect(sliced).toBe("中".repeat(2000));

    // Offset by 1 ASCII byte so `len - 6000` lands inside a 3-byte char boundary.
    const offsetBig = "a" + "中".repeat(2100);
    const offsetSliced = tail(offsetBig);
    expect(Buffer.byteLength(offsetSliced, "utf8")).toBeLessThanOrEqual(KEEP_OUTPUT);
    expect(offsetSliced.includes("\uFFFD")).toBe(false);
    expect(offsetSliced).toBe("中".repeat(2000));
  });
});

describe("accounts: OAuth token inspection, login command, and logout", () => {
  test("agyTokenFile resolves ~/.gemini/antigravity-cli/antigravity-oauth-token", () => {
    const dir = makeTempDir();
    expect(agyTokenFile(dir)).toBe(
      path.join(dir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    );
  });

  test("inspectAntigravityAccount handles missing file, valid JSON, missing email, and malformed JSON", () => {
    const dir = makeTempDir();
    const tokenPath = agyTokenFile(dir);

    // Missing token file
    const missing = inspectAntigravityAccount(dir);
    expect(missing).toEqual({
      account: null,
      note: NO_LOGIN_FILE_NOTE,
    });

    // Valid token file with id_token_email
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(
      tokenPath,
      JSON.stringify({ id_token_email: "alice@example.com", access_token: "tok" }),
    );
    const present = inspectAntigravityAccount(dir);
    expect(present).toEqual({
      account: { email: "alice@example.com", removable: true },
    });
    expect("note" in present).toBe(false);
    expect(JSON.parse(JSON.stringify(present))).toEqual({
      account: { email: "alice@example.com", removable: true },
    });

    // Token file without id_token_email
    fs.writeFileSync(tokenPath, JSON.stringify({ access_token: "tok" }));
    expect(inspectAntigravityAccount(dir)).toEqual({
      account: { email: "", removable: true },
    });

    // Malformed JSON still returns removable account with empty email (matches Rust unwrap_or_default)
    fs.writeFileSync(tokenPath, "{not-json");
    expect(inspectAntigravityAccount(dir)).toEqual({
      account: { email: "", removable: true },
    });
  });

  test("logoutAntigravity removes token file and is idempotent when already absent", () => {
    const dir = makeTempDir();
    const tokenPath = agyTokenFile(dir);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify({ id_token_email: "bob@example.com" }));
    expect(fs.existsSync(tokenPath)).toBe(true);

    logoutAntigravity(dir);
    expect(fs.existsSync(tokenPath)).toBe(false);

    // Second logout succeeds when ENOENT
    expect(() => logoutAntigravity(dir)).not.toThrow();
  });

  test("antigravityLoginCommand and loginEnv inject BROWSER=true and NO_COLOR=1 without mutating input", () => {
    const baseEnv = { PATH: "/custom/bin", BROWSER: "firefox" };
    const env = loginEnv(baseEnv);
    expect(env).toEqual({ PATH: "/custom/bin", BROWSER: "true", NO_COLOR: "1" });
    expect(baseEnv.BROWSER).toBe("firefox");

    const cmd = antigravityLoginCommand("/usr/local/bin/agy", { CUSTOM: "1" });
    expect(cmd).toEqual({
      program: "/usr/local/bin/agy",
      args: ["acp", "--login"],
      env: { CUSTOM: "1", BROWSER: "true", NO_COLOR: "1" },
      failsOn: LOGIN_FAILS_ON,
    });
  });

  test("emptyObject validates JSON body strictly", () => {
    expect(() => emptyObject({})).not.toThrow();
    expect(() => emptyObject(null)).toThrow("Expected a JSON object");
    expect(() => emptyObject([])).toThrow("Expected a JSON object");
    expect(() => emptyObject("x")).toThrow("Expected a JSON object");
    expect(() => emptyObject({ kernel: "antigravity" })).toThrow("Unknown field kernel");
  });
});

describe("accounts: AccountsState interactive login, cancellation, failsOn, timeout, and logout", () => {
  test("accountsView reports uninstalled, installed with token, and error states faithfully", async () => {
    const dir = makeTempDir();
    const state = new AccountManager();

    const uninstalledKernels = new RealKernels({ find: () => undefined, homeDir: dir });
    expect(await state.accountsView(uninstalledKernels)).toEqual({
      installed: false,
      problem: null,
      account: null,
      note: null,
      login: null,
    });

    const installedKernels = new RealKernels({ find: () => "/bin/agy", homeDir: dir });
    expect(await state.accountsView(installedKernels)).toEqual({
      installed: true,
      problem: null,
      account: null,
      note: NO_LOGIN_FILE_NOTE,
      login: null,
    });

    const tokenPath = agyTokenFile(dir);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify({ id_token_email: "neo@example.com" }));
    expect(await state.accountsView(installedKernels)).toEqual({
      installed: true,
      problem: null,
      account: { email: "neo@example.com", removable: true },
      note: null,
      login: null,
    });

    // Kernels without account() falls back to Rust default error in `problem`
    const minimalKernels: AccountKernels = {
      unavailable: () => undefined,
    };
    expect(await state.accountsView(minimalKernels)).toEqual({
      installed: true,
      problem: "Antigravity CLI account cannot be managed from here",
      account: null,
      note: null,
      login: null,
    });
  });

  test("interactive piped login extracts link immediately, accepts stdin line, completes done, and notifies credentials change", async () => {
    const dir = makeTempDir();
    const script = writeExecutableScript(
      dir,
      "fake-login.sh",
      `#!/usr/bin/env bash
printf 'Opening browser...\\r\\n'
printf 'Visit: \\033]8;;https://accounts.google.com/o/oauth2/auth?state=abc\\007https://accounts.google.com/o/oauth2/auth?state=abc\\033]8;;\\007\\n'
printf '\\033[1;32mPaste code\\033[0m > '
IFS= read -r code
if [ "$code" = "AUTH-CODE-123" ]; then
  echo "Signed in as neo@example.com"
  exit 0
else
  echo "Unexpected code: $code" >&2
  exit 1
fi
`,
    );

    let credsChanged = 0;
    const accounts = new AccountsState({
      linkWaitMs: 3000,
      inputWaitMs: 1500,
      onCredentialsChanged: () => {
        credsChanged += 1;
      },
    });
    const fakeKernels: AccountKernels = {
      unavailable: () => undefined,
      login: (): LoginCommand => ({
        program: script,
        args: [],
        env: loginEnv(),
        failsOn: LOGIN_FAILS_ON,
      }),
    };

    try {
      // Unknown fields rejected
      await expect(accounts.startLogin(fakeKernels, { provider: "google" })).rejects.toThrow(
        "Unknown field provider",
      );

      const started = await accounts.startLogin(fakeKernels, {});
      expect(started.login).not.toBeNull();
      expect(started.login!.id).toBe(1);
      expect(started.login!.state).toBe("running");
      expect(started.login!.links).toEqual([
        "https://accounts.google.com/o/oauth2/auth?state=abc",
      ]);
      expect(started.login!.output).toContain("Paste code >");

      // Input validation checks
      await expect(accounts.loginInput("not-obj")).rejects.toThrow("Expected a JSON object");
      await expect(accounts.loginInput({ code: "x" })).rejects.toThrow("Unknown field code");
      await expect(accounts.loginInput({})).rejects.toThrow("text is required");
      await expect(accounts.loginInput({ text: "line1\nline2" })).rejects.toThrow(
        "Paste one line",
      );
      await expect(accounts.loginInput({ text: "a".repeat(8001) })).rejects.toThrow(
        "Paste one line",
      );

      // Submit valid authorization code (leading/trailing spaces trimmed)
      const finished = await accounts.loginInput({ text: "  AUTH-CODE-123  " });
      expect(finished.login!.id).toBe(1);
      expect(finished.login!.state).toBe("done");
      expect(finished.login!.output).toContain("Signed in as neo@example.com");
      expect(credsChanged).toBe(1);

      // Once done, further loginInput fails
      await expect(accounts.loginInput({ text: "extra" })).rejects.toThrow("No login is waiting");
    } finally {
      accounts.dispose();
    }
  });

  test("failsOn marker immediately marks running login failed and terminates child", async () => {
    const dir = makeTempDir();
    const script = writeExecutableScript(
      dir,
      "fake-fails-on.sh",
      `#!/usr/bin/env bash
echo "Error: couldn't log in due to network"
sleep 30
`,
    );

    const accounts = new AccountsState({ linkWaitMs: 2000 });
    const fakeKernels: AccountKernels = {
      unavailable: () => undefined,
      login: () => ({
        program: script,
        args: [],
        env: loginEnv(),
        failsOn: LOGIN_FAILS_ON,
      }),
    };

    try {
      const started = await accounts.startLogin(fakeKernels, {});
      expect(started.login!.state).toBe("failed");
      expect(started.login!.output).toBe("Error: couldn't log in due to network");
    } finally {
      accounts.dispose();
    }
  });

  test("cancelLogin marks login failed with Cancelled and starting a new login replaces old run safely", async () => {
    const dir = makeTempDir();
    const sleeper = writeExecutableScript(
      dir,
      "fake-sleep.sh",
      `#!/usr/bin/env bash
echo "Waiting at https://example.com/step1"
sleep 30
`,
    );
    const quick = writeExecutableScript(
      dir,
      "fake-quick.sh",
      `#!/usr/bin/env bash
echo "Second run done"
exit 0
`,
    );

    let program = sleeper;
    const accounts = new AccountsState({ linkWaitMs: 2000 });
    const fakeKernels: AccountKernels = {
      unavailable: () => undefined,
      login: () => ({
        program,
        args: [],
        env: loginEnv(),
      }),
    };

    try {
      const first = await accounts.startLogin(fakeKernels, {});
      expect(first.login!.id).toBe(1);
      expect(first.login!.state).toBe("running");

      accounts.cancelLogin();
      const cancelled = accounts.loginView();
      expect(cancelled!.id).toBe(1);
      expect(cancelled!.state).toBe("failed");
      expect(cancelled!.output).toContain("Cancelled");

      // Starting another login while a prior login is STILL running cancels the old one automatically
      program = sleeper;
      const runningAgain = await accounts.startLogin(fakeKernels, {});
      expect(runningAgain.login!.id).toBe(2);
      expect(runningAgain.login!.state).toBe("running");

      program = quick;
      const replaced = await accounts.startLogin(fakeKernels, {});
      expect(replaced.login!.id).toBe(3);
      expect(replaced.login!.state).toBe("done");
      expect(replaced.login!.output).toBe("Second run done");
    } finally {
      accounts.dispose();
    }
  });

  test("loginTimeoutMs enforces login timeout and appends exact ten-minute message", async () => {
    expect(LOGIN_TIMEOUT_MS).toBe(600_000);
    const dir = makeTempDir();
    const script = writeExecutableScript(
      dir,
      "fake-hang.sh",
      `#!/usr/bin/env bash
echo "Hanging..."
sleep 30
`,
    );

    const accounts = new AccountsState({
      loginTimeoutMs: 120,
      linkWaitMs: 500,
    });
    const fakeKernels: AccountKernels = {
      unavailable: () => undefined,
      login: () => ({
        program: script,
        args: [],
        env: loginEnv(),
      }),
    };

    try {
      const res = await accounts.startLogin(fakeKernels, {});
      expect(res.login!.state).toBe("failed");
      expect(res.login!.output).toContain("The login took more than ten minutes");
    } finally {
      accounts.dispose();
    }
  });

  test("startLogin reports spawn error cleanly without leaving a running login", async () => {
    const accounts = new AccountsState();
    const fakeKernels: AccountKernels = {
      unavailable: () => undefined,
      login: () => ({
        program: "/nonexistent/path/to/agy-binary-xyz",
        args: ["acp", "--login"],
        env: loginEnv(),
      }),
    };

    await expect(accounts.startLogin(fakeKernels, {})).rejects.toThrow(
      "Cannot run /nonexistent/path/to/agy-binary-xyz",
    );
    expect(accounts.loginView()).toBeNull();
  });

  test("logout validates empty body, deletes token file, notifies change, and returns refreshed view", async () => {
    const dir = makeTempDir();
    const tokenPath = agyTokenFile(dir);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify({ id_token_email: "alice@example.com" }));

    let changed = 0;
    const accounts = new AccountsState({
      onCredentialsChanged: () => {
        changed += 1;
      },
    });
    const kernels = new RealKernels({ find: () => "/bin/agy", homeDir: dir });

    await expect(accounts.logout(kernels, { account: "google" })).rejects.toThrow(
      "Unknown field account",
    );

    const view = await accounts.logout(kernels, {});
    expect(changed).toBe(1);
    expect(fs.existsSync(tokenPath)).toBe(false);
    expect(view).toEqual({
      installed: true,
      problem: null,
      account: null,
      note: NO_LOGIN_FILE_NOTE,
      login: null,
    });
  });
});

describe("kernels: constants, installer command/parsing, and role options", () => {
  test("installs_antigravity_with_its_vendors_script", () => {
    const [prog, args] = installCommand("antigravity");
    expect(prog.length).toBeGreaterThan(0);
    expect(args[args.length - 1]).toContain("https://antigravity.google/cli/install");
    expect(installTimeoutMs("antigravity")).toBe(600_000);
    expect(INSTALL_TIMEOUT_MS).toBe(600_000);

    // Explicit Unix command
    expect(installCommand("antigravity", "linux")).toEqual([
      "bash",
      ["-c", "set -o pipefail; curl -fsSL https://antigravity.google/cli/install.sh | bash"],
    ]);

    // Explicit Windows command
    expect(installCommand("antigravity", "win32")).toEqual([
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; irm https://antigravity.google/cli/install.ps1 | iex",
      ],
    ]);
  });

  test("reads_an_installers_redrawn_progress_as_lines_without_colours", () => {
    const encoder = new TextEncoder();
    const pending: number[] = [];
    const lines = outputLines(
      pending,
      encoder.encode(
        "\x1b[2m  Downloading\x1b[0m\nReceiving:   3% (1/30), 8.04 MiB | 116.00 KiB/s\rReceiving:   4% (2/",
      ),
    );
    expect(lines).toEqual([
      "Downloading",
      "Receiving:   3% (1/30), 8.04 MiB | 116.00 KiB/s",
    ]);
    expect(outputLines(pending, encoder.encode("30)\r\r\n"))).toEqual([
      "Receiving:   4% (2/30)",
    ]);
    expect(pending.length).toBe(0);

    const tail = new OutputTail();
    for (const line of [
      "==> Downloading",
      "Receiving:   3% (1/30)",
      "Receiving:   4% (2/30)",
      "fatal: early EOF",
    ]) {
      tail.push(line);
    }
    expect(tail.text()).toBe("==> Downloading\nReceiving:   4% (2/30)\nfatal: early EOF");
  });

  test("OutputTail retains at most 12 lines and plainText strips CSI and control characters", () => {
    expect(plainText("\x1b[31m  Error\x07 \x1b[0m")).toBe("Error");
    const tail = new OutputTail();
    for (let i = 1; i <= 15; i++) {
      tail.push(`step-${String.fromCharCode(64 + i)}`);
    }
    const kept = tail.text().split("\n");
    expect(kept.length).toBe(OutputTail.KEEP);
    expect(kept[0]).toBe("step-D");
    expect(kept[kept.length - 1]).toBe("step-O");
  });

  test("says_why_antigravity_cannot_run", () => {
    const kernels = new RealKernels({ find: () => undefined });
    expect(kernels.unavailable("antigravity")).toContain("agy");
    expect(kernels.unavailable("antigravity")).toBe(
      "Antigravity CLI (agy) is not installed. Install it to run sessions",
    );
    expect(kernels.installed("antigravity")).toBe(false);
    expect(kernels.installing("antigravity")).toBe(false);
    expect(kernels.installProgress("antigravity")).toBeUndefined();

    kernels.installingStates.set("antigravity", { line: "" });
    expect(kernels.unavailable("antigravity")).toContain("being installed");
    expect(kernels.unavailable("antigravity")).toBe(
      "Antigravity CLI (agy) is being installed",
    );
    expect(kernels.installing("antigravity")).toBe(true);
    expect(kernels.installProgress("antigravity")).toBeUndefined();
    expect(kernels.installState("antigravity")).toEqual({ installing: true });

    kernels.installingStates.set("antigravity", { line: "Downloading 40%" });
    expect(kernels.installProgress("antigravity")).toBe("Downloading 40%");
    expect(kernels.installState("antigravity")).toEqual({
      installing: true,
      line: "Downloading 40%",
    });
  });

  test("role tool kinds, runtime notes, bridgeId, and thinking wiring match Rust verbatim", () => {
    expect(MAX_SUBAGENTS).toBe(8);
    expect(programName("antigravity")).toBe("agy");
    expect(displayName("antigravity")).toBe("Antigravity CLI");

    expect(toolKindsForRole("worker")).toEqual([
      "read",
      "bash",
      "web",
      "edit",
      "write",
      "task",
    ]);
    expect(toolKindsForRole("sidecar")).toEqual(["read"]);
    expect(toolKindsForRole("orchestrator")).toEqual(["read", "bash"]);
    expect(toolKindsForRole("watchdog")).toEqual(["read", "bash"]);

    const server = mcpServerName();
    expect(runtimeNoteForRole("sidecar", false)).not.toContain(server);
    expect(runtimeNoteForRole("sidecar", true)).toContain(
      `Application tools are on MCP server \`${server}\``,
    );
    expect(runtimeNoteForRole("worker", false)).toContain("at most 8 concurrent subagents");
    expect(runtimeNoteForRole("orchestrator", false)).toContain(
      "Do not use browser, image, scheduling or web-search tools.",
    );

    const spec: SessionSpec = {
      sessionId: "ticket:abc",
      role: "watchdog",
      cwd: "/tmp/work",
      systemPrompt: "Inspect state.",
      model: { provider: "antigravity", model: "gemini-3.8-flash-low" },
    };
    const host = makeToolHost([
      { name: "inspect", description: "Inspect", schema: { type: "object" } },
    ]);
    const opts = buildAntigravityOptions(
      "/usr/local/bin/agy",
      spec,
      host,
      { PATH: "/blocked:/usr/bin" },
      ["/usr/local/bin/neo-agent", "agy-hook"],
    );
    expect(opts.program).toBe("/usr/local/bin/agy");
    expect(opts.cwd).toBe("/tmp/work");
    expect(opts.tools).toEqual(["read", "bash"]);
    expect(opts.model).toBe("gemini-3.8-flash-low");
    expect(opts.thinking).toBe("low");
    expect(opts.env).toEqual({ PATH: "/blocked:/usr/bin" });
    expect(opts.hookRelay).toEqual(["/usr/local/bin/neo-agent", "agy-hook"]);
    expect(opts.bridgeId).toBe(key(["ticket:abc"]).slice(0, 8));
    expect(opts.systemPrompt).toStartWith("Inspect state.\n\nRuntime note:");
    expect(opts.systemPrompt).toContain(`ServerName: "${server}"`);

    // Non-watchdog roles do not set thinking
    const workerOpts = buildAntigravityOptions(
      "/usr/local/bin/agy",
      { ...spec, role: "worker", model: null },
      makeToolHost(),
    );
    expect(workerOpts.thinking).toBeUndefined();
    expect(workerOpts.model).toBeUndefined();
    expect(workerOpts.tools).toEqual(["read", "bash", "web", "edit", "write", "task"]);
  });

  test("RealKernels.open returns AntigravityDriver when available and throws unavailable when missing", () => {
    const events = new UnboundedChannel<DriverEvent>();
    const spec: SessionSpec = {
      sessionId: "main",
      role: "orchestrator",
      cwd: makeTempDir(),
      systemPrompt: "Main prompt",
    };

    const missing = new RealKernels({ find: () => undefined });
    expect(() => missing.open("antigravity", spec, makeToolHost(), events)).toThrow(
      "Antigravity CLI (agy) is not installed. Install it to run sessions",
    );

    const present = new RealKernels({ find: () => "/usr/local/bin/agy" });
    const driver = present.open("antigravity", spec, makeToolHost(), events);
    expect(driver).toBeInstanceOf(AntigravityDriver);
    expect(driver.kernel()).toBe("antigravity");
  });
});

describe("kernels: RealKernels installer lifecycle, idempotency, concurrency, and listModels", () => {
  test("install tracks live progress, shares one in-flight promise concurrently, and is idempotent once installed", async () => {
    const dir = makeTempDir();
    const binPath = path.join(dir, "agy");
    const countFile = path.join(dir, "runs.count");
    const installer = writeExecutableScript(
      dir,
      "fake-install.sh",
      `#!/usr/bin/env bash
echo x >> "${countFile}"
printf '\\033[2mDownloading\\033[0m\\n'
printf 'Progress: 10%%\\r'
sleep 0.08
printf 'Progress: 100%%\\n'
cat > "${binPath}" << 'EOF'
#!/usr/bin/env bash
echo "fake-agy"
EOF
chmod +x "${binPath}"
`,
    );

    const kernels = new RealKernels({
      find: () => (fs.existsSync(binPath) ? binPath : undefined),
      installerCommand: () => [installer, []],
      installerTimeoutMs: 10_000,
    });

    const p1 = kernels.install("antigravity");
    const p2 = kernels.install("antigravity");
    // Concurrent callers share the exact same in-flight promise.
    expect(p1).toBe(p2);
    expect(kernels.installing("antigravity")).toBe(true);
    expect(kernels.unavailable("antigravity")).toBe(
      "Antigravity CLI (agy) is being installed",
    );

    // Poll briefly during the 80ms sleep to observe live installProgress line
    const observedLines: string[] = [];
    const observer = (async () => {
      for (let i = 0; i < 30; i++) {
        const line = kernels.installProgress("antigravity");
        if (line !== undefined && observedLines[observedLines.length - 1] !== line) {
          observedLines.push(line);
        }
        if (!kernels.installing("antigravity")) break;
        await Bun.sleep(10);
      }
    })();

    const [r1, r2] = await Promise.all([p1, p2]);
    await observer;

    expect(r1).toBe(binPath);
    expect(r2).toBe(binPath);
    expect(kernels.installing("antigravity")).toBe(false);
    expect(kernels.installProgress("antigravity")).toBeUndefined();
    expect(kernels.installed("antigravity")).toBe(true);
    expect(observedLines.length).toBeGreaterThan(0);

    // Installer ran exactly once for the two concurrent callers
    const runs = fs.readFileSync(countFile, "utf8").trim().split("\n");
    expect(runs.length).toBe(1);

    // Calling install again when already installed is idempotent and does not re-run installer
    const r3 = await kernels.install("antigravity");
    expect(r3).toBe(binPath);
    const runsAfter = fs.readFileSync(countFile, "utf8").trim().split("\n");
    expect(runsAfter.length).toBe(1);
  });

  test("install reports nonzero exit with compacted OutputTail and cleans installing state", async () => {
    const dir = makeTempDir();
    const installer = writeExecutableScript(
      dir,
      "fail-install.sh",
      `#!/usr/bin/env bash
printf '==> Downloading\\n'
printf 'Receiving: 10%%\\rReceiving: 20%%\\n'
printf 'fatal: curl failed\\n' >&2
exit 22
`,
    );

    const kernels = new RealKernels({
      find: () => undefined,
      installerCommand: () => [installer, []],
    });

    await expect(kernels.install("antigravity")).rejects.toThrow(
      /Installing Antigravity CLI failed \(exit status: 22\):/,
    );
    try {
      await kernels.install("antigravity");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("==> Downloading");
      expect(msg).toContain("Receiving: 20%");
      expect(msg).not.toContain("Receiving: 10%");
      expect(msg).toContain("fatal: curl failed");
    }
    expect(kernels.installing("antigravity")).toBe(false);
  });

  test("install fails if installer finishes cleanly without agy appearing on disk", async () => {
    const dir = makeTempDir();
    const installer = writeExecutableScript(dir, "noop-install.sh", "#!/usr/bin/env bash\nexit 0\n");

    const kernels = new RealKernels({
      find: () => undefined,
      installerCommand: () => [installer, []],
    });

    await expect(kernels.install("antigravity")).rejects.toThrow(
      "The Antigravity CLI installer finished, but its program (agy) was not found where it installs itself",
    );
    expect(kernels.installing("antigravity")).toBe(false);
  });

  test("install times out, kills process group, and clears installing state", async () => {
    const dir = makeTempDir();
    const installer = writeExecutableScript(
      dir,
      "hang-install.sh",
      `#!/usr/bin/env bash
echo "Starting download"
sleep 30
`,
    );

    const kernels = new RealKernels({
      find: () => undefined,
      installerCommand: () => [installer, []],
      installerTimeoutMs: 120,
    });

    await expect(kernels.install("antigravity")).rejects.toThrow(
      "Installing Antigravity CLI took longer than 0 minutes and was stopped",
    );
    expect(kernels.installing("antigravity")).toBe(false);
  });

  test("RealKernels.listModels and account/login/logout aliases delegate cleanly", async () => {
    const dir = makeTempDir();
    const fakeAgy = writeExecutableScript(
      dir,
      "agy",
      `#!/usr/bin/env bash
if [ "$1" = "models" ] && [ "$NEO_TEST_ENV" = "yes" ]; then
  printf 'gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\n'
  printf 'gemini-3.8-pro-high\\tGemini 3.8 Pro (High)\\n'
  exit 0
fi
exit 1
`,
    );

    const kernels = new RealKernels({
      find: () => fakeAgy,
      homeDir: dir,
      env: { NEO_TEST_ENV: "yes" },
    });

    const models = await kernels.listModels("antigravity");
    expect(models).toEqual([
      {
        id: "gemini-3.8-flash-low",
        provider: "antigravity",
        name: "Gemini 3.8 Flash (Low)",
      },
      {
        id: "gemini-3.8-pro-high",
        provider: "antigravity",
        name: "Gemini 3.8 Pro (High)",
      },
    ]);

    expect(await kernels.accountStatus()).toEqual({
      account: null,
      note: NO_LOGIN_FILE_NOTE,
    });
    expect(kernels.loginCommand()).toEqual({
      program: fakeAgy,
      args: ["acp", "--login"],
      env: { NEO_TEST_ENV: "yes", BROWSER: "true", NO_COLOR: "1" },
      failsOn: LOGIN_FAILS_ON,
    });
    await expect(kernels.logout()).resolves.toBeUndefined();

    // Missing agy fails require() with the exact unavailable message
    const missing = new RealKernels({ find: () => undefined, homeDir: dir });
    const unavailableMsg = "Antigravity CLI (agy) is not installed. Install it to run sessions";
    await expect(missing.listModels("antigravity")).rejects.toThrow(unavailableMsg);
    await expect(missing.accountStatus()).rejects.toThrow(unavailableMsg);
    expect(() => missing.loginCommand()).toThrow(unavailableMsg);
    await expect(missing.logout()).rejects.toThrow(unavailableMsg);
  });

  test("BaseKernels and kernel* default helpers match Rust Kernels trait defaults", async () => {
    class MinimalKernels extends BaseKernels {
      open(): Driver {
        throw new Error("not used");
      }
      async models(_kernel: Kernel): Promise<ModelOption[]> {
        return [];
      }
      unavailable(_kernel: Kernel): string | undefined {
        return undefined;
      }
    }

    const base = new MinimalKernels();
    expect(base.installed("antigravity")).toBe(true);
    expect(base.installing("antigravity")).toBe(false);
    expect(base.installProgress("antigravity")).toBeUndefined();
    await expect(base.install("antigravity")).rejects.toThrow(
      "Antigravity CLI cannot be installed from here",
    );
    await expect(base.account()).rejects.toThrow(
      "Antigravity CLI account cannot be managed from here",
    );
    expect(() => base.login()).toThrow("Antigravity CLI cannot log in from here");
    await expect(base.logout()).rejects.toThrow("Antigravity CLI cannot log out from here");

    // Plain object implementing only required Kernels methods
    const bare: Kernels = {
      open: () => {
        throw new Error("not used");
      },
      models: async () => [],
      unavailable: () => "missing",
    };
    expect(kernelInstalled(bare, "antigravity")).toBe(false);
    expect(kernelInstalling(bare, "antigravity")).toBe(false);
    expect(kernelInstallProgress(bare, "antigravity")).toBeUndefined();
    await expect(kernelInstall(bare, "antigravity")).rejects.toThrow(
      "Antigravity CLI cannot be installed from here",
    );
    await expect(kernelAccount(bare)).rejects.toThrow(
      "Antigravity CLI account cannot be managed from here",
    );
    expect(() => kernelLogin(bare)).toThrow("Antigravity CLI cannot log in from here");
    await expect(kernelLogout(bare)).rejects.toThrow("Antigravity CLI cannot log out from here");
  });
});
