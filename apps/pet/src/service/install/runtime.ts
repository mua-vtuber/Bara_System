import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RuntimePaths } from "../../shared/contracts.ts";
import { BUNDLED_BUN_VERSION } from "../../shared/bundled-runtime.ts";
import { messages } from "../../ui/messages.ts";
import { serviceError } from "../errors.ts";

export interface PayloadManifest {
  schemaVersion: 1;
  bunVersion: string;
  sourceCommit: string;
  vcRuntime: { sourceVersion: string; dlls: string[]; fileVersions: Record<string, string>; deployment: "app-local" };
  files: Record<string, string>;
}

export function payloadPath(root: string, name: string): string {
  if (typeof name !== "string" || name.includes("\\") || name.includes("\0") ||
      isAbsolute(name) || name.startsWith("/") ||
      name.split("/").some((part) => part === ".." || part === "." || part === ""))
    throw serviceError("PAYLOAD_INVALID", messages.installService.payloadListInvalid);
  const path = resolve(root, name);
  const suffix = relative(resolve(root), path);
  if (suffix.startsWith("..") || isAbsolute(suffix)) throw serviceError("PAYLOAD_INVALID", messages.installService.payloadPathOutside);
  return path;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyRuntime(paths: RuntimePaths): Promise<PayloadManifest> {
  const resourceDir = resolve(paths.resourceDir);
  if (resolve(paths.bunPath) !== join(resourceDir, "runtime", "bun.exe"))
    throw serviceError("PAYLOAD_INVALID", messages.installService.payloadBunPathInvalid);
  let value: unknown;
  try { value = JSON.parse(await readFile(join(resourceDir, "payload-manifest.json"), "utf8")); }
  catch { throw serviceError("PAYLOAD_MISSING", messages.installService.payloadListMissing); }
  if (!value || typeof value !== "object") throw serviceError("PAYLOAD_INVALID", messages.installService.payloadListInvalid);
  const manifest = value as PayloadManifest;
  if (manifest.schemaVersion !== 1 || manifest.bunVersion !== BUNDLED_BUN_VERSION ||
      !/^[0-9a-f]{40}$/.test(manifest.sourceCommit) ||
      !manifest.files || typeof manifest.files !== "object")
    throw serviceError("PAYLOAD_INVALID", messages.installService.payloadListInvalid);
  const crt = manifest.vcRuntime;
  const essentials = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll"];
  const onnxDir = "core/node_modules/onnxruntime-node/bin/napi-v6/win32/x64";
  if (!crt || crt.deployment !== "app-local" || !/^\d+\.\d+\.\d+$/.test(crt.sourceVersion) ||
      !Array.isArray(crt.dlls) || essentials.some((name) => !crt.dlls.includes(name)) ||
      crt.dlls.some((name) => typeof name !== "string" || !/^[a-z0-9_]+\.dll$/i.test(name)) ||
      !crt.fileVersions || typeof crt.fileVersions !== "object")
    throw serviceError("PAYLOAD_INVALID", messages.installService.payloadCrtListInvalid);
  for (const required of ["runtime/bun.exe", "linux/bun-x64", "linux/bun-arm64",
    "server-source.tar.gz", "core/apps/memory/src/index.ts",
    "core/apps/setup/src/managed-prepare.ts", "core/apps/setup/src/managed-models.ts",
    "core/apps/setup/src/client-token.ts", "core/apps/setup/src/managed-restore.ts"]) {
    if (!manifest.files[required]) throw serviceError("PAYLOAD_INVALID", messages.installService.payloadFileMissing);
  }
  for (const name of [...crt.dlls, "CRT-NOTICE.txt"]) {
    for (const prefix of ["runtime", onnxDir]) {
      if (!manifest.files[`${prefix}/${name}`]) throw serviceError("PAYLOAD_INVALID", messages.installService.payloadCrtFileMissing);
    }
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = payloadPath(resourceDir, name);
    if (!/^[0-9a-f]{64}$/.test(expected) || !existsSync(file) || await hashFile(file) !== expected)
      throw serviceError("PAYLOAD_INVALID", messages.installService.payloadIntegrityFailed);
  }
  return manifest;
}
