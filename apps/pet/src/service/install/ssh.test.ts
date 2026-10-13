import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messages } from "../../ui/messages.ts";
import { ServiceError } from "../errors.ts";
import { knownHostsPath, runExpectedFailureProbe, safeRemotePath, shQuote, sshBase, trustHost, type SshTools } from "./ssh.ts";

const tools: SshTools = { ssh: "ssh", scp: "scp", keyscan: "ssh-keyscan", keygen: "ssh-keygen" };
test("remote shell path validation rejects option and expansion characters", () => {
  expect(safeRemotePath("/home/bara/.local/share/bara-pet-server")).toBe("/home/bara/.local/share/bara-pet-server");
  for (const path of ["/tmp/../etc", "/tmp/$(id)", "/tmp/a b", "/tmp/a;id", "/tmp//a", "-rf", "/"])
    expect(() => safeRemotePath(path)).toThrow();
  expect(shQuote("a'b")).toBe("'a'\\''b'");
});

test("host key is pinned only after exact fingerprint approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bara-known-hosts-"));
  const scanned = { host: "host", keyType: "ssh-ed25519", fingerprint: "SHA256:" + "A".repeat(43), known: false,
    line: "[host]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGV4YW1wbGU=" };
  try {
    await expect(trustHost(scanned, "SHA256:" + "B".repeat(43), dir)).rejects.toThrow();
    await trustHost(scanned, scanned.fingerprint, dir);
    expect(readFileSync(knownHostsPath(dir), "utf8")).toBe(scanned.line + "\n");
    await expect(trustHost({ ...scanned, line: scanned.line + "AA" }, scanned.fingerprint, dir)).rejects.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SSH command uses a dedicated known_hosts and never disables host checking", () => {
  const args = sshBase(tools, { host: "example.com", port: 22, user: "bara", keyPath: "C:\\keys\\id_ed25519" }, "C:\\data\\known_hosts");
  expect(args).toContain("StrictHostKeyChecking=yes");
  expect(args).toContain("UserKnownHostsFile=C:\\data\\known_hosts");
  expect(args).toContain("BatchMode=yes");
  expect(args.join(" ")).not.toContain("StrictHostKeyChecking=no");
});

// PFIX-2 deferred Minor (WP-P1-07): `runExpectedFailureProbe` is the single place scanHost and
// discoverWithoutAuthentication call for a step that is expected to fail in the normal course
// of host discovery. These tests call the production helper itself, against real child
// processes (per the plan's rule that process-timeout behavior is verified with real
// processes, not fakes) -- not a copy of its try/catch inside the test -- so a regression that
// makes the helper swallow a real timeout, or stop swallowing a plain failure, fails here.
test("runExpectedFailureProbe rethrows a real timeout with its step name intact", async () => {
  const controller = new AbortController();
  const ctx = { signal: controller.signal, progress: () => {} };
  const attempt = () => runExpectedFailureProbe(["cmd.exe", "/c", "ping", "-n", "4", "127.0.0.1"], ctx,
    { timeoutMs: 200, stepName: messages.installSteps.sshHostKeyScan });
  await expect(attempt()).rejects.toThrow(ServiceError);
  try {
    await attempt();
    throw new Error("expected attempt() to reject");
  } catch (error) {
    expect((error as ServiceError).code).toBe("INSTALL_STEP_TIMEOUT");
    expect((error as ServiceError).message).toContain(messages.installSteps.sshHostKeyScan);
  }
});

test("runExpectedFailureProbe swallows a plain command failure and reports undefined", async () => {
  const controller = new AbortController();
  const ctx = { signal: controller.signal, progress: () => {} };
  const result = await runExpectedFailureProbe(["cmd.exe", "/c", "exit", "1"], ctx,
    { timeoutMs: 5_000, stepName: messages.installSteps.sshHostKeyScan });
  expect(result).toBeUndefined();
});

test("runExpectedFailureProbe returns the captured output on a successful step", async () => {
  const controller = new AbortController();
  const ctx = { signal: controller.signal, progress: () => {} };
  const result = await runExpectedFailureProbe(["cmd.exe", "/c", "echo", "ok"], ctx,
    { timeoutMs: 5_000, stepName: messages.installSteps.sshHostKeyScan });
  expect(result?.stdout.trim()).toBe("ok");
});
