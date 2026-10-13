import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, assertClosureWithinRoots, buildComponentBundle, dirtyPaths, importClosure, isAdapterSource, isRuntimeSource, tarExecutable } from "./release-bundle.ts";

const scratch: string[] = [];
afterAll(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }); });
async function temp(prefix: string): Promise<string> { const dir = await mkdtemp(join(tmpdir(), prefix)); scratch.push(dir); return dir; }

test("an adapter bundle takes its runtime sources and the root lock, never tests or data", () => {
  const dir = "apps/bot-discord";
  for (const path of ["package.json", "bun.lock", "LICENSE", `${dir}/package.json`, `${dir}/src/index.ts`, `${dir}/src/actions/x.ts`])
    expect({ path, kept: isAdapterSource(dir, path) }).toEqual({ path, kept: true });
  for (const path of [`${dir}/src/index.test.ts`, `${dir}/data/bot-settings.json`, `${dir}/src/_tmp-schedule-reminders/a.ts`,
    `${dir}/README.md`, "apps/memory/src/server.ts", `${dir}/node_modules/x/index.ts`])
    expect({ path, kept: isAdapterSource(dir, path) }).toEqual({ path, kept: false });
});

test("the import closure follows relative imports and re-exports and names the packages", async () => {
  const root = await temp("bara-closure-");
  await mkdir(join(root, "a", "src"), { recursive: true }); await mkdir(join(root, "shared"), { recursive: true });
  await writeFile(join(root, "a", "src", "index.ts"), `import { b } from "./b.ts";\nimport type { T } from "../../shared/types.ts";\nconsole.log(b);\n`);
  await writeFile(join(root, "a", "src", "b.ts"), `export { c as b } from "../../shared/c.js";\n`);
  await writeFile(join(root, "shared", "c.ts"), `import { z } from "zod";\nimport { readFileSync } from "node:fs";\nexport const c = [z, readFileSync];\n`);
  await writeFile(join(root, "shared", "types.ts"), `export type T = number;\n`);
  expect(await importClosure(root, "a/src/index.ts")).toEqual({ files: ["a/src/b.ts", "a/src/index.ts", "shared/c.ts"], packages: ["node:fs", "zod"] });
  await writeFile(join(root, "a", "src", "b.ts"), `export { c as b } from "./missing.ts";\n`);
  await expect(importClosure(root, "a/src/index.ts")).rejects.toThrow("./missing.ts");
});

test("changes to tracked bundle files are reported, untracked ones are not", async () => {
  const repo = await temp("bara-dirty-");
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  git("init", "-q"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
  await mkdir(join(repo, "apps", "memory"), { recursive: true });
  await writeFile(join(repo, "apps", "memory", "package.json"), "{}");
  git("add", "."); git("commit", "-qm", "init");
  expect(dirtyPaths(repo, ["apps/memory"])).toEqual([]);
  await writeFile(join(repo, "apps", "memory", "new.ts"), "untracked");
  expect(dirtyPaths(repo, ["apps/memory"])).toEqual([]);
  await writeFile(join(repo, "apps", "memory", "package.json"), "{\"changed\":true}");
  expect(dirtyPaths(repo, ["apps/memory"])).toEqual(["M apps/memory/package.json"]);
});

test("the discord adapter bundle carries the bot and only the memory files it imports", async () => {
  const out = await temp("bara-adapter-bundle-");
  const bundle = await buildComponentBundle(REPO_ROOT, out, { kind: "adapter", name: "discord" });
  expect(bundle).toMatchObject({ appVersion: "0.1.0", workDir: "apps/bot-discord", startFile: "src/index.ts" });
  expect(bundle.sourceSha).toMatch(/^[0-9a-f]{64}$/);
  const listing = Bun.spawnSync([tarExecutable(), "-tzf", bundle.archive], { stdout: "pipe" }).stdout.toString().split(/\r?\n/).map((line) => line.replace(/^\.\//, ""));
  expect(listing).toContain("apps/bot-discord/src/index.ts");
  expect(listing).toContain("app.manifest.json");
  expect(listing).toContain("apps/memory/src/api-client.ts");
  expect(listing).toContain("apps/memory/src/memory/image-mime.ts");
  expect(listing).not.toContain("apps/memory/src/memory/ingest-image.ts");
  expect(listing.filter((path) => path.startsWith("apps/memory/") && !path.startsWith("apps/memory/src/"))).toEqual([]);
  expect(listing).not.toContain("apps/memory/package.json");
  expect(listing.some((path) => path.includes(".test."))).toBe(false);
}, 120_000);

test("an import chain that leaves the allowed roots is reported as outside them, not as uncommitted", () => {
  const roots = ["apps/bot-discord/", "apps/memory/src/"];
  expect(() => assertClosureWithinRoots("discord", ["apps/bot-discord/src/index.ts", "apps/memory/src/api-client.ts"], roots)).not.toThrow();
  expect(() => assertClosureWithinRoots("discord", ["apps/bot-discord/src/index.ts", "apps/setup/src/x.ts"], roots))
    .toThrow("outside the allowed bundle roots");
});

test("the server bundle carries the round-restore CLI", () => {
  expect(isRuntimeSource("apps/memory/scripts/restore-backup.ts")).toBe(true);
});
