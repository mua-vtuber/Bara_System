import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_DEFAULT_PORT, REQUIRED_CAPABILITIES } from "../shared/contracts.ts";
import { messages } from "../ui/messages.ts";

/**
 * WP-PFIX-1 deferred minor (P1-12, tested here per WP-P2-14): main.ts's frame handler turns ANY in-flight
 * failure into a generic CANCELLED once the caller has sent operation.cancel, discarding the
 * real error. That conversion lives only in main.ts's stdin/stdout process loop -- it is not a
 * pure function operation-limits.test.ts (or anything else) can call directly -- so this test
 * spawns the real compiled entry point as a child process, drives it over stdin/stdout exactly
 * as the Tauri host does, and answers NativeVault's host-reply protocol from the harness.
 *
 * If that conversion (the `controller.signal.aborted ? { code: "CANCELLED", ... } : publicError(error)`
 * branch in main.ts) were removed, memory.search would instead report whatever
 * the aborted fetch actually threw (e.g. an AbortError-derived INTERNAL/other code, not
 * "CANCELLED"), and this test would fail on the `code`/`message` assertions below.
 */

/** Minimal driver for the real `src/service/main.ts` child process: forwards JSON-RPC frames
 * over stdin/stdout and answers NativeVault host requests from an in-memory map, the same
 * contract the Tauri host implements for the real vault. */
function startService(dataDir: string, backupDir = join(dataDir, "backups")) {
  const child = Bun.spawn([process.execPath, "run", "src/service/main.ts"], {
    cwd: process.cwd(),
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
    env: { ...process.env, BARA_PET_DATA_DIR: dataDir, BARA_PET_RESOURCES: dataDir, BARA_PET_BACKUP_DIR: backupDir },
  });
  const vaultStore = new Map<string, string>();
  const waiters = new Map<string, (frame: any) => void>();

  function send(frame: unknown): void { child.stdin.write(`${JSON.stringify(frame)}\n`); }

  function handleLine(line: string): void {
    if (!line) return;
    const frame = JSON.parse(line);
    if (frame.host) {
      const { id, method, params } = frame.host;
      if (method === "vault.get") send({ hostReply: { id, result: vaultStore.get(params.key) ?? null } });
      else if (method === "vault.set") { vaultStore.set(params.key, params.value); send({ hostReply: { id, result: null } }); }
      else if (method === "vault.delete") { vaultStore.delete(params.key); send({ hostReply: { id, result: null } }); }
      return;
    }
    if (frame.event) return;
    const waiter = frame.id && waiters.get(frame.id);
    if (waiter) { waiters.delete(frame.id); waiter(frame); }
  }
  (async () => {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += Buffer.from(value).toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) { handleLine(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    }
  })();

  function call(id: string, method: string, params: Record<string, unknown>): Promise<{ id: string; result?: unknown; error?: { code: string; message: string } }> {
    return new Promise((resolve) => { waiters.set(id, resolve); send({ id, method, params }); });
  }
  return { call, stop: async () => { child.kill(); await child.exited; } };
}

test("a user cancellation of an in-flight request is reported as CANCELLED by main.ts, not the underlying error", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pet-main-cancel-test-"));
  let releaseSearch: (() => void) | null = null;
  const slowServer = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/search") return new Response("", { status: 404 });
      // Never resolves on its own -- the test controls exactly when (if ever) it completes,
      // guaranteeing the cancel below lands while memory.search is still in flight.
      await new Promise<void>((resolve) => { releaseSearch = resolve; });
      return Response.json({ results: [] });
    },
  });
  const service = startService(dataDir);
  try {
    const saved = await service.call("configure", "settings.save", {
      connection: { mode: "existing", baseUrl: `http://127.0.0.1:${slowServer.port}` },
      token: "pet-main-cancel-test-token",
    });
    expect(saved.error).toBeUndefined();

    const inFlight = service.call("search-1", "memory.search", { query: "취소 테스트" });
    // Give main.ts time to register the operation before we cancel it -- the request must
    // still be in the operations map (and the fetch still pending) when cancel arrives.
    await Bun.sleep(200);
    const cancelled = await service.call("cancel-1", "operation.cancel", { requestId: "search-1" });
    expect(cancelled.result).toEqual({ cancelled: true });

    const outcome = await inFlight;
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toEqual({ code: "CANCELLED", message: messages.rpc.cancelled });
  } finally {
    if (releaseSearch) (releaseSearch as () => void)();
    slowServer.stop(true);
    await service.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 15_000);

