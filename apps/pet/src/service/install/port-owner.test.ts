import { expect, test } from "bun:test";
import { serviceError } from "../errors.ts";
import { availableLoopbackPort } from "./net.ts";
import { assertSoleListener, assertTunnelListener, isSoleOwner, listeningOwners, parseSsOwners, parseWindowsOwners,
  waitForSoleListener, waitForTunnelListener, type OwnershipFailures } from "./port-owner.ts";

const windowsOnly = test.skipIf(process.platform !== "win32");

/** Await a rejection on the main event loop. Bun's `expect(promise).rejects` waits on a nested loop
 * that on Windows did not fire the `Bun.sleep` timers these flows use to notice cancellation. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error("expected the promise to reject"); }, (error: unknown) => error);
}

function thrown(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error("expected the call to throw");
}

/** Failures that carry their own codes, so each assertion shows which branch rejected. */
function recordingFailures(taken: number[][]): OwnershipFailures {
  return {
    exited: () => serviceError("TEST_EXITED", "child exited"),
    taken: (others) => { taken.push([...others]); return serviceError("TEST_TAKEN", "port taken"); },
    unverified: () => serviceError("TEST_UNVERIFIED", "ownership unverified"),
  };
}

async function firstLine(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const reader = child.stdout.getReader();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`listener exited before reporting: ${await new Response(child.stderr).text()}`);
      text += new TextDecoder().decode(value);
    }
  } finally { reader.releaseLock(); }
  return text.trim();
}

test("sole ownership means exactly one listening process", () => {
  expect(isSoleOwner(new Set(), 4120)).toBe(false);
  expect(isSoleOwner(new Set([4120]), 4120)).toBe(true);
  expect(isSoleOwner(new Set([4120, 5000]), 4120)).toBe(false);
  expect(isSoleOwner(new Set([5000]), 4120)).toBe(false);
});

test("listener lookups accept only complete, well-formed output", () => {
  expect([...parseWindowsOwners("4120\r\n4120\r\n5000\r\nEND\r\n")]).toEqual([4120, 5000]);
  expect(parseWindowsOwners("END\r\n").size).toBe(0);
  expect(thrown(() => parseWindowsOwners("4120\r\n"))).toMatchObject({ code: "PORT_OWNER_UNKNOWN" });
  expect(thrown(() => parseWindowsOwners("Access is denied.\r\nEND\r\n"))).toMatchObject({ code: "PORT_OWNER_UNKNOWN" });
  const ss = "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\n" +
    "LISTEN 0      128        127.0.0.1:41001      0.0.0.0:*     users:((\"ssh\",pid=321,fd=4))\n" +
    "LISTEN 0      511             [::]:41001         [::]:*     users:((\"node\",pid=77,fd=20),(\"node\",pid=78,fd=20))\n";
  expect([...parseSsOwners(ss)].sort((a, b) => a - b)).toEqual([77, 78, 321]);
  expect(parseSsOwners("State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\n").size).toBe(0);
  // Another user's socket without privileges shows no process: ownership is unknown, not absent.
  expect(thrown(() => parseSsOwners("LISTEN 0 128 0.0.0.0:41001 0.0.0.0:*\n"))).toMatchObject({ code: "PORT_OWNER_UNKNOWN" });
});

windowsOnly("the OS listener table names this process as the only owner of its real Bun.serve port", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = server.port!;
  const signal = new AbortController().signal;
  try {
    const owners = await listeningOwners(port, signal);
    expect([...owners]).toEqual([process.pid]);
    expect(isSoleOwner(owners, process.pid)).toBe(true);
  } finally { await server.stop(true); }
  expect((await listeningOwners(port, signal)).size).toBe(0);
}, 30_000);

windowsOnly("a lookup does not block the event loop: a 10 ms timer and an HTTP request run while it is pending", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("served") });
  try {
    const started = performance.now();
    let timerAt = -1;
    setTimeout(() => { timerAt = performance.now() - started; }, 10);
    let settled = false;
    const lookup = listeningOwners(server.port!, new AbortController().signal).finally(() => { settled = true; });
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("served");
    // A blocking lookup would already have finished before this line and before the timer.
    expect(settled).toBe(false);
    const owners = await lookup;
    const lookupMs = performance.now() - started;
    expect(timerAt).toBeGreaterThanOrEqual(0);
    expect(timerAt).toBeLessThan(lookupMs);
    expect([...owners]).toEqual([process.pid]);
  } finally { await server.stop(true); }
}, 30_000);

