import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failedStepStderr, isRunning, runCaptured, stopProcess } from "./process.ts";

test("captured child output is bounded and cancellation stops a real process", async () => {
  const ctx = { signal: new AbortController().signal, progress() {} };
  const result = await runCaptured([process.execPath, "-e", "console.log('ready'); console.error('notice')"],
    ctx, { timeoutMs: 5_000 });
  expect(result.stdout.trim()).toBe("ready");
  expect(result.stderr.trim()).toBe("notice");
  const controller = new AbortController();
  const pending = runCaptured([process.execPath, "-e", "await Bun.sleep(60000)"],
    { signal: controller.signal }, { timeoutMs: 5_000 });
  controller.abort();
  await expect(pending).rejects.toThrow();
});

test("a runCaptured call must declare either a total or an idle timeout", async () => {
  const ctx = { signal: new AbortController().signal, progress() {} };
  await expect(runCaptured([process.execPath, "-e", "console.log('x')"], ctx, {} as never))
    .rejects.toThrow(/timeoutMs or idleTimeoutMs/);
});

test("steady periodic output keeps a real child alive past its idle window", async () => {
  const ctx = { signal: new AbortController().signal, progress() {} };
  const result = await runCaptured([process.execPath, "-e",
    "for (let i = 0; i < 10; i++) { process.stdout.write('.'); await Bun.sleep(100); }"],
    ctx, { idleTimeoutMs: 300 });
  expect(result.stdout).toBe(".".repeat(10));
});

test("a real child with no output at all is stopped once the idle window elapses", async () => {
  const ctx = { signal: new AbortController().signal, progress() {} };
  await expect(runCaptured([process.execPath, "-e", "await Bun.sleep(60000)"], ctx,
    { idleTimeoutMs: 300, stepName: "무출력 단계" })).rejects.toMatchObject({ code: "INSTALL_STEP_STALLED" });
});

test("a real child that keeps running past its total budget is reported as a timeout, not a command failure", async () => {
  const ctx = { signal: new AbortController().signal, progress() {} };
  await expect(runCaptured([process.execPath, "-e",
    "while (true) { process.stdout.write('.'); await Bun.sleep(100); }"],
    ctx, { timeoutMs: 300, stepName: "장기 단계" })).rejects.toMatchObject({ code: "INSTALL_STEP_TIMEOUT" });
});

test("a real child that exits non-zero on its own is reported as a command failure", async () => {
  const ctx = { signal: new AbortController().signal, progress() {} };
  await expect(runCaptured([process.execPath, "-e", "process.exit(3)"], ctx,
    { timeoutMs: 5_000, stepName: "실패 단계" })).rejects.toMatchObject({ code: "INSTALL_COMMAND_FAILED" });
});

test("a failed step's own error output is kept for its caller, except a sensitive step's", async () => {
  const ctx = { signal: new AbortController().signal, progress() {} };
  const failing = [process.execPath, "-e", "console.error('first'); console.error('last cause'); process.exit(2)"];
  const caught = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a failure"); }, (error: unknown) => error);
  const plain = await caught(runCaptured(failing, ctx, { timeoutMs: 5_000 }));
  expect(plain).toMatchObject({ code: "INSTALL_COMMAND_FAILED" });
  expect(failedStepStderr(plain)?.trim().split(/\r?\n/)).toEqual(["first", "last cause"]);
  const sensitive = await caught(runCaptured(failing, ctx, { timeoutMs: 5_000, sensitive: true }));
  expect(failedStepStderr(sensitive)).toBeUndefined();
  expect(sensitive).not.toHaveProperty("stderr");
  const timedOut = await caught(runCaptured([process.execPath, "-e", "console.error('x'); await Bun.sleep(60000)"], ctx, { timeoutMs: 200 }));
  expect(failedStepStderr(timedOut)).toBeUndefined();
});

test("a silent child that sleeps and exits 0 is still stopped by idle timeout", async () => {
  const ctx = { signal: new AbortController().signal, progress() {} };
  await expect(runCaptured([process.execPath, "-e", "await Bun.sleep(600)"], ctx,
    { idleTimeoutMs: 100, stepName: "조용한 단계" })).rejects.toMatchObject({ code: "INSTALL_STEP_STALLED" });
});

test("streamed stdout reaches onLine line by line while the captured output stays whole", async () => {
  const ctx = { signal: new AbortController().signal, progress() {} };
  // Written in pieces that split lines (and a CRLF) across chunks, with pauses so they arrive separately.
  const script = "for (const piece of ['@@bara-progress {\\\"part\\\":1,', '\\\"parts\\\":1}\\r', '\\nsecond\\nthi', 'rd\\n', 'tail']) " +
    "{ process.stdout.write(piece); await Bun.sleep(30); } console.error('not stdout');";
  const lines: string[] = [];
  const result = await runCaptured([process.execPath, "-e", script], ctx, { timeoutMs: 10_000, onLine: (line) => { lines.push(line); } });
  expect(lines).toEqual(['@@bara-progress {"part":1,"parts":1}', "second", "third"]);
  expect(result.stdout).toBe('@@bara-progress {"part":1,"parts":1}\r\nsecond\nthird\ntail');
  expect(result.stderr.trim()).toBe("not stdout");
});

