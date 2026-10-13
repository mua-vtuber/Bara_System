import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messages } from "../ui/messages.ts";
import { assertTunnelListener, waitForTunnelListener } from "./install/port-owner.ts";
import { tunnelPort, validateCapture, validateConnection, validateSaveInput, validateSettingsUpdate } from "./validation.ts";

const ssh = { host: "memory.example.org", port: 22, user: "ubuntu", keyPath: join(tmpdir(), "pet-validation-key") };

test("information is accepted for explicit saves and user or AI classification edits", () => {
  expect(validateSaveInput({ content: "작업 컴퓨터 GPU는 4080S", requestId: "11111111-1111-4111-8111-111111111111", audience: "server-A", kind: "information" }).kind).toBe("information");
  expect(validateCapture({ kind: "information", source: "user" })).toEqual({ kind: "information", source: "user" });
  expect(validateCapture({ kind: "information", source: "ai" })).toEqual({ kind: "information", source: "ai" });
});

// WP-PFIX-5: one rule for the local end of an SSH tunnel, shared by the saved-connection check, the
// tunnel opener (`ensureRemoteTunnel`) and the port-owner check.
test("tunnelPort accepts only http://127.0.0.1:<port> and returns the port", () => {
  expect(tunnelPort("http://127.0.0.1:41031")).toBe(41031);
  expect(tunnelPort("http://127.0.0.1:41031/")).toBe(41031);
  expect(tunnelPort("http://127.0.0.1:1")).toBe(1);
  expect(tunnelPort("http://127.0.0.1:65535")).toBe(65535);
});

test("tunnelPort refuses every other address form", () => {
  for (const address of [
    "https://127.0.0.1:41031", "http://localhost:41031", "http://[::1]:41031", "http://0.0.0.0:41031",
    "http://127.0.0.2:41031", "http://127.0.0.1.example.org:41031", "http://memory.example.org:41031",
    "http://127.0.0.1", "http://127.0.0.1:80", "http://127.0.0.1:0", "http://127.0.0.1:65536",
    "http://127.0.0.1:41031/memories", "http://127.0.0.1:41031/?next=1", "http://127.0.0.1:41031/#frag",
    "http://user:secret@127.0.0.1:41031", "ftp://127.0.0.1:41031", "127.0.0.1:41031", "not a url", "",
  ]) expect({ address, port: tunnelPort(address) }).toEqual({ address, port: null });
});

test("a remote connection is saved only with the tunnel's loopback address", () => {
  expect(validateConnection({ mode: "remote", baseUrl: "http://127.0.0.1:41031", ssh })).toMatchObject({ mode: "remote", baseUrl: "http://127.0.0.1:41031" });
  for (const baseUrl of ["https://memory.example.org", "http://localhost:41031", "http://127.0.0.1"])
    expect(() => validateConnection({ mode: "remote", baseUrl, ssh })).toThrow();
});

test("the port-owner check refuses an address the connection check refuses, before it looks at the tunnel", async () => {
  const tunnel = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    const signal = new AbortController().signal;
    for (const address of ["http://localhost:41031", "http://127.0.0.1:41031/memories", "https://127.0.0.1:41031", "http://127.0.0.1"]) {
      await expect(assertTunnelListener(tunnel, address, signal)).rejects.toMatchObject({ code: "SSH_TUNNEL_URL_INVALID", publicMessage: messages.installService.tunnelAddressInvalid });
      await expect(waitForTunnelListener(tunnel, address, signal, 50)).rejects.toMatchObject({ code: "SSH_TUNNEL_URL_INVALID", publicMessage: messages.installService.tunnelAddressInvalid });
    }
  } finally { tunnel.kill(); await tunnel.exited; }
});

test("cleanupOnSave must be a boolean", () => {
  expect(validateSettingsUpdate({ cleanupOnSave: true })).toEqual({ cleanupOnSave: true });
  expect(() => validateSettingsUpdate({ cleanupOnSave: "yes" as never })).toThrow(messages.fieldLabels.cleanupOnSave);
});
