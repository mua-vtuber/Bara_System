import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceError } from "../src/service/errors.ts";
import type { ReplaceResult } from "../src/service/install/release-swap.ts";
import { PET_SERVICE_UNIT } from "../src/service/install/remote-probe.ts";
import { messages } from "../src/ui/messages.ts";
import { adapterDashboardLines, deploy, describeFailure, interruptDecision, interruptGuard, parseDeployArgs, resultLines } from "./deploy-a1.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(prefix: string): string { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; }
const ctx = { signal: new AbortController().signal, progress: () => {} };
const code = async (promise: Promise<unknown>) => (await promise.catch((error) => error) as { code?: string }).code;

test("adapter options are read, and the combinations the spec does not allow are refused", () => {
  expect(parseDeployArgs([])).toEqual({ adapter: null, settings: null, remove: false });
  expect(parseDeployArgs(["--adapter", "discord", "--settings", "s.json"])).toMatchObject({ adapter: "discord", remove: false });
  expect(parseDeployArgs(["--adapter", "discord", "--remove"])).toEqual({ adapter: "discord", settings: null, remove: true });
  for (const bad of [["--bogus"], ["--settings", "s.json"], ["--remove"], ["--adapter", "discord", "--remove", "--settings", "s.json"]])
    expect(() => parseDeployArgs(bad)).toThrow();
});

test("a Pet whose connection is not remote is refused before anything is built or sent", async () => {
  const pet = temp("bara-deploy-pet-");
  writeFileSync(join(pet, "pet-settings.json"), JSON.stringify({ version: 1, connection: { mode: "local", baseUrl: "http://127.0.0.1:3001" } }));
  expect(await code(deploy(parseDeployArgs([]), ctx, () => {}, { env: { BARA_PET_DATA_DIR: pet }, repoRoot: temp("bara-deploy-repo-"), cacheDir: temp("bara-deploy-cache-") })))
    .toBe("DEPLOY_NOT_REMOTE");
});

test("uncommitted changes in the bundled files are refused before anything is sent", async () => {
  const pet = temp("bara-deploy-pet-");
  writeFileSync(join(pet, "pet-settings.json"), JSON.stringify({ version: 1, connection: { mode: "remote", baseUrl: "http://127.0.0.1:41000",
    ssh: { host: "a1.example", port: 22, user: "bara", keyPath: join(tmpdir(), "oci_a1"), fingerprint: `SHA256:${"A".repeat(43)}`,
      serverPath: "/home/bara/.local/share/bara-pet-server", serverPort: 3001 } } }));
  const repo = temp("bara-deploy-repo-");
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  git("init", "-q"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
  mkdirSync(join(repo, "apps", "memory"), { recursive: true });
  writeFileSync(join(repo, "apps", "memory", "package.json"), "{}");
  git("add", "."); git("commit", "-qm", "init");
  writeFileSync(join(repo, "apps", "memory", "package.json"), "{\"dirty\":true}");
  expect(await code(deploy(parseDeployArgs([]), ctx, () => {}, { env: { BARA_PET_DATA_DIR: pet }, repoRoot: repo, cacheDir: temp("bara-deploy-cache-") })))
    .toBe("DEPLOY_DIRTY_TREE");
});

const replaced = (extra: Partial<Extract<ReplaceResult, { kind: "replaced" }>> = {}): ReplaceResult =>
  ({ kind: "replaced", release: "/srv/bara/releases/abc", previous: null, reused: false, cancelledAfterCheck: false, leftoverLock: null, ...extra });

test("a plain finished replace prints one line with the new version folder", () => {
  const lines = resultLines("server", "1.2.3", replaced());
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("/srv/bara/releases/abc");
});

test("a leftover lock is printed with its path, for a replaced and an unchanged result", () => {
  const lock = "/srv/bara/.update-lock";
  expect(resultLines("server", "1.2.3", replaced({ leftoverLock: lock })).join("\n")).toContain(lock);
  expect(resultLines("server", "1.2.3", { kind: "unchanged", release: "/srv/bara/releases/abc", leftoverLock: lock }).join("\n")).toContain(lock);
});

test("a cancel that arrived after the check is reported as a completed update", () => {
  const plain = resultLines("server", "1.2.3", replaced());
  const lines = resultLines("server", "1.2.3", replaced({ cancelledAfterCheck: true }));
  expect(lines.length).toBe(plain.length + 1);
  expect(lines.join("\n")).toContain("취소");
});

test("an adapter change tells the user to restart the pet server unit for the dashboard", () => {
  const lines = adapterDashboardLines({ BARA_ADAPTERS_DIR: "/srv/bara/adapters" });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(`sudo systemctl restart ${PET_SERVICE_UNIT}`);
});

test("a server whose unit lacks the adapters variable is told to update first", () => {
  const lines = adapterDashboardLines({});
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("BARA_ADAPTERS_DIR");
  expect(lines[1]).toContain("deploy:a1");
});

test("a stopped-state error prints its whole message unchanged", () => {
  const full = "새 버전이 시작하지 못했어요. 되돌릴 직전 버전 폴더는 /srv/bara/releases/old 예요. 사본은 /srv/bara/data/backups/pre-migration 에 있어요.";
  expect(describeFailure(new ServiceError("RELEASE_SCHEMA_CHANGED", full))).toBe(full);
  expect(describeFailure(new Error("boom"))).toContain("boom");
});

test("Ctrl+C before the switch cancels once; after the switch began it only says the switch is finishing", () => {
  expect(interruptDecision("preparing", false)).toEqual({ abort: true, line: messages.deployCli.cancelling });
  expect(interruptDecision("preparing", true)).toEqual({ abort: false, line: messages.deployCli.cancelling });
  expect(interruptDecision("switching", false)).toEqual({ abort: false, line: messages.deployCli.finishingSwitch });
  expect(interruptDecision("switching", true)).toEqual({ abort: false, line: messages.deployCli.finishingSwitch });
});

test("the interrupt guard aborts with a named cancel before the service stage and never after it", () => {
  const lines: string[] = [];
  const early = new AbortController();
  const before = interruptGuard(early, (line) => lines.push(line));
  before.progress("transfer");
  before.interrupt();
  before.interrupt();
  expect(early.signal.aborted).toBe(true);
  expect(describeFailure(early.signal.reason)).toBe(messages.deployCli.DEPLOY_CANCELLED);
  expect(before.interrupted).toBe(true);
  expect(lines).toEqual([messages.deployCli.cancelling, messages.deployCli.cancelling]);

  const late = new AbortController();
  const after = interruptGuard(late, (line) => lines.push(line));
  expect(after.interrupted).toBe(false);
  after.progress("models");
  after.progress("service");
  after.interrupt();
  after.interrupt();
  expect(late.signal.aborted).toBe(false);
  expect(after.interrupted).toBe(true);
  expect(lines.slice(2)).toEqual([messages.deployCli.finishingSwitch, messages.deployCli.finishingSwitch]);
});
