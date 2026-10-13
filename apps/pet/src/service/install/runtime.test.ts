import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUNDLED_BUN_VERSION } from "../../shared/bundled-runtime.ts";
import { payloadPath, verifyRuntime } from "./runtime.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bara-payload-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("manifest verifies actual payload bytes and rejects a modified runtime", async () => {
  const required = ["runtime/bun.exe", "linux/bun-x64", "linux/bun-arm64", "server-source.tar.gz",
    "core/apps/memory/src/index.ts", "core/apps/setup/src/managed-prepare.ts",
    "core/apps/setup/src/managed-models.ts", "core/apps/setup/src/client-token.ts",
    "core/apps/setup/src/managed-restore.ts"];
  const crtDlls = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll"];
  for (const name of [...crtDlls, "CRT-NOTICE.txt"])
    for (const prefix of ["runtime", "core/node_modules/onnxruntime-node/bin/napi-v6/win32/x64"])
      required.push(`${prefix}/${name}`);
  const files: Record<string, string> = {};
  for (const path of required) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, path);
    files[path] = createHash("sha256").update(path).digest("hex");
  }
  writeFileSync(join(root, "payload-manifest.json"), JSON.stringify({ schemaVersion: 1, bunVersion: BUNDLED_BUN_VERSION,
    sourceCommit: "a".repeat(40), files,
    vcRuntime: { sourceVersion: "14.51.36231", dlls: crtDlls,
      fileVersions: Object.fromEntries(crtDlls.map((name) => [name, "14.51.36247.0"])), deployment: "app-local" } }));
  const paths = { dataDir: join(root, "data"), resourceDir: root, bunPath: join(root, "runtime", "bun.exe") };
  expect((await verifyRuntime(paths)).files).toEqual(files);
  writeFileSync(join(root, "runtime", "bun.exe"), "tampered");
  await expect(verifyRuntime(paths)).rejects.toMatchObject({ code: "PAYLOAD_INVALID" });
});

test("payload path validation blocks traversal and absolute paths", () => {
  expect(payloadPath(root, "core/apps/memory/src/index.ts")).toBe(join(root, "core", "apps", "memory", "src", "index.ts"));
  for (const name of ["../secret", "core/../secret", "/tmp/secret", "C:\\secret", "core//index.ts"])
    expect(() => payloadPath(root, name)).toThrow();
});
