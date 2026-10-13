/** Isolated SSH E2E fixture loader. Rejects any non-loopback or non-/tmp target. */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { SshConnection } from "../../src/shared/contracts.ts";
import { validateSsh } from "../../src/service/validation.ts";
import { safeRemotePath } from "../../src/service/install/ssh.ts";

export interface SshFixture { ssh: SshConnection; fingerprint: string }
const FIELDS = ["host", "port", "user", "keyPath", "fingerprint", "serverPath", "serverPort"];

export function loadSshFixture(args: string[] = [], projectRoot = resolve(import.meta.dir, "../..")): SshFixture {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: false,
    options: { fixture: { type: "string" } } });
  if (positionals.length) throw new Error("Unexpected SSH fixture argument");
  const supplied = values.fixture;
  const source = supplied?.trim().startsWith("{")
    ? supplied
    : readFileSync(supplied ? resolve(projectRoot, supplied) : join(projectRoot, ".omx", "ssh-e2e", "fixture.json"), "utf8");
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { throw new Error("Invalid SSH fixture JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid SSH fixture object");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== [...FIELDS].sort().join(",")) throw new Error("Unexpected SSH fixture fields");
  if (value.host !== "127.0.0.1") throw new Error("SSH E2E fixture must use 127.0.0.1");
  if (typeof value.serverPath !== "string" ||
      !/^\/tmp\/bara-pet-[A-Za-z0-9_-]+\/install$/.test(value.serverPath) ||
      safeRemotePath(value.serverPath) !== value.serverPath)
    throw new Error("SSH E2E serverPath must be an app-owned /tmp/bara-pet-* fixture");
  if (typeof value.keyPath !== "string" || !value.keyPath.trim()) throw new Error("SSH E2E keyPath is required");
  const keyPath = isAbsolute(value.keyPath) ? resolve(value.keyPath) : resolve(projectRoot, value.keyPath);
  if (!existsSync(keyPath)) throw new Error("SSH E2E key file does not exist");
  if (typeof value.fingerprint !== "string") throw new Error("SSH E2E fingerprint is required");
  const ssh = validateSsh({ host: value.host, port: value.port, user: value.user, keyPath,
    fingerprint: value.fingerprint, serverPath: value.serverPath, serverPort: value.serverPort } as SshConnection);
  return { ssh, fingerprint: value.fingerprint };
}
