/** Manual isolated SSH fixture check: no bearer goes to an occupied local port.
 * Run: bun run tests/e2e-ssh-port-race.ts [--fixture path/to/fixture.json]
 */
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";
import { findSshTools, scanHost, trustHost } from "../src/service/install/ssh.ts";
import { startTunnel } from "../src/service/install/remote.ts";
import { stopProcess } from "../src/service/install/process.ts";
import { waitForTunnelListener } from "../src/service/install/port-owner.ts";
import { loadSshFixture } from "./e2e/ssh-fixture.ts";

const project = join(import.meta.dir, "..");
const { ssh, fingerprint } = loadSshFixture(Bun.argv.slice(2), project);
const dataRoot = join(project, ".omx", "e2e");
await mkdir(dataRoot, { recursive: true });
const dataDir = await mkdtemp(join(dataRoot, "ssh-race-"));
const ctx = { signal: new AbortController().signal, progress() {} };
const tools = findSshTools();
const scanned = await scanHost(tools, ssh, dataDir, ctx);
const knownHosts = await trustHost(scanned, fingerprint, dataDir);
let sawAuthorization = false;
const occupant = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  if (request.headers.has("authorization")) sawAuthorization = true;
  return Response.json({ protocolVersion: 1, capabilities: [] });
} });
const occupiedPort = occupant.port;
if (!occupiedPort) throw new Error("Occupant did not bind a loopback port");
const tunnel = startTunnel(tools, ssh, knownHosts, occupiedPort, ssh.serverPort!);
let rejected = false;
try {
  try { await waitForTunnelListener(tunnel, `http://127.0.0.1:${occupiedPort}`, ctx.signal, 8000); }
  catch (error) { rejected = ["SSH_TUNNEL_BIND_FAILED", "SSH_TUNNEL_OWNER_UNKNOWN"].includes((error as { code?: string }).code ?? ""); }
  assert(rejected, "occupied port must not be attributed to SSH");
  assert.equal(sawAuthorization, false, "occupied listener saw no bearer");
  process.stdout.write(JSON.stringify({ rejected, sawAuthorization }) + "\n");
} finally { stopProcess(tunnel); occupant.stop(true); }
