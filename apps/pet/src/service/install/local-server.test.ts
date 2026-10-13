import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalServer, type LocalServerLaunch } from "./local-server.ts";
import { availableLoopbackPort } from "./net.ts";

const windowsOnly = test.skipIf(process.platform !== "win32");

/** Await a rejection on the main event loop. Bun's `expect(promise).rejects` waits on a nested loop
 * that on Windows did not fire the `Bun.sleep` timers these flows use to notice cancellation. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error("expected the promise to reject"); }, (error: unknown) => error);
}

/** Stand-in for the core memory server: records each start and whether each request carried a
 * bearer, then serves `/client-info` only to the expected token. */
const SERVER_SCRIPT = `
import { appendFileSync } from "node:fs";
const env = process.env;
appendFileSync(env.PET_TEST_STARTS, process.pid + "\\n");
if (env.PET_TEST_MODE === "exit-before-listen") process.exit(3);
if (env.PET_TEST_MODE === "never-listen") await Bun.sleep(600_000);
Bun.serve({ hostname: "127.0.0.1", port: Number(env.MEMORY_PORT), fetch(request) {
  appendFileSync(env.PET_TEST_REQUESTS, (request.headers.has("authorization") ? "bearer" : "none") + "\\n");
  if (new URL(request.url).pathname !== "/client-info") return new Response("not found", { status: 404 });
  if (request.headers.get("authorization") !== "Bearer " + env.PET_TEST_TOKEN) return new Response("denied", { status: 401 });
  return Response.json({ protocolVersion: 1, capabilities: [] });
} });
`;

interface Fixture { dir: string; launch(port: number, audience: string, mode?: string, signal?: AbortSignal): LocalServerLaunch;
  starts(): number[]; requests(): string[] }

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pet-local-server-"));
  const script = join(dir, "server.ts");
  const startsFile = join(dir, "starts.log");
  const requestsFile = join(dir, "requests.log");
  writeFileSync(script, SERVER_SCRIPT);
  const token = randomUUID();
  const lines = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  return {
    dir,
    launch: (port, audience, mode = "serve", signal = new AbortController().signal) => ({
      argv: [process.execPath, script], cwd: dir, port, token, audience, ctx: { signal, progress() {} },
      env: { MEMORY_PORT: String(port), PET_TEST_STARTS: startsFile, PET_TEST_REQUESTS: requestsFile,
        PET_TEST_TOKEN: token, PET_TEST_MODE: mode },
    }),
    starts: () => lines(startsFile).map(Number),
    requests: () => lines(requestsFile),
  };
}

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

/** The port is free again only if nothing still listens on it: binding proves the child let go. */
async function expectPortReleased(port: number): Promise<void> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("probe") });
  await probe.stop(true);
}

windowsOnly("a port held by another program ends with INSTALL_PORT_TAKEN and never receives a bearer", async () => {
  const setup = fixture();
  const seen: string[] = [];
  // Answers like a ready memory server, which is what the old bearer-first check trusted.
  const occupant = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.push(request.headers.get("authorization") ?? "none");
    return Response.json({ protocolVersion: 1 });
  } });
  const server = new LocalServer();
  try {
    const error = await rejection(server.ensure(setup.launch(occupant.port!, "local-a")));
    expect(error).toMatchObject({ code: "INSTALL_PORT_TAKEN" });
    expect((error as Error).message).toContain(String(occupant.port));
    expect((error as Error).message).toContain(`PID ${process.pid}`);
    expect(seen).toEqual([]);
    expect(setup.starts()).toEqual([]);
  } finally {
    await server.close();
    await occupant.stop(true);
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 30_000);

windowsOnly("the server child is started once, proves it alone owns the port, and is then reused", async () => {
  const setup = fixture();
  const port = await availableLoopbackPort();
  const server = new LocalServer();
  try {
    await server.ensure(setup.launch(port, "local-a"));
    await server.ensure(setup.launch(port, "local-a"));
    expect(setup.starts()).toHaveLength(1);
    expect(setup.requests()).toEqual(["bearer"]);
    const [pid] = setup.starts();
    expect(running(pid!)).toBe(true);
    await server.close();
    expect(running(pid!)).toBe(false);
    await expectPortReleased(port);
  } finally {
    await server.close();
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 30_000);

windowsOnly("a child that exits before listening ends with INSTALL_SERVER_EXITED", async () => {
  const setup = fixture();
  const port = await availableLoopbackPort();
  const server = new LocalServer();
  try {
    const error = await rejection(server.ensure(setup.launch(port, "local-a", "exit-before-listen")));
    expect(error).toMatchObject({ code: "INSTALL_SERVER_EXITED" });
    expect(setup.starts()).toHaveLength(1);
    expect(setup.requests()).toEqual([]);
  } finally {
    await server.close();
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 30_000);

windowsOnly("another process listening next to the started child stops it before any bearer is sent", async () => {
  const setup = fixture();
  // IPv6 loopback only: the 127.0.0.1 probe before start cannot see it, so the child starts and
  // the sole-owner check after start must catch the second listener.
  const foreign = Bun.serve({ hostname: "::1", port: 0, fetch: () => Response.json({ protocolVersion: 1 }) });
  const port = foreign.port!;
  const server = new LocalServer();
  try {
    const error = await rejection(server.ensure(setup.launch(port, "local-a")));
    expect(error).toMatchObject({ code: "INSTALL_PORT_TAKEN" });
    expect((error as Error).message).toContain(`PID ${process.pid}`);
    expect(setup.starts()).toHaveLength(1);
    // The started child listened, yet not even its own readiness request was sent.
    expect(setup.requests()).toEqual([]);
    expect(running(setup.starts()[0]!)).toBe(false);
  } finally {
    await server.close();
    await foreign.stop(true);
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 30_000);

windowsOnly("a request for another port retires the running child before starting a new one", async () => {
  const setup = fixture();
  const first = await availableLoopbackPort();
  let second = await availableLoopbackPort();
  while (second === first) second = await availableLoopbackPort();
  const server = new LocalServer();
  try {
    await server.ensure(setup.launch(first, "local-a"));
    await server.ensure(setup.launch(second, "local-b"));
    expect(setup.starts()).toHaveLength(2);
    expect(running(setup.starts()[1]!)).toBe(true);
    // Processes were started after the first child exited, so its PID may already be reused;
    // the released port is the proof that it stopped.
    await expectPortReleased(first);
  } finally {
    await server.close();
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 30_000);

windowsOnly("cancelling while the child has not bound yet stops the child and sends nothing", async () => {
  const setup = fixture();
  const port = await availableLoopbackPort();
  const server = new LocalServer();
  const controller = new AbortController();
  try {
    const pending = server.ensure(setup.launch(port, "local-a", "never-listen", controller.signal));
    const deadline = Date.now() + 10_000;
    while (setup.starts().length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(setup.starts()).toHaveLength(1);
    controller.abort();
    expect(await rejection(pending)).toMatchObject({ name: "AbortError" });
    expect(running(setup.starts()[0]!)).toBe(false);
    expect(setup.requests()).toEqual([]);
  } finally {
    await server.close();
    rmSync(setup.dir, { recursive: true, force: true });
  }
}, 30_000);