test("a sensitive step never hands its output lines out", async () => {
  const ctx = { signal: new AbortController().signal, progress() {} };
  const lines: string[] = [];
  const result = await runCaptured([process.execPath, "-e", "console.log('secret-token')"], ctx,
    { timeoutMs: 10_000, sensitive: true, onLine: (line) => { lines.push(line); } });
  expect({ lines, stdout: result.stdout.trim() }).toEqual({ lines: [], stdout: "secret-token" });
});

test("lines split inside a multi-byte character or chunk boundary come out whole, and a throwing reader is ignored", async () => {
  const ctx = { signal: new AbortController().signal, progress() {} };
  // Byte by byte with pauses, so lines (and the Korean characters) are split across chunks.
  const script = "const bytes = new TextEncoder().encode('모델\\r\\nboom\\nnext\\n\\nend'); " +
    "for (const byte of bytes) { process.stdout.write(new Uint8Array([byte])); await Bun.sleep(2); }";
  const lines: string[] = [];
  const result = await runCaptured([process.execPath, "-e", script], ctx, { timeoutMs: 20_000,
    onLine: (line) => { lines.push(line); if (line === "boom") throw new Error("reader failed"); } });
  expect(lines).toEqual(["모델", "boom", "next", ""]);
  expect(result.stdout).toBe("모델\r\nboom\nnext\n\nend");
});

test("lines onLine takes are left out of the output and its bound, so a long download's progress cannot end the step", async () => {
  const ctx = { signal: new AbortController().signal, progress() {} };
  // 1.5 MB of progress lines, past the 1 MB output bound, around two ordinary lines.
  const script = "process.stdout.write('start\\n'); const line = '@@bara-progress ' + 'x'.repeat(1000) + '\\n'; " +
    "for (let i = 0; i < 1500; i++) process.stdout.write(line); process.stdout.write('end\\n');";
  let taken = 0;
  const result = await runCaptured([process.execPath, "-e", script], ctx, { timeoutMs: 20_000,
    onLine: (line) => { if (!line.startsWith("@@bara-progress ")) return false; taken++; return true; } });
  expect({ taken, stdout: result.stdout }).toEqual({ taken: 1500, stdout: "start\nend\n" });
  // Kept output is still bounded.
  await expect(runCaptured([process.execPath, "-e", "for (let i = 0; i < 1100; i++) console.log('y'.repeat(1000));"], ctx,
    { timeoutMs: 20_000, onLine: () => false })).rejects.toMatchObject({ code: "INSTALL_OUTPUT_LIMIT" });
});

// WP-PFIX-5: a Bun child ended by `child.kill()` keeps `exitCode` null and sets only `signalCode` (Bun
// 1.3.6 on Windows), so every liveness check goes through `isRunning`.
const sleeper = () => Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });

test("a real child ended by kill() is no longer running, whichever of exitCode or signalCode Bun sets", async () => {
  const child = sleeper();
  try {
    expect(isRunning(child)).toBe(true);
    child.kill();
    await child.exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(isRunning(child)).toBe(false);
  } finally { child.kill(); }
});

test("a child that exited by itself is no longer running", async () => {
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await child.exited;
  expect(isRunning(child)).toBe(false);
});

/** A real executable standing in for `System32/taskkill.exe` under `%SystemRoot%`: it appends its
 * arguments to a log next to itself, so a test sees exactly which PIDs `stopProcess` asked Windows to
 * terminate. */
const RECORDER = `
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
appendFileSync(join(dirname(process.execPath), "calls.log"), process.argv.slice(2).join(" ") + "\\n");
`;

/** Run `stopProcess(child)` with `SystemRoot` pointing at `root`, then restore it. The call is
 * synchronous, so no other test code runs while the variable is changed. */
function stopWithSystemRoot(root: string, child: Bun.Subprocess): void {
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = root;
  try { stopProcess(child); } finally { process.env.SystemRoot = saved; }
}

test.skipIf(process.platform !== "win32")("stopProcess does not run taskkill on the PID of a child that kill() already ended", async () => {
  const root = mkdtempSync(join(tmpdir(), "pet-taskkill-"));
  const live = sleeper();
  const dead = sleeper();
  try {
    mkdirSync(join(root, "System32"));
    writeFileSync(join(root, "recorder.ts"), RECORDER);
    const compiled = Bun.spawnSync([process.execPath, "build", "--compile", join(root, "recorder.ts"), "--outfile", join(root, "System32", "taskkill.exe")],
      { stdout: "pipe", stderr: "pipe" });
    expect({ exitCode: compiled.exitCode, stderr: compiled.stderr.toString().trim() }).toEqual({ exitCode: 0, stderr: "" });
    const calls = () => existsSync(join(root, "System32", "calls.log"))
      ? readFileSync(join(root, "System32", "calls.log"), "utf8").split("\n").map((line) => line.trim()).filter(Boolean) : [];

    dead.kill();
    await dead.exited;
    stopWithSystemRoot(root, dead);
    expect(calls()).toEqual([]);

    // The recorder is the taskkill the service would run: a running child does reach it, by PID.
    stopWithSystemRoot(root, live);
    expect(calls()).toEqual([`/PID ${live.pid} /T /F`]);
  } finally {
    live.kill(); dead.kill();
    await Promise.all([live.exited, dead.exited]);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
