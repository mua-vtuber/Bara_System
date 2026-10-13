/** Manual real-core audience race check: bun run tests/e2e-audience.ts ABSOLUTE_CORE_WORKTREE */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { connectionAudience } from "../src/shared/contracts.ts";
import { ConfigStore } from "../src/service/config.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { MemoryClient, requestJson } from "../src/service/client.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";
import type { RequestContext } from "../src/shared/contracts.ts";

const core = resolve(Bun.argv[2] ?? "");
if (!existsSync(join(core, "apps/memory/src/index.ts")) || process.platform !== "win32") throw new Error("Use an absolute repository root on Windows");
const tempRoot = resolve(tmpdir());
const temp = await mkdtemp(join(tempRoot, "bara-pet-audience-"));
if (!resolve(temp).startsWith(`${tempRoot}${sep}`)) throw new Error("Temporary path escaped its root");
const reportPath = resolve(import.meta.dir, "../.omx/e2e/audience-report.json");
const report: Record<string, unknown> = { outcome: "failed", stage: "prepare", temporaryData: true, checks: {} };
const checks = report.checks as Record<string, boolean>;
const check = (name: string, condition: boolean) => { assert(condition, name); checks[name] = true; };
const ctx: RequestContext = { signal: new AbortController().signal, progress() {} };
const freePort = () => { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); const port = server.port; server.stop(true); return port; };
let aProcess: Bun.Subprocess | undefined, bProcess: Bun.Subprocess | undefined, proxy: ReturnType<typeof Bun.serve> | undefined;
let release: (() => void) | undefined;

async function ready(base: string, child: Bun.Subprocess) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Core exited during startup");
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_500) })).ok) return; } catch {}
    await Bun.sleep(800);
  }
  throw new Error("Core startup timeout");
}

