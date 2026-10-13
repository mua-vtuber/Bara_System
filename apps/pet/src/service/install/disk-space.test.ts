import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { BUNDLED_BUN_VERSION } from "../../shared/bundled-runtime.ts";
import { LOCAL_INSTALL_MARGIN_BYTES, LOCAL_INSTALL_MODEL_BYTES, type RequestContext } from "../../shared/contracts.ts";
import { DpapiVault } from "../../../tests/e2e/dpapi-vault.ts";
import { messages } from "../../ui/messages.ts";
import { ConfigStore } from "../config.ts";
import { assertInstallSpace, bytesUnder, freeBytesAt, requiredFreeBytes } from "./disk-space.ts";
import { InstallManager } from "./index.ts";
import { availableManagedPort } from "./net.ts";

const GB = 1_000_000_000;

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error("expected the promise to reject"); }, (error: unknown) => error);
}

test("a first install needs the models and the working margin; files already downloaded count against the models only", () => {
  expect(requiredFreeBytes(0)).toBe(LOCAL_INSTALL_MODEL_BYTES + LOCAL_INSTALL_MARGIN_BYTES);
  expect(requiredFreeBytes(700_000_000)).toBe(LOCAL_INSTALL_MODEL_BYTES - 700_000_000 + LOCAL_INSTALL_MARGIN_BYTES);
  expect(requiredFreeBytes(5 * GB)).toBe(LOCAL_INSTALL_MARGIN_BYTES);
});

test("the free space of a folder that does not exist yet is read on its nearest existing parent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-disk-free-"));
  try {
    const free = await freeBytesAt(join(dir, "not", "yet", "memory"));
    expect(typeof free).toBe("number");
    expect(free).toBe(await freeBytesAt(dir));
    expect(existsSync(join(dir, "not"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("model bytes are the regular files under a folder, without partial downloads; a missing folder holds none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-disk-bytes-"));
  try {
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "one.bin"), "x".repeat(100));
    writeFileSync(join(dir, "a", "b", "two.bin"), "x".repeat(23));
    // A download cut off midway leaves its temporary file; the next attempt cannot reuse it.
    writeFileSync(join(dir, "a", "model_quantized.onnx.tmp.4242.k3j9"), "x".repeat(500));
    expect(await bytesUnder(dir)).toBe(123);
    expect(await bytesUnder(join(dir, "missing"))).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a low drive stops the install with the space still needed and the space free", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-disk-check-"));
  try {
    // An earlier attempt already downloaded 0.5 GB of the models into the managed folders.
    mkdirSync(join(dir, "models", "hf-cache"), { recursive: true });
    writeFileSync(join(dir, "models", "hf-cache", "part.onnx"), Buffer.alloc(1_000));
    const present = 1_000;
    const free = 1_234_567_890;
    const error = await rejection(assertInstallSpace(dir, async () => free));
    const missing = requiredFreeBytes(present) - free;
    expect(error).toMatchObject({ code: "INSTALL_DISK_LOW", publicMessage: messages.connectionErrors.INSTALL_DISK_LOW(missing, free) });
    // 1.47 GB more rounds up and 1.23 GB free rounds down, so neither reads as more room than there is.
    expect(messages.connectionErrors.INSTALL_DISK_LOW(missing, free)).toContain("1.2GB");
    expect(messages.connectionErrors.INSTALL_DISK_LOW(missing, free)).toContain("1.5GB");
    // Enough space, or a drive that cannot be read, never blocks.
    await assertInstallSpace(dir, async () => requiredFreeBytes(present));
    await assertInstallSpace(dir, async () => null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the local choice names the same download and free space the check uses", () => {
  expect(messages.settings.localRequirements).toContain("1.7GB");
  expect(messages.settings.localRequirements).toContain("3GB");
});

