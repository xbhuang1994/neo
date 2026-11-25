import { describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import {
  AGY_KEYRING_SERVICE,
  AGY_KEYRING_USER,
  createSystemKeyringBackend,
  decodeGoKeyringSecret,
  decodeWinCredBlob,
  GO_KEYRING_BASE64_PREFIX,
  parseWinPowerShellDeleteResult,
  parseWinPowerShellReadResult,
  readWinCredBlobFromStruct,
  winCredTargetName,
  winPowerShellArgs,
} from "../../src/app/keyring.ts";
import { inspectAntigravityAccountAsync, parseAntigravityToken, resolveHome } from "../../src/app/accounts.ts";

describe("keyring: cross-platform Antigravity CLI credential compatibility", () => {
  test("matches agy's zalando/go-keyring service ('gemini') and user ('antigravity')", () => {
    expect(AGY_KEYRING_SERVICE).toBe("gemini");
    expect(AGY_KEYRING_USER).toBe("antigravity");
    expect(winCredTargetName(AGY_KEYRING_SERVICE, AGY_KEYRING_USER)).toBe("gemini:antigravity");
  });

  test("readWinCredBlobFromStruct safely decodes CREDENTIALW pointers (Pointer and bigint) and copies memory", () => {
    const payload = JSON.stringify({
      token: { access_token: "ya29.win", refresh_token: "1//ref" },
      id_token_email: "windows@example.com",
    });
    const blob = Buffer.from(payload, "utf8");
    const credStruct = new ArrayBuffer(80);
    const view = new DataView(credStruct);
    view.setUint32(32, blob.length, true);
    view.setBigUint64(40, BigInt(ptr(blob)), true);

    const fromPtr = readWinCredBlobFromStruct(ptr(credStruct));
    const fromBigInt = readWinCredBlobFromStruct(BigInt(ptr(credStruct)));
    expect(fromPtr).toEqual({ kind: "found", value: payload });
    expect(fromBigInt).toEqual({ kind: "found", value: payload });

    // Overwrite source buffer to ensure decoded string is decoupled before CredFree
    blob.fill(0x58);
    expect(parseAntigravityToken(fromPtr.kind === "found" ? fromPtr.value : "")).toEqual({
      hasToken: true,
      email: "windows@example.com",
      explicitlySignedOut: false,
    });

    // Edge cases: null blob pointer, zero length, null struct pointer
    view.setBigUint64(40, 0n, true);
    expect(readWinCredBlobFromStruct(ptr(credStruct))).toEqual({ kind: "notFound" });
    view.setUint32(32, 0, true);
    expect(readWinCredBlobFromStruct(ptr(credStruct))).toEqual({ kind: "notFound" });
    expect(readWinCredBlobFromStruct(0n)).toEqual({ kind: "notFound" });
  });

  test("decodes go-keyring macOS base64, Windows UTF-8/UTF-16LE blobs, and PowerShell fallback outputs", () => {
    const payload = JSON.stringify({
      token: { access_token: "tok", refresh_token: "ref" },
      id_token_email: "user@example.com",
    });
    const macEncoded = `${GO_KEYRING_BASE64_PREFIX}${Buffer.from(payload, "utf8").toString("base64")}\n`;
    expect(decodeGoKeyringSecret(macEncoded)).toBe(payload);
    expect(decodeWinCredBlob(Buffer.from(payload, "utf8"))).toBe(payload);
    expect(decodeWinCredBlob(Buffer.from(`${payload}\0`, "utf16le"))).toBe(payload);

    expect(
      parseWinPowerShellReadResult({
        status: 0,
        stdout: `FOUND:${Buffer.from(payload, "utf8").toString("base64")}`,
        stderr: "",
        timedOut: false,
      }),
    ).toEqual({ kind: "found", value: payload });
    expect(
      parseWinPowerShellReadResult({
        status: 0,
        stdout: "NOT_FOUND\r\n",
        stderr: "",
        timedOut: false,
      }),
    ).toEqual({ kind: "notFound" });
    expect(
      parseWinPowerShellDeleteResult({
        status: 0,
        stdout: "DELETED\r\n",
        stderr: "",
        timedOut: false,
      }),
    ).toEqual({ kind: "deleted" });

    // PowerShell fallback uses -EncodedCommand with valid multiline here-string termination
    const psArgs = winPowerShellArgs("Read");
    expect(psArgs.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const psScript = Buffer.from(psArgs[3]!, "base64").toString("utf16le");
    expect(psScript).toContain("Add-Type -TypeDefinition @'\r\n");
    expect(psScript).toContain("\r\n'@\r\n");
    expect(psScript).toContain("[NeoWinCred]::Read($env:NEO_WINCRED_TARGET)");
  });

  test("Windows profile resolution prefers USERPROFILE and inspects keyring cleanly", async () => {
    expect(
      resolveHome({ HOME: "/c/msys", USERPROFILE: "C:\\Users\\Henry" }, "win32"),
    ).toBe("C:\\Users\\Henry");

    const payload = JSON.stringify({
      token: { access_token: "tok" },
      id_token_email: "henry@example.com",
    });
    const status = await inspectAntigravityAccountAsync({
      platform: "win32",
      env: { USERPROFILE: "C:\\Users\\NonExistentNeoTest" },
      keyring: {
        async read(service, username) {
          expect(service).toBe("gemini");
          expect(username).toBe("antigravity");
          return { kind: "found", value: payload };
        },
        async delete() {
          return { kind: "deleted" };
        },
      },
    });
    expect(status).toEqual({
      account: { email: "henry@example.com", removable: true },
    });
  });

  test("Windows native Credential Manager round-trip (runs on win32 only)", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const backend = createSystemKeyringBackend("win32");
    const service = `neo-test-${process.pid}-${Date.now()}`;
    const user = "antigravity";

    // Missing entry must return notFound cleanly (never throw TypeError)
    const missing = await backend.read(service, user);
    expect(missing.kind === "notFound" || missing.kind === "unavailable").toBe(true);
    if (missing.kind === "unavailable") {
      return;
    }

    // Write a temporary generic credential matching zalando/go-keyring and verify read + delete
    const payload = JSON.stringify({
      token: { access_token: "win-ci-tok", refresh_token: "win-ci-ref" },
      id_token_email: "win-ci@example.com",
    });
    const targetName = winCredTargetName(service, user);
    const targetBuf = Buffer.from(`${targetName}\0`, "utf16le");
    const userBuf = Buffer.from(`${user}\0`, "utf16le");
    const blobBuf = Buffer.from(payload, "utf8");
    const credStruct = new ArrayBuffer(80);
    const view = new DataView(credStruct);
    view.setUint32(0, 0, true); // Flags
    view.setUint32(4, 1, true); // Type = CRED_TYPE_GENERIC
    view.setBigUint64(8, BigInt(ptr(targetBuf)), true); // TargetName
    view.setUint32(32, blobBuf.length, true); // CredentialBlobSize
    view.setBigUint64(40, BigInt(ptr(blobBuf)), true); // CredentialBlob
    view.setUint32(48, 2, true); // Persist = CRED_PERSIST_LOCAL_MACHINE
    view.setBigUint64(72, BigInt(ptr(userBuf)), true); // UserName

    const advapi = dlopen("advapi32.dll", {
      CredWriteW: {
        args: [FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      CredDeleteW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32],
        returns: FFIType.i32,
      },
    });
    const wrote = advapi.symbols.CredWriteW(ptr(credStruct) as Pointer, 0);
    void targetBuf.byteLength;
    void userBuf.byteLength;
    void blobBuf.byteLength;
    if (wrote === 0) {
      // Headless Windows service without logon session cannot persist credentials.
      return;
    }

    try {
      expect(await backend.read(service, user)).toEqual({ kind: "found", value: payload });
      expect(backend.readSync(service, user)).toEqual({ kind: "found", value: payload });
      expect(await backend.delete(service, user)).toEqual({ kind: "deleted" });
      expect(await backend.read(service, user)).toEqual({ kind: "notFound" });
    } finally {
      advapi.symbols.CredDeleteW(ptr(targetBuf) as Pointer, 1, 0);
    }
  });
});