/** The host's graceful quit (`service.drain`, sent only by the native host): new work is refused at once, work
 * already running may finish within the limit, and what is still running after it is cancelled. Both cases use a
 * search the test server holds until the test releases it. */
async function withHeldSearch(run: (service: ReturnType<typeof startService>, release: () => void) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pet-main-drain-test-"));
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/search") return new Response("", { status: 404 });
    await held;
    return Response.json({ results: [] });
  } });
  const service = startService(dataDir);
  try {
    const saved = await service.call("configure", "settings.save", {
      connection: { mode: "existing", baseUrl: `http://127.0.0.1:${server.port}` }, token: "pet-main-drain-test-token",
    });
    expect(saved.error).toBeUndefined();
    await run(service, release);
  } finally {
    release();
    server.stop(true);
    await service.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("a drain refuses new work and waits for running work that finishes in time", async () => {
  await withHeldSearch(async (service, release) => {
    const inFlight = service.call("search-1", "memory.search", { query: "종료 대기" });
    await Bun.sleep(200);
    const drained = service.call("drain-1", "service.drain", { timeoutMs: 10_000 });
    await Bun.sleep(100);
    const refused = await service.call("save-late", "settings.get", {});
    expect(refused.error).toEqual({ code: "SHUTTING_DOWN", message: messages.rpc.shuttingDown });
    release();
    const outcome = await inFlight;
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toBeDefined();
    expect((await drained).result).toEqual({ finished: true, cancelled: 0 });
  });
}, 20_000);

test("a drain cancels work still running at its limit, and that work is answered as cancelled", async () => {
  await withHeldSearch(async (service) => {
    const inFlight = service.call("search-1", "memory.search", { query: "종료 취소" });
    await Bun.sleep(200);
    const started = performance.now();
    const drained = await service.call("drain-1", "service.drain", { timeoutMs: 300 });
    expect(drained.result).toEqual({ finished: false, cancelled: 1 });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect((await inFlight).error).toEqual({ code: "CANCELLED", message: messages.rpc.cancelled });
  });
}, 20_000);

test("a webview cannot send the host's drain", async () => {
  const { parseFrame } = await import("./protocol.ts");
  expect(() => parseFrame(JSON.stringify({ id: "x", method: "service.drain", params: {} }), false)).toThrow("unknown method");
  expect(parseFrame(JSON.stringify({ id: "x", method: "service.drain", params: {} }), true)).toMatchObject({ method: "service.drain" });
});

// Controlled offline command fixtures let the real service drain at each destructive workflow boundary.
// Every path and child process belongs to this test; no memory server or native window is started.
for (const [step, detached] of [["export", false], ["export", true], ["verify", true], ["restore", true]] as const) {
  test(`drain stops a ${detached ? "detached" : "waiting"} ${step} child and preserves the current store`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pet-main-backup-drain-"));
    const backupDir = join(dataDir, "backups");
    const memory = join(dataDir, "memory");
    const database = join(memory, "db", "bara.sqlite");
    const scripts = join(dataDir, "core", "apps", "memory", "scripts");
    for (const path of [join(memory, "db"), join(memory, "assets"), join(memory, "config"), scripts, backupDir]) mkdirSync(path, { recursive: true });
    writeFileSync(database, "original database");
    writeFileSync(join(memory, "assets", "original.txt"), "original attachment");
    writeFileSync(join(memory, "managed-install.json"), JSON.stringify({ version: 1, phase: "complete", port: 41031 }));
    const settings = JSON.stringify({ db: { path: database }, assets: { dir: join(memory, "assets") } });
    writeFileSync(join(memory, "config", "memory-settings.json"), settings);
    const manifest = { format: "bara-memory", version: 1, createdAt: "2026-10-01T03:00:00.000Z", collections: { memories: { count: 3 } }, attachments: [] };
    const archive = join(backupDir, "bara-backup-20261001-120000");
    mkdirSync(archive);
    writeFileSync(join(archive, "manifest.json"), JSON.stringify(manifest));
    const marker = join(dataDir, "child.json");
    writeFileSync(join(scripts, "portable-memory.ts"), `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
if (args[0] === ${JSON.stringify(step)}) {
  if (args[0] === "export") mkdirSync(join(dirname(value("--out")), "." + value("--out").split(/[\\\\/]/).pop() + ".export-Ab12Cd"));
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, step: args[0] }));
  await Bun.sleep(60_000);
  throw new Error("test child was not stopped");
} else if (args[0] === "verify") {
  console.log(JSON.stringify({ valid: true, directory: value("--archive"), fingerprint: "f".repeat(64), manifest: ${JSON.stringify(manifest)} }));
}
`);
    writeFileSync(join(scripts, "prefetch-core-models.ts"), "");
    const service = startService(dataDir, backupDir);
    try {
      const kind = step === "export" ? "export" : "restore";
      const listing = await service.call("list", "backup.list", {}) as { result: { entries: Array<{ id: string }> } };
      const request = service.call("work", `backup.${kind}`, kind === "restore" ? { id: listing.result.entries[0]!.id } : {});
      for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(25);
      expect(existsSync(marker)).toBe(true);
      const child = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; step: string };
      expect(child.step).toBe(step);
      expect(() => process.kill(child.pid, 0)).not.toThrow();
      if (detached) {
        expect((await service.call("leave", "operation.cancel", { requestId: "work" })).result).toEqual({ cancelled: true });
        expect((await request).error?.code).toBe("CANCELLED");
        expect((await service.call("status", "backup.status", {})).result).toMatchObject({ [kind]: { state: "running" } });
      }
      const started = performance.now();
      expect((await service.call("drain", "service.drain", { timeoutMs: 100 })).result)
        .toEqual({ finished: detached, cancelled: detached ? 0 : 1 });
      expect(performance.now() - started).toBeLessThan(5_000);
      expect((await request).error?.code).toBe("CANCELLED");
      // A reply to drain means its offline command is already gone, even when no screen was waiting for it.
      expect(() => process.kill(child.pid, 0)).toThrow();
      expect(readFileSync(database, "utf8")).toBe("original database");
      expect(readFileSync(join(memory, "assets", "original.txt"), "utf8")).toBe("original attachment");
      expect(readFileSync(join(memory, "config", "memory-settings.json"), "utf8")).toBe(settings);
      expect(readdirSync(backupDir)).toEqual(["bara-backup-20261001-120000"]);
      if (step === "restore") expect(JSON.parse(readFileSync(join(dataDir, "restore-state.json"), "utf8"))).toMatchObject({ stage: "cancelled" });
      expect((await service.call("late", "backup.list", {})).error?.code).toBe("SHUTTING_DOWN");
    } finally {
      await service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
}

// Plan 1C②: the native host asks for the startup check as soon as the app starts (`src-tauri/src/startup.rs`) and
// the main window joins it. These drive the real service the way both do, with the host's `native_` request ids.

async function withStartupServer(clientInfo: (request: Request) => Promise<Response> | Response,
  run: (service: ReturnType<typeof startService>, counts: { clientInfo: number }) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pet-main-startup-test-"));
  const counts = { clientInfo: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/client-info") return new Response("", { status: 404 });
    counts.clientInfo++;
    return clientInfo(request);
  } });
  const service = startService(dataDir);
  try {
    const saved = await service.call("configure", "settings.save", {
      connection: { mode: "existing", baseUrl: `http://127.0.0.1:${server.port}` }, token: "pet-main-startup-test-token",
    });
    expect(saved.error).toBeUndefined();
    await run(service, counts);
  } finally {
    server.stop(true);
    await service.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
const CLIENT_INFO = { protocolVersion: 1, capabilities: [...REQUIRED_CAPABILITIES], captureKinds: ["idea", "decision", "question", "preference", "task"] };

test("the startup check the host started is joined by the window: one check, one outcome for both", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await withStartupServer(async () => { await held; return Response.json(CLIENT_INFO); }, async (service, counts) => {
    const host = service.call("native_1", "startup.check", {});
    await Bun.sleep(200);
    const screen = service.call("screen-1", "startup.check", {});
    await Bun.sleep(100);
    release();
    const [fromHost, fromScreen] = await Promise.all([host, screen]);
    expect(fromHost.result).toEqual({ kind: "connected", message: messages.serverClient.connected });
    expect(fromScreen.result).toEqual(fromHost.result);
    // A window that loads after the check ended gets the same outcome; nothing is checked again.
    expect((await service.call("screen-2", "startup.check", {})).result).toEqual(fromHost.result);
    expect(counts.clientInfo).toBe(1);
  });
}, 20_000);

test("a failed startup check carries the background bubble the host shows when no window took the report", async () => {
  await withStartupServer(() => new Response("", { status: 500 }), async (service) => {
    const { result } = await service.call("native_1", "startup.check", {}) as { result: Record<string, any> };
    expect(result).toMatchObject({ kind: "failed", stage: "connection" });
    expect(result.feedback).toMatchObject({ kind: "error", mode: "input", origin: "background",
      detail: messages.feedback.startupConnectionFailed(result.reason) });
  });
}, 20_000);

test("quitting during the startup check cancels the waits and still answers the drain", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await withStartupServer(async () => { await held; return Response.json(CLIENT_INFO); }, async (service) => {
    const host = service.call("native_1", "startup.check", {});
    const screen = service.call("screen-1", "startup.check", {});
    await Bun.sleep(200);
    const drained = await service.call("native_2", "service.drain", { timeoutMs: 300 });
    expect(drained.result).toEqual({ finished: false, cancelled: 2 });
    expect((await host).error).toEqual({ code: "CANCELLED", message: messages.rpc.cancelled });
    expect((await screen).error).toEqual({ code: "CANCELLED", message: messages.rpc.cancelled });
    release();
  });
}, 20_000);

test("the startup check never prepares a local install that is not ready, nor a new empty database", async () => {
  for (const phase of ["preparing", "complete"] as const) {
    const dataDir = mkdtempSync(join(tmpdir(), "pet-main-startup-local-"));
    const service = startService(dataDir);
    try {
      // The default connection is this PC's install; a token stands for one that was once complete.
      expect((await service.call("configure", "settings.save", { token: "pet-main-startup-local-token" })).error).toBeUndefined();
      mkdirSync(join(dataDir, "memory"), { recursive: true });
      writeFileSync(join(dataDir, "memory", "managed-install.json"), JSON.stringify({ version: 1, phase, port: CORE_DEFAULT_PORT }));
      const { result } = await service.call("native_1", "startup.check", {}) as { result: Record<string, any> };
      expect(result.kind).toBe("failed");
      if (phase === "complete") expect(result.reason).toBe(messages.connectionErrors.INSTALL_DATA_MISSING);
      expect(existsSync(join(dataDir, "memory", "db"))).toBe(false);
      expect(JSON.parse(readFileSync(join(dataDir, "memory", "managed-install.json"), "utf8")).phase).toBe(phase);
    } finally {
      await service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}, 30_000);