// The install run itself, up to the check. Nothing is spawned before it, so these run on any platform: the
// payload only has to pass `verifyRuntime`'s list and hashes.
let payload = "";
beforeAll(() => {
  payload = mkdtempSync(join(tmpdir(), "pet-disk-payload-"));
  const crtDlls = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll"];
  const names = ["runtime/bun.exe", "linux/bun-x64", "linux/bun-arm64", "server-source.tar.gz", "core/apps/memory/src/index.ts",
    "core/apps/setup/src/managed-prepare.ts", "core/apps/setup/src/managed-models.ts", "core/apps/setup/src/client-token.ts",
    "core/apps/setup/src/managed-restore.ts",
    ...[...crtDlls, "CRT-NOTICE.txt"].flatMap((name) => [`runtime/${name}`, `core/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/${name}`])];
  const files: Record<string, string> = {};
  for (const name of names) {
    mkdirSync(dirname(join(payload, name)), { recursive: true });
    writeFileSync(join(payload, name), name);
    files[name] = createHash("sha256").update(name).digest("hex");
  }
  writeFileSync(join(payload, "payload-manifest.json"), JSON.stringify({ schemaVersion: 1, bunVersion: BUNDLED_BUN_VERSION,
    sourceCommit: "a".repeat(40), files, vcRuntime: { sourceVersion: "14.51.36231", dlls: crtDlls,
      fileVersions: Object.fromEntries(crtDlls.map((name) => [name, "14.51.36247.0"])), deployment: "app-local" } }));
});
afterAll(() => { if (payload) rmSync(payload, { recursive: true, force: true }); });

const ctx = (): RequestContext => ({ signal: new AbortController().signal, progress() {} });

/** Every file under `dir` with its contents, to show a failed run left the folder exactly as it was. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) { out[`${relative(dir, path)}/`] = ""; walk(path); }
      else out[relative(dir, path)] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return out;
}

async function petFolder() {
  const dir = mkdtempSync(join(tmpdir(), "pet-disk-install-"));
  const paths = { dataDir: dir, resourceDir: payload, bunPath: join(payload, "runtime", "bun.exe") };
  return { dir, paths, config: new ConfigStore(paths, new DpapiVault()) };
}

test("a first install on a low drive writes no origin, install record or data folder", async () => {
  const { dir, paths, config } = await petFolder();
  const before = tree(dir);
  const manager = new InstallManager(config, paths, async () => {}, async () => GB, undefined, await availableManagedPort());
  try {
    expect(await rejection(manager.local(ctx()))).toMatchObject({ code: "INSTALL_DISK_LOW" });
    expect(tree(dir)).toEqual(before);
  } finally {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a fresh install refuses an existing core on the isolated probe port before checking disk or writing files", async () => {
  const { dir, paths, config } = await petFolder();
  const before = tree(dir);
  let probes = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe("/health");
    expect(request.headers.has("authorization")).toBe(false);
    probes++;
    return Response.json({ ok: true });
  } });
  let diskReads = 0;
  const manager = new InstallManager(config, paths, async () => {}, async () => { diskReads++; return GB; }, undefined, server.port!);
  try {
    expect(await rejection(manager.local(ctx()))).toMatchObject({ code: "INSTALL_EXISTING_CORE" });
    expect(probes).toBe(1);
    expect(diskReads).toBe(0);
    expect(tree(dir)).toEqual(before);
  } finally {
    await manager.close();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a resumed install on a low drive keeps its record and settings as they were", async () => {
  const { dir, paths, config } = await petFolder();
  const port = await availableManagedPort();
  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(join(dir, "memory", "managed-install.json"), JSON.stringify({ version: 1, phase: "preparing", port }));
  await config.reserveOrigin({ mode: "local", baseUrl: `http://127.0.0.1:${port + 1}` });
  const before = tree(dir);
  const manager = new InstallManager(config, paths, async () => {}, async () => GB);
  try {
    expect(await rejection(manager.local(ctx()))).toMatchObject({ code: "INSTALL_DISK_LOW" });
    expect(tree(dir)).toEqual(before);
  } finally {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("with enough space the same run goes on to write its install record", async () => {
  const { dir, paths, config } = await petFolder();
  const port = await availableManagedPort();
  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(join(dir, "memory", "managed-install.json"), JSON.stringify({ version: 1, phase: "preparing", port }));
  const manager = new InstallManager(config, paths, async () => {}, async () => 100 * GB);
  try {
    // The stand-in runtime cannot run `managed-prepare`; the run only gets that far past the check, and on
    // the way it reserves its origin in the settings file the low-drive runs never wrote.
    expect(await rejection(manager.local(ctx()))).not.toMatchObject({ code: "INSTALL_DISK_LOW" });
    expect(existsSync(join(dir, "pet-settings.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "memory", "managed-install.json"), "utf8"))).toEqual({ version: 1, phase: "preparing", port });
  } finally {
    await manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
