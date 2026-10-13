import { expect, test } from "bun:test";
import { join } from "node:path";

const windowsOnly = test.skipIf(process.platform !== "win32");
const modulePath = (name: string) => JSON.stringify(join(import.meta.dir, name).replaceAll("\\", "/"));

// Runs in a throwaway Bun process that changes its own SystemRoot after it has started: a child
// cannot be launched without one (libuv adds it back, and a relative value stops Bun from starting),
// and the shared test runner's environment must not be modified.
const SCENARIO = `
import { listeningOwners } from ${modulePath("port-owner.ts")};
import { stopProcess, windowsSystemRoot } from ${modulePath("process.ts")};
import { findSshTools } from ${modulePath("ssh.ts")};
const code = (action) => { try { action(); return "none"; } catch (error) { return error.code ?? String(error); } };
const sleeper = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
const results = {};
for (const value of ["missing", "Windows"]) {
  if (value === "missing") delete process.env.SystemRoot; else process.env.SystemRoot = value;
  results[value] = {
    root: code(() => windowsSystemRoot()),
    ssh: code(() => findSshTools()),
    lookup: await listeningOwners(41000, new AbortController().signal).then(() => "none", (error) => error.code ?? String(error)),
  };
}
delete process.env.SystemRoot;
stopProcess(sleeper);
const cleanup = await Promise.race([sleeper.exited.then(() => "stopped"), Bun.sleep(10000).then(() => "still running")]);
if (cleanup !== "stopped") sleeper.kill();
console.log(JSON.stringify({ ...results, cleanup }));
`;

windowsOnly("a missing or relative SystemRoot is reported, never guessed, and cleanup still stops the child", async () => {
  const child = Bun.spawn([process.execPath, "-e", SCENARIO], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exitCode, stderr: stderr.trim() }).toEqual({ exitCode: 0, stderr: "" });
  const missing = { root: "WINDOWS_SYSTEM_ROOT_MISSING", ssh: "WINDOWS_SYSTEM_ROOT_MISSING", lookup: "WINDOWS_SYSTEM_ROOT_MISSING" };
  expect(JSON.parse(stdout)).toEqual({ missing, Windows: missing, cleanup: "stopped" });
}, 30_000);
