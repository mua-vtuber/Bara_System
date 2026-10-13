import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nativeHost from "../src/shared/native-host.json";

/**
 * The service tells the native host it is still alive while a request is in progress, and only
 * then: the host (`src-tauri/src/bridge.rs` `await_reply`) keeps waiting as long as some line
 * arrives and stops the service after `serviceSilenceLimitMs` of silence. This runs the real
 * `src/service/main.ts` over its stdin/stdout pipe, with this test in the host's place.
 */
const { serviceHeartbeatMs, serviceSilenceLimitMs } = nativeHost.contract;
/** The test server holds every answer this long, well past one heartbeat interval, so the
 * request stays in progress until the service's own request limit ends it. */
const SERVER_DELAY_MS = 12_000;
/** How long the test keeps listening after the reply: more than one heartbeat interval, so a
 * heartbeat left running after the operation ended would show up. */
const AFTER_REPLY_WATCH_MS = serviceHeartbeatMs + serviceHeartbeatMs / 2;

interface Frame { id?: string; event?: string; host?: { id: string; method: string; params: { key: string; value?: string } }; result?: unknown; error?: unknown }

/** Drives the real service child: answers its vault frames from a map, as the host answers them
 * from the DPAPI vault, and records every frame with the time it arrived. */
function startService(dataDir: string) {
  const child = Bun.spawn([process.execPath, "run", "src/service/main.ts"], {
    cwd: process.cwd(),
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
    env: { ...process.env, BARA_PET_DATA_DIR: dataDir, BARA_PET_RESOURCES: dataDir },
  });
  const vaultStore = new Map<string, string>();
  const waiters = new Map<string, (frame: Frame) => void>();
  const events: Array<{ at: number; frame: Frame }> = [];

  function send(frame: unknown): void { child.stdin.write(`${JSON.stringify(frame)}\n`); }

  function handleLine(line: string): void {
    if (!line) return;
    const frame = JSON.parse(line) as Frame;
    if (frame.host) {
      const { id, method, params } = frame.host;
      if (method === "vault.get") send({ hostReply: { id, result: vaultStore.get(params.key) ?? null } });
      else if (method === "vault.set") { vaultStore.set(params.key, params.value ?? ""); send({ hostReply: { id, result: null } }); }
      else if (method === "vault.delete") { vaultStore.delete(params.key); send({ hostReply: { id, result: null } }); }
      return;
    }
    if (frame.event) { events.push({ at: performance.now(), frame }); return; }
    const waiter = frame.id === undefined ? undefined : waiters.get(frame.id);
    if (waiter && frame.id !== undefined) { waiters.delete(frame.id); waiter(frame); }
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

  function call(id: string, method: string, params: Record<string, unknown>): Promise<Frame> {
    return new Promise((resolve) => { waiters.set(id, resolve); send({ id, method, params }); });
  }
  return { call, events, stop: () => child.kill() };
}

test("the silence limit leaves room for several missed heartbeats", () => {
  expect(serviceHeartbeatMs).toBeGreaterThan(0);
  expect(serviceSilenceLimitMs).toBeGreaterThanOrEqual(3 * serviceHeartbeatMs);
});

test("the service sends heartbeats while a request is in progress and stops once it is answered", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pet-heartbeat-test-"));
  const slowServer = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch() {
      await Bun.sleep(SERVER_DELAY_MS);
      return new Response("", { status: 404 });
    },
  });
  const service = startService(dataDir);
  try {
    const saved = await service.call("configure", "settings.save", {
      connection: { mode: "existing", baseUrl: `http://127.0.0.1:${slowServer.port}` },
      token: "pet-heartbeat-test-token",
    });
    expect(saved.error).toBeUndefined();
    expect(service.events).toEqual([]);

    const sentAt = performance.now();
    const reply = await service.call("check-1", "connection.test", {});
    const repliedAt = performance.now();
    expect(reply.id).toBe("check-1");
    expect(repliedAt - sentAt).toBeGreaterThan(serviceHeartbeatMs);

    const before = service.events.filter((event) => event.at >= sentAt && event.at <= repliedAt);
    expect(before.length).toBeGreaterThanOrEqual(1);
    for (const event of before) expect(event.frame).toEqual({ event: "alive" });

    await Bun.sleep(AFTER_REPLY_WATCH_MS);
    expect(service.events.filter((event) => event.at > repliedAt)).toEqual([]);
    expect(service.events.length).toBe(before.length);
  } finally {
    slowServer.stop(true);
    service.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 60_000);
