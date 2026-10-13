import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollmentRefusal, MemoryClient } from "../src/service/client.ts";
import { ConfigStore } from "../src/service/config.ts";
import { ServiceError, serviceError } from "../src/service/errors.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { messages } from "../src/ui/messages.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

// bara's POST /adapter-enroll refuses a request with a named `code` when a request for this adapter already
// waits (409), the approval queue is full (429) or the address asked too often (429), and drops a pending
// request nobody approved in time (the pickup check then answers 404). Each case runs the real client
// against a real loopback HTTP server that answers as bara does; nothing is replaced by a fake.

const windowsOnly = test.skipIf(process.platform !== "win32");
const signal = () => new AbortController().signal;

function refusingServer(status: number, body: Record<string, unknown>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(body, { status }) });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

async function clientFor(baseUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "pet-enroll-refusal-"));
  const config = new ConfigStore({ dataDir: dir, resourceDir: dir, bunPath: process.execPath }, new DpapiVault());
  await config.save({ connection: { mode: "existing", baseUrl } });
  return { dir, config, client: new MemoryClient(config, new CredentialRoutes(new LocalServer())) };
}

const failureOf = async (run: Promise<unknown>): Promise<ServiceError> => {
  const caught = await run.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(ServiceError);
  return caught as ServiceError;
};

const cases = [
  { status: 409, serverCode: "ADAPTER_ENROLL_PENDING_EXISTS", code: "ENROLLMENT_PENDING_EXISTS", message: messages.serverClient.enrollmentPendingExists },
  { status: 429, serverCode: "ADAPTER_ENROLL_ADDRESS_PENDING_LIMIT", code: "ENROLLMENT_ADDRESS_QUEUE_FULL", message: messages.serverClient.enrollmentAddressQueueFull },
  { status: 429, serverCode: "ADAPTER_ENROLL_PENDING_LIMIT", code: "ENROLLMENT_QUEUE_FULL", message: messages.serverClient.enrollmentQueueFull },
  { status: 429, serverCode: "ADAPTER_ENROLL_RATE_LIMITED", code: "ENROLLMENT_RATE_LIMITED", message: messages.serverClient.enrollmentRateLimited },
];

