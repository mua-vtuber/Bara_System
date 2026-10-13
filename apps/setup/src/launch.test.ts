import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupComplete, openDashboardAndWait } from "./launch.ts";

test("failed browser subprocess leaves the healthy server running until interrupted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bara-browser-failure-"));
  const ready = join(dir, "ready.json");
  const attempted = join(dir, "attempted");
  const serverScript = join(dir, "server.ts");
  writeFileSync(serverScript, `const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("healthy")}); await Bun.write(${JSON.stringify(ready)}, JSON.stringify({port:server.port}));`);
  const browserScript = join(dir, "browser.ts");
  writeFileSync(browserScript, `await Bun.write(${JSON.stringify(attempted)}, "failed"); process.exit(7);`);
  const server = Bun.spawn([process.execPath, serverScript], { stdout: "ignore", stderr: "ignore" });
  let serving: Promise<void> | undefined;
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    const { port } = JSON.parse(readFileSync(ready, "utf8"));
    serving = openDashboardAndWait(server, `http://127.0.0.1:${port}/#bara-token=private-fixture`, [process.execPath, browserScript])
      .then(() => {}).catch(() => {}).finally(() => { server.kill(); });
    while (!existsSync(attempted) && Date.now() < deadline) await Bun.sleep(10);
    await Bun.sleep(60);
    expect(existsSync(attempted)).toBe(true);
    expect(server.killed).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("healthy");
  } finally {
    server.kill();
    await server.exited;
    await serving;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser failure guidance never forwards token-bearing subprocess errors", () => {
  const token = "private-browser-fixture-token";
  const code = `import { openDashboardAndWait } from ${JSON.stringify(join(import.meta.dir, "launch.ts"))};
const server = Bun.spawn([process.execPath,"-e","setTimeout(() => process.exit(0), 150)"],{stdout:"ignore",stderr:"ignore"});
await openDashboardAndWait(server, "http://127.0.0.1/#bara-token=${token}", [process.execPath,"-e",${JSON.stringify(`console.error('${token}'); process.exit(7)`)}]);`;
  const child = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(child.stderr.toString()).toContain("서버는 계속 실행 중");
  expect(child.stderr.toString()).toContain("--link");
  expect(child.stderr.toString()).not.toContain(token);
  expect(child.stdout.toString()).not.toContain(token);
});

test("settings or an old premature marker alone cannot bypass setup retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "bara-setup-completion-"));
  const paths = { settingsPath: join(dir, "settings.json"), setupStatePath: join(dir, "setup-state.json") };
  try {
    expect(setupComplete(paths)).toBe(false);
    writeFileSync(paths.settingsPath, "{}");
    for (const state of [{ completedAt: new Date().toISOString() }, { status: "failed", completedAt: null }, { status: "preparing", completedAt: null }]) {
      writeFileSync(paths.setupStatePath, JSON.stringify(state));
      expect(setupComplete(paths)).toBe(false);
    }
    writeFileSync(paths.setupStatePath, JSON.stringify({ status: "complete", completedAt: new Date().toISOString() }));
    expect(setupComplete(paths)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
