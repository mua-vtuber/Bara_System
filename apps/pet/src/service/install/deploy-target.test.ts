import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { petDataDir, readDeployConnection } from "./deploy-target.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function dataDir(settings?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "bara-deploy-target-"));
  dirs.push(dir);
  if (settings !== undefined) writeFileSync(join(dir, "pet-settings.json"), JSON.stringify(settings));
  return dir;
}
const FINGERPRINT = `SHA256:${"A".repeat(43)}`;
const remote = (ssh: Record<string, unknown>) => ({ version: 1, connection: { mode: "remote", baseUrl: "http://127.0.0.1:41000",
  ssh: { host: "a1.example", port: 22, user: "bara", keyPath: join(tmpdir(), "oci_a1"), ...ssh } } });
const code = async (promise: Promise<unknown>) => (await promise.catch((error) => error) as { code?: string }).code;

test("the Pet's data folder is BARA_PET_DATA_DIR, else Bara/Pet under LOCALAPPDATA, else a named error", () => {
  expect(petDataDir({ BARA_PET_DATA_DIR: "/x/pet", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" })).toBe("/x/pet");
  expect(petDataDir({ LOCALAPPDATA: join(tmpdir(), "local") })).toBe(join(tmpdir(), "local", "Bara", "Pet"));
  let failure: { code?: string; message?: string } = {};
  try { petDataDir({}); } catch (error) { failure = error as typeof failure; }
  expect(failure.code).toBe("DEPLOY_PET_DATA_DIR_MISSING");
  expect(failure.message).toContain("LOCALAPPDATA");
});

test("a remote connection with its fingerprint, server path and port is the deploy target", async () => {
  const dir = dataDir(remote({ fingerprint: FINGERPRINT, serverPath: "/home/bara/.local/share/bara-pet-server", serverPort: 3001 }));
  expect(await readDeployConnection(dir)).toMatchObject({ host: "a1.example", user: "bara", fingerprint: FINGERPRINT, serverPort: 3001 });
});

test("no settings, a local connection or a save in progress is refused", async () => {
  expect(await code(readDeployConnection(dataDir()))).toBe("DEPLOY_NOT_REMOTE");
  expect(await code(readDeployConnection(dataDir({ version: 1, connection: { mode: "local", baseUrl: "http://127.0.0.1:3001" } })))).toBe("DEPLOY_NOT_REMOTE");
  const busy = dataDir(remote({ fingerprint: FINGERPRINT, serverPath: "/srv/bara", serverPort: 3001 }));
  writeFileSync(join(busy, "pet-settings.pending"), "{}");
  expect(await code(readDeployConnection(busy))).toBe("DEPLOY_SETTINGS_BUSY");
});

test("a Pet attached to an existing server is refused and the message names that mode", async () => {
  const dir = dataDir({ version: 1, connection: { mode: "existing", baseUrl: "http://127.0.0.1:41000" } });
  const failure = await readDeployConnection(dir).catch((error) => error) as { code?: string; message?: string };
  expect(failure.code).toBe("DEPLOY_NOT_REMOTE");
  expect(failure.message).toContain("existing");
});

test("a remote connection missing a field names that field", async () => {
  for (const [missing, ssh] of [["fingerprint", { serverPath: "/srv/bara", serverPort: 3001 }],
    ["serverPath", { fingerprint: FINGERPRINT, serverPort: 3001 }], ["serverPort", { fingerprint: FINGERPRINT, serverPath: "/srv/bara" }]] as const) {
    const failure = await readDeployConnection(dataDir(remote(ssh))).catch((error) => error) as { code?: string; message?: string };
    expect({ missing, code: failure.code, named: failure.message?.includes(missing) }).toEqual({ missing, code: "DEPLOY_CONNECTION_INCOMPLETE", named: true });
  }
});

test("a settings file that cannot be read stops with CONFIG_INVALID naming the file and the cause", async () => {
  const broken = dataDir();
  const file = join(broken, "pet-settings.json");
  writeFileSync(file, "{ not json");
  const failure = await readDeployConnection(broken).catch((error) => error) as { code?: string; message?: string };
  expect(failure.code).toBe("CONFIG_INVALID");
  expect(failure.message).toContain(file);
  expect(failure.message).toMatch(/\(.+\)/);

  const folder = dataDir();
  mkdirSync(join(folder, "pet-settings.json"));
  const notFile = await readDeployConnection(folder).catch((error) => error) as { code?: string; message?: string };
  expect(notFile.code).toBe("CONFIG_INVALID");
  expect(notFile.message).toContain(join(folder, "pet-settings.json"));
  expect(notFile.message).toContain("EISDIR");
});