for (const refusal of cases) {
  windowsOnly(`enrollment.start answered ${refusal.status} ${refusal.serverCode} becomes ${refusal.code} with its own sentence`, async () => {
    const listener = refusingServer(refusal.status, { error: "server sentence", code: refusal.serverCode });
    const { dir, config, client } = await clientFor(listener.baseUrl);
    try {
      const error = await failureOf(client.enrollmentStart({ signal: signal(), progress() {} }));
      expect({ code: error.code, message: error.publicMessage }).toEqual({ code: refusal.code, message: refusal.message });
      // Nothing was enrolled, so there is nothing to poll.
      expect(await config.getEnrollment()).toBeNull();
    } finally { listener.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
}

windowsOnly("a pickup check for a request the server no longer has clears the stored enrollment and says to start again", async () => {
  const listener = refusingServer(404, { error: "not found" });
  const { dir, config, client } = await clientFor(listener.baseUrl);
  try {
    const { settings } = await config.snapshot();
    await config.setEnrollment(JSON.stringify({ requestId: "req-1", pickupSecret: "pickup", baseUrl: listener.baseUrl }), settings.connection);
    const error = await failureOf(client.enrollmentPoll({ signal: signal(), progress() {} }));
    expect({ code: error.code, message: error.publicMessage }).toEqual({ code: "ENROLLMENT_EXPIRED", message: messages.serverClient.enrollmentExpired });
    expect(await config.getEnrollment()).toBeNull();
  } finally { listener.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

/** Answers as bara does when this Pet's own request already waits: POST /adapter-enroll is refused with
 * 409 PENDING_EXISTS, the owner approval is accepted, and the pickup check hands over the token once the
 * request is approved. Records each request it got so a test can see what the Pet sent. */
function serverKeepingOurRequest(requestId: string, approvedFromStart: boolean, approveGone = false) {
  const seen: string[] = [];
  let approved = approvedFromStart;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => {
    const path = new URL(req.url).pathname;
    seen.push(`${req.method} ${path}`);
    if (req.method === "POST" && path === "/adapter-enroll") {
      return Response.json({ error: "pending exists", code: "ADAPTER_ENROLL_PENDING_EXISTS" }, { status: 409 });
    }
    if (req.method === "POST" && path === `/adapter-tokens/${requestId}/approve`) {
      if (approveGone) return Response.json({ error: "어댑터 토큰 요청을 찾을 수 없습니다." }, { status: 404 });
      approved = true;
      return Response.json({ approved: requestId });
    }
    if (req.method === "GET" && path === `/adapter-enroll/${requestId}/token`) {
      return approved
        ? Response.json({ status: "approved", adapterId: "bara-pet", requestId, token: "resumed-token" })
        : Response.json({ status: "pending", adapterId: "bara-pet", requestId }, { status: 202 });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  } });
  return { server, seen, baseUrl: `http://127.0.0.1:${server.port}` };
}

windowsOnly("a 409 for a request this Pet saved for the same server resumes that request instead of failing", async () => {
  const listener = serverKeepingOurRequest("req-saved", true);
  const { dir, config, client } = await clientFor(listener.baseUrl);
  try {
    const { settings } = await config.snapshot();
    await config.setEnrollment(JSON.stringify({ requestId: "req-saved", pickupSecret: "pickup", baseUrl: listener.baseUrl }), settings.connection);
    const result = await client.enrollmentStart({ signal: signal(), progress() {} });
    expect(result).toMatchObject({ state: "approved", requestId: "req-saved" });
    expect((await config.snapshot()).token).toBe("resumed-token");
    expect(await config.getEnrollment()).toBeNull();
  } finally { listener.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

windowsOnly("with the owner token, a resumed request is approved by the Pet itself", async () => {
  const listener = serverKeepingOurRequest("req-saved", false);
  const { dir, config, client } = await clientFor(listener.baseUrl);
  try {
    await config.save({ ownerToken: "owner-test-token" });
    const { settings } = await config.snapshot();
    await config.setEnrollment(JSON.stringify({ requestId: "req-saved", pickupSecret: "pickup", baseUrl: listener.baseUrl }), settings.connection);
    const result = await client.enrollmentStart({ signal: signal(), progress() {} });
    expect(result).toMatchObject({ state: "approved", requestId: "req-saved" });
    expect(listener.seen).toContain("POST /adapter-tokens/req-saved/approve");
  } finally { listener.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

windowsOnly("when the owner approval finds the saved request gone, the saved request is cleared and the 409 guidance is shown", async () => {
  const listener = serverKeepingOurRequest("req-saved", false, true);
  const { dir, config, client } = await clientFor(listener.baseUrl);
  try {
    await config.save({ ownerToken: "owner-test-token" });
    const { settings } = await config.snapshot();
    await config.setEnrollment(JSON.stringify({ requestId: "req-saved", pickupSecret: "pickup", baseUrl: listener.baseUrl }), settings.connection);
    const error = await failureOf(client.enrollmentStart({ signal: signal(), progress() {} }));
    expect({ code: error.code, message: error.publicMessage }).toEqual({ code: "ENROLLMENT_PENDING_EXISTS", message: messages.serverClient.enrollmentPendingExists });
    expect(await config.getEnrollment()).toBeNull();
  } finally { listener.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

windowsOnly("a 409 with a saved request for another server address is reported, not resumed", async () => {
  const listener = serverKeepingOurRequest("req-saved", true);
  const { dir, config, client } = await clientFor(listener.baseUrl);
  try {
    const { settings } = await config.snapshot();
    await config.setEnrollment(JSON.stringify({ requestId: "req-saved", pickupSecret: "pickup", baseUrl: "http://127.0.0.1:1" }), settings.connection);
    const error = await failureOf(client.enrollmentStart({ signal: signal(), progress() {} }));
    expect(error.code).toBe("ENROLLMENT_PENDING_EXISTS");
    expect(listener.seen).not.toContain("GET /adapter-enroll/req-saved/token");
  } finally { listener.server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("a refusal without a known enrollment code passes through unchanged", () => {
  const other = serviceError("CONFLICT", "generic", false, { serverCode: "SOMETHING_ELSE" });
  expect(enrollmentRefusal(other)).toBe(other);
  const plain = new Error("network");
  expect(enrollmentRefusal(plain)).toBe(plain);
});
