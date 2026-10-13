import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capture, HostRequest, RequestContext } from "../src/shared/contracts.ts";
import { MemoryClient } from "../src/service/client.ts";
import { ConfigStore } from "../src/service/config.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { NativeVault } from "../src/service/protocol.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";
import { messages } from "../src/ui/messages.ts";

// WP-PFIX-7: `info()` and `save()` answer with a result instead of throwing, so an exception that no
// service code names used to come out as one fixed sentence ("연결을 확인하지 못했습니다", and for a save
// even "연결한 서버가 바뀌었습니다" although no server had changed). Each test below drives a real failure
// through the real `MemoryClient` and `ConfigStore`: the settings read goes to the real `NativeVault`, and
// the test plays the Tauri host at the far end of its pipe -- the pipe breaking (a plain exception) or the
// host refusing the read (an error that carries its own public text). Nothing here sends a request to a
// server, so none of these needs a loopback listener or Windows DPAPI.

const ctx = (): RequestContext => ({ signal: new AbortController().signal, progress() {} });
const windowsOnly = test.skipIf(process.platform !== "win32");

type Transport = (frame: HostRequest, vault: NativeVault) => void;
/** The host's end of the pipe is closed: writing a vault request throws. */
const pipeClosed = (cause: Error): Transport => () => { throw cause; };
/** The host answers every vault request with an error reply, as it does when DPAPI cannot open an entry. */
const hostRefuses: Transport = (frame, vault) => queueMicrotask(() => vault.accept({ hostReply: { id: frame.host.id,
  error: { code: "DECRYPT_FAILED", message: "the host could not open the entry" } } }));

/** The real `ConfigStore` and `MemoryClient` over the real `NativeVault`; no settings file exists yet, so
 * the first thing a request does is read the vault through `transport`. */
async function withClient(transport: Transport, run: (client: MemoryClient) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pet-client-unexpected-"));
  const vault: NativeVault = new NativeVault((frame) => transport(frame, vault));
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, vault);
  try { await run(new MemoryClient(config, new CredentialRoutes(new LocalServer()))); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

const saveInput = () => ({ requestId: randomUUID(), audience: '{"mode":"existing","origin":"http://127.0.0.1:1","ssh":null}', content: "원인을 가리지 않는지 보는 테스트 문장", kind: null });
const PIPE_SENTENCE = "write EPIPE: the host pipe is closed";

test("info(): an exception no service code names reports its own cause, not one fixed sentence", async () => {
  const thrown = new Error(PIPE_SENTENCE);
  await withClient(pipeClosed(thrown), async (client) => {
    const status = await client.info();
    expect(status).toEqual({ connected: false, message: messages.serverClient.connectionCheckFailed(String(thrown)) });
    expect(status.message).toContain(PIPE_SENTENCE);
  });
});

test("info(): an error that carries its own checked public text keeps that text", async () => {
  await withClient(hostRefuses, async (client) => {
    expect(await client.info()).toEqual({ connected: false, message: messages.rpc.vaultRejected });
  });
});

test("the cause of an unexpected exception is one short line", async () => {
  await withClient(pipeClosed(new Error(`first line\nsecond line ${"x".repeat(5_000)}`)), async (client) => {
    const { message } = await client.info();
    expect(message).toContain("first line second line xxx");
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThan(400);
  });
});

test("a cause that holds something shaped like a credential is withheld and says so", async () => {
  await withClient(pipeClosed(new Error("request failed with header Bearer abc123secret")), async (client) => {
    const { message } = await client.info();
    expect(message).toBe(messages.serverClient.connectionCheckFailed(messages.serverClient.causeWithheld));
    expect(message).not.toContain("abc123secret");
  });
});

// WP-PFIX-13 (M4): an exception whose text shows nothing has an empty cause, which used to read
// `... 오류가 났습니다. ()`. The text now says that the cause sentence is empty.
test("an exception whose text shows nothing says its cause sentence is empty, never ()", async () => {
  const thrown = Object.assign(new Error("\u001b\u200b\u00ad\ufeff"), { name: "" });
  expect(String(thrown)).toBe("\u001b\u200b\u00ad\ufeff"); // only the message, and nothing of it shows
  await withClient(pipeClosed(thrown), async (client) => {
    const { message } = await client.info();
    expect(message).toBe(messages.serverClient.connectionCheckFailed(""));
    expect(message).toContain(messages.serverClient.causeEmpty);
    expect(message).not.toContain("(");
  });
});

test("save(): an exception thrown while checking the input is rejected with its own cause, before anything is sent", async () => {
  // A revoked Proxy makes the validator's own `Array.isArray` throw the engine's TypeError: the checks
  // turn every bad value into a service error, so only an exotic object (or a defect in them) gets here.
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  let engineCause = "";
  try { Array.isArray(proxy); } catch (error) { engineCause = String(error); }
  expect(engineCause).toContain("TypeError");
  const input = saveInput();
  // The vault would answer with a different text if the save got past the input check and read the settings.
  await withClient(pipeClosed(new Error(PIPE_SENTENCE)), async (client) => {
    const result = await client.save(input, ctx(), proxy as unknown as Capture);
    expect(result).toEqual({ state: "rejected", requestId: input.requestId, audience: input.audience,
      message: messages.serverClient.saveInputCheckFailed(engineCause) });
  });
});

test("save(): an exception thrown while reading the saved connection is rejected with its own cause, not 'the server changed'", async () => {
  const thrown = new Error(PIPE_SENTENCE);
  const input = saveInput();
  await withClient(pipeClosed(thrown), async (client) => {
    const result = await client.save(input, ctx());
    expect(result).toEqual({ state: "rejected", requestId: input.requestId, audience: input.audience, capture: null,
      message: messages.serverClient.saveConnectionCheckFailed(String(thrown)) });
    expect(result.message).toContain(PIPE_SENTENCE);
    expect(result.message).not.toContain(messages.connectionChange.serverSwitched);
  });
});

test("save(): a host that refuses the settings read is rejected with the host's own public text", async () => {
  const input = saveInput();
  await withClient(hostRefuses, async (client) => {
    expect(await client.save(input, ctx())).toEqual({ state: "rejected", requestId: input.requestId, audience: input.audience, capture: null,
      message: messages.rpc.vaultRejected });
  });
});

// The server really changed: this is the one case that says so. It already passed before WP-PFIX-7 and
// stays here so the fix for the unexpected case never turns a real switch into a cause sentence.
windowsOnly("save(): a saved server that differs from the one the draft was made for is rejected as 'server changed', and nothing is sent", async () => {
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { hits++; return new Response("", { status: 500 }); } });
  const dir = mkdtempSync(join(tmpdir(), "pet-client-switched-"));
  try {
    const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
    await config.save({ connection: { mode: "existing", baseUrl: `http://127.0.0.1:${server.port}` }, token: "authored-test-token" });
    const client = new MemoryClient(config, new CredentialRoutes(new LocalServer()));
    const input = saveInput();
    expect(await client.save(input, ctx())).toEqual({ state: "rejected", requestId: input.requestId, audience: input.audience, capture: null,
      message: messages.connectionChange.serverSwitched });
    expect(hits).toBe(0);
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