windowsOnly("cancelling a pending lookup rejects it with the abort instead of an owner set", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const controller = new AbortController();
  try {
    const lookup = listeningOwners(server.port!, controller.signal);
    setTimeout(() => controller.abort(), 50);
    expect(await rejection(lookup)).toMatchObject({ name: "AbortError" });
  } finally { await server.stop(true); }
}, 30_000);

windowsOnly("a second process listening on the same port fails the sole-owner check for any child", async () => {
  const child = Bun.spawn([process.execPath, "-e",
    "const server = Bun.serve({ hostname: \"127.0.0.1\", port: 0, fetch: () => new Response(\"child\") }); console.log(server.port);"],
  { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const signal = new AbortController().signal;
  const taken: number[][] = [];
  const failures = recordingFailures(taken);
  let foreign: ReturnType<typeof Bun.serve> | null = null;
  try {
    const port = Number(await firstLine(child));
    const baseUrl = `http://127.0.0.1:${port}`;
    // Opened after the child started, so the child cannot inherit this listening socket on Windows.
    // IPv6 loopback only: no firewall prompt, and it cannot answer 127.0.0.1.
    foreign = Bun.serve({ hostname: "::1", port, fetch: () => new Response("foreign") });
    expect(await rejection(waitForSoleListener(child, port, signal, 5_000, failures))).toMatchObject({ code: "TEST_TAKEN" });
    expect(await rejection(assertSoleListener(child, port, signal, failures))).toMatchObject({ code: "TEST_TAKEN" });
    expect(taken).toEqual([[process.pid], [process.pid]]);
    expect(await rejection(waitForTunnelListener(child, baseUrl, signal))).toMatchObject({ code: "SSH_TUNNEL_BIND_FAILED" });
    expect(await rejection(assertTunnelListener(child, baseUrl, signal))).toMatchObject({ code: "SSH_TUNNEL_BIND_FAILED" });
    await foreign.stop(true);
    foreign = null;
    await waitForSoleListener(child, port, signal, 5_000, failures);
    await assertTunnelListener(child, baseUrl, signal);
  } finally {
    child.kill();
    await child.exited;
    if (foreign) await foreign.stop(true);
  }
}, 60_000);

windowsOnly("an exited child and a child that never binds are reported as such, not as owners", async () => {
  const port = await availableLoopbackPort();
  const signal = new AbortController().signal;
  const failures = recordingFailures([]);
  const quits = Bun.spawn([process.execPath, "-e", "process.exit(4)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await quits.exited;
  expect(await rejection(waitForSoleListener(quits, port, signal, 1_000, failures))).toMatchObject({ code: "TEST_EXITED" });
  expect(await rejection(assertSoleListener(quits, port, signal, failures))).toMatchObject({ code: "TEST_EXITED" });
  const idle = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    expect(await rejection(waitForSoleListener(idle, port, signal, 300, failures))).toMatchObject({ code: "TEST_UNVERIFIED" });
    expect(await rejection(assertSoleListener(idle, port, signal, failures))).toMatchObject({ code: "TEST_UNVERIFIED" });
    expect(await rejection(waitForTunnelListener(idle, `http://127.0.0.1:${port}`, signal, 300))).toMatchObject({ code: "SSH_TUNNEL_OWNER_UNKNOWN" });
  } finally {
    idle.kill();
    await idle.exited;
  }
}, 30_000);

// WP-PFIX-5: a child ended by `kill()` keeps `exitCode` null (Bun 1.3.6 on Windows) and only sets
// `signalCode`; it must still be reported as exited before any listener lookup runs.
test("a child ended by kill() is reported as exited, not looked up as a possible listener", async () => {
  const port = await availableLoopbackPort();
  const signal = new AbortController().signal;
  const failures = recordingFailures([]);
  const killed = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  killed.kill();
  await killed.exited;
  expect(await rejection(assertSoleListener(killed, port, signal, failures))).toMatchObject({ code: "TEST_EXITED" });
  expect(await rejection(waitForSoleListener(killed, port, signal, 1_000, failures))).toMatchObject({ code: "TEST_EXITED" });
  expect(await rejection(assertTunnelListener(killed, `http://127.0.0.1:${port}`, signal))).toMatchObject({ code: "SSH_TUNNEL_BIND_FAILED" });
}, 30_000);