try {
  const appDir = join(core, "apps/memory");
  const { prepareManagedMemory } = await import(pathToFileURL(join(core, "apps/setup/src/managed-prepare.ts")).href);
  const { prepareClientTokens } = await import(pathToFileURL(join(core, "apps/setup/src/client-token.ts")).href);
  const aPort = freePort(), bPort = freePort();
  const aBase = `http://127.0.0.1:${aPort}`, bBase = `http://127.0.0.1:${bPort}`;
  const a = prepareManagedMemory({ dataDir: join(temp, "server-a"), port: aPort });
  const b = prepareManagedMemory({ dataDir: join(temp, "server-b"), port: bPort });
  const aTokens = await prepareClientTokens(`${aBase}/`, a.env.SSE_TOKEN_PATH);
  const bTokens = await prepareClientTokens(`${bBase}/`, b.env.SSE_TOKEN_PATH);
  const start = (env: Record<string, string>) => Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: appDir, stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true,
    env: { ...process.env, ...env, BARA_HF_CACHE_DIR: join(appDir, "assets/hf-cache"), BARA_KIWI_MODEL_DIR: join(appDir, "assets/kiwi-model"), MEMORY_STATIC: join(appDir, "web") },
  });
  report.stage = "start-cores";
  aProcess = start(a.env); bProcess = start(b.env);
  await Promise.all([ready(aBase, aProcess), ready(bBase, bProcess)]);
  check("twoRealCoresReady", true);

  // Ensure both databases allocate the same numeric ID to different authored memories.
  const bStored = await requestJson(bBase, bTokens.clientToken, "POST", "/ingest", { requestId: randomUUID(), source: "pet", content: { type: "text", data: "서버 B의 파란 지도는 남쪽 선반에 있다." } }, ctx.signal, 60_000) as { originNodeId: number };
  let notifyPaused!: () => void;
  const paused = new Promise<void>(resolve => { notifyPaused = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const source = new URL(request.url);
    const upstream = await fetch(new URL(`${source.pathname}${source.search}`, aBase), {
      method: request.method, headers: request.headers, redirect: "error", signal: request.signal,
      ...(request.method === "POST" || request.method === "PATCH" ? { body: await request.arrayBuffer() } : {}),
    });
    const bytes = await upstream.arrayBuffer();
    if (request.method === "POST" && source.pathname === "/ingest") { notifyPaused(); await resume; }
    return new Response(bytes, { status: upstream.status, headers: upstream.headers });
  } });
  const proxyBase = `http://127.0.0.1:${proxy.port}`;
  const config = new ConfigStore({ dataDir: join(temp, "pet"), resourceDir: temp, bunPath: process.execPath }, new DpapiVault());
  const aSettings = await config.save({ connection: { mode: "existing", baseUrl: proxyBase }, token: aTokens.clientToken });
  const audienceA = connectionAudience(aSettings.connection);
  const client = new MemoryClient(config, new CredentialRoutes(new LocalServer()));
  const requestId = randomUUID();
  report.stage = "switch-during-save";
  const saving = client.save({ audience: audienceA, requestId, content: "서버 A의 붉은 지도는 북쪽 선반에 있다.", kind: null }, ctx);
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([paused, new Promise<never>((_, reject) => { pauseTimer = setTimeout(() => reject(new Error("POST pause timeout")), 90_000); })]); }
  finally { if (pauseTimer) clearTimeout(pauseTimer); }
  const bSettings = await config.save({ connection: { mode: "existing", baseUrl: bBase }, token: bTokens.clientToken });
  const audienceB = connectionAudience(bSettings.connection);
  release?.(); release = undefined;
  const saved = await saving;
  check("directSwitchRefusesFollowupOnB", saved.state === "saved" && saved.audience === audienceA && saved.memory === undefined);
  const aReceipt = await requestJson(aBase, aTokens.clientToken, "GET", `/ingest/status/${requestId}`, undefined, ctx.signal) as { state: string; result: { originNodeId: number } };
  const aId = aReceipt.result.originNodeId;
  check("sameNumericIdOnB", aReceipt.state === "saved" && aId === bStored.originNodeId);
  const bMemory = await client.get(bStored.originNodeId, ctx, audienceB);
  check("newServerHasDistinctRecord", bMemory.content.includes("파란 지도"));

  async function blocked(work: () => Promise<unknown>): Promise<boolean> {
    try { await work(); return false; }
    catch (error) { return !!error && typeof error === "object" && "code" in error && error.code === "CONNECTION_CHANGED"; }
  }
  check("oldGetBlocked", await blocked(() => client.get(aId, ctx, audienceA)));
  check("oldReceiptBlocked", await blocked(() => client.status(requestId, ctx, audienceA)));
  check("oldEditBlocked", await blocked(() => client.update({ id: aId, audience: audienceA, content: "잘못된 대상 수정" }, ctx)));
  check("oldDashboardLinkBlocked", await blocked(() => config.dashboardLink((connection) => client.assertSendable(connection), aId, false, audienceA)));

  report.stage = "same-url-different-ssh";
  const ssh = { host: "fixture.example", port: 22, user: "ubuntu", keyPath: "C:\\fixture-key", fingerprint: `SHA256:${"A".repeat(43)}` };
  let portReuseRejected = false;
  try { await config.save({ connection: { mode: "existing", baseUrl: bBase, ssh }, token: bTokens.clientToken }); }
  catch (error) { portReuseRejected = !!error && typeof error === "object" && "code" in error && error.code === "CONNECTION_ORIGIN_RESERVED"; }
  check("sameUrlDirectToSshRetargetBlocked", portReuseRejected && (await client.get(bStored.originNodeId, ctx, audienceB)).content.includes("파란 지도"));
  report.outcome = "passed"; report.stage = "complete";
} catch (error) {
  report.errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "AUDIENCE_E2E_FAILURE";
  process.exitCode = 1;
} finally {
  release?.(); proxy?.stop(true);
  for (const child of [aProcess, bProcess]) if (child) { child.kill(); await Promise.race([child.exited, Bun.sleep(5_000)]); }
  await mkdir(resolve(import.meta.dir, "../.omx/e2e"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await rm(temp, { recursive: true, force: true });
  console.log(JSON.stringify({ outcome: report.outcome, stage: report.stage, errorCode: report.errorCode, checks: Object.keys(checks).length, reportPath }));
}
