/** Run manually: bun run tests/e2e-service.ts ABSOLUTE_CORE_WORKTREE. Uses only temporary data. */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { connectionAudience, DEFAULT_AI_URLS } from "../src/shared/contracts.ts";
import { Database } from "bun:sqlite";
import { ConfigStore } from "../src/service/config.ts";
import { CredentialRoutes } from "../src/service/install/credential-routes.ts";
import { LocalServer } from "../src/service/install/local-server.ts";
import { MemoryClient, requestJson } from "../src/service/client.ts";
import { Assistant } from "../src/service/assistant.ts";
import { CleanupService, parseProposalDecision, type Candidate } from "../src/service/cleanup.ts";
import { McpClient, parseMcpResponse } from "../src/service/mcp.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";
import type { RequestContext } from "../src/shared/contracts.ts";

const core = resolve(Bun.argv[2] ?? "");
if (!existsSync(join(core, "apps", "memory", "src", "index.ts"))) throw new Error("Pass the absolute repository root as the first argument");
if (process.platform !== "win32") throw new Error("This integration check requires Windows DPAPI");
const tempRoot = resolve(tmpdir());
const temporary = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tempRoot, "bara-pet-service-e2e-")));
if (!resolve(temporary).startsWith(`${tempRoot}${sep}`)) throw new Error("Temporary workspace escaped the temp root");
const reportPath = resolve(import.meta.dir, "../.omx/e2e/service-report.json");
const report: Record<string, unknown> = { outcome: "failed", stage: "prepare", temporaryData: true, tests: {} };
let server: Bun.Subprocess | undefined;

const freePort = () => { const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") }); const port = listener.port; listener.stop(true); return port; };
const waitForHealth = async (baseUrl: string, child: Bun.Subprocess) => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Core process exited before health");
    try { if ((await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) })).ok) return; } catch {}
    await Bun.sleep(1000);
  }
  throw new Error("Core startup exceeded 180 seconds");
};
const OPTIONAL_OLLAMA_MODEL = "qwen3:4b-instruct";
/** The optional local-model step runs only when the local Ollama lists the model. An Ollama nobody listens on
 * or without the model is reported as not attempted, with the reason kept in the report and the summary line;
 * an Ollama that answers with an error is not "absent", so that throws and fails the run. */
const probeOllama = async (): Promise<{ available: true } | { available: false; reason: string }> => {
  let response: Response;
  try { response = await fetch(`${DEFAULT_AI_URLS.ollama}/api/tags`, { signal: AbortSignal.timeout(1500) }); }
  catch { return { available: false, reason: "ollama-unreachable" }; }
  if (!response.ok) throw new Error(`Ollama /api/tags answered HTTP ${response.status}`);
  const tags = await response.json() as { models?: Array<{ name?: string }> };
  return tags.models?.some((model) => model.name === OPTIONAL_OLLAMA_MODEL) ? { available: true } : { available: false, reason: "model-unavailable" };
};
const context: RequestContext = { signal: new AbortController().signal, progress() {} };
const check = (name: string, value: boolean) => { assert(value, name); (report.tests as Record<string, boolean>)[name] = true; };

try {
  const appDir = join(core, "apps", "memory");
  const { prepareManagedMemory } = await import(pathToFileURL(join(core, "apps", "setup", "src", "managed-prepare.ts")).href);
  const { prepareClientTokens } = await import(pathToFileURL(join(core, "apps", "setup", "src", "client-token.ts")).href);
  const port = freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const prepared = prepareManagedMemory({ dataDir: join(temporary, "server"), port });
  // Real SQLite fixtures that meet personLink's source, person, and metadata gates.
  const personId = `psn_${randomUUID()}`;
  const seed = new Database(prepared.env.MEMORY_DB_PATH);
  seed.prepare("INSERT INTO persons (person_id, display_name, aliases) VALUES (?, ?, '[]')").run(personId, "가상민수");
  const candidateIds = ["가상민수와 모델 검토 회의했다.", "가상민수는 테스트 시설을 방문했다."].map((content) => Number(seed.prepare("INSERT INTO knowledge_nodes (content, source_type, metadata_json) VALUES (?, 'llm_extract', ?)").run(content, JSON.stringify({ personCandidates: ["가상민수"] })).lastInsertRowid));
  seed.close();
  const issued = await prepareClientTokens(`${baseUrl}/`, prepared.env.SSE_TOKEN_PATH);
  report.stage = "start-core";
  server = Bun.spawn([process.execPath, "run", "src/index.ts"], { cwd: appDir, stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true,
    env: { ...process.env, ...prepared.env,
      BARA_HF_CACHE_DIR: join(appDir, "assets", "hf-cache"),
      BARA_KIWI_MODEL_DIR: join(appDir, "assets", "kiwi-model"),
      MEMORY_STATIC: join(appDir, "web") } });
  await waitForHealth(baseUrl, server);
  check("realCoreReady", true);

  report.stage = "enroll";
  const vault = new DpapiVault();
  const config = new ConfigStore({ dataDir: join(temporary, "pet"), resourceDir: temporary, bunPath: process.execPath }, vault);
  const settings = await config.save({ ownerToken: issued.dashboardUrl });
  const audience = connectionAudience(settings.connection);
  check("ownerLinkRedacted", settings.connection.baseUrl === baseUrl && settings.hasOwnerToken && !settings.hasToken && !JSON.stringify(settings).includes(issued.ownerToken));
  const client = new MemoryClient(config, new CredentialRoutes(new LocalServer()));
  const authRetryId = randomUUID();
  const authRetryInput = { requestId: authRetryId, audience, content: "테스트용 인증 재시도 문장입니다.", kind: null };
  const noAuthSave = await client.save(authRetryInput, context);
  check("missingAuthRejectedBeforeWrite", noAuthSave.state === "rejected");
  const enrolled = await client.enrollmentStart(context);
  const scoped = await config.getToken();
  check("ownerApprovedScopedEnrollment", enrolled.state === "approved" && !!scoped && scoped !== issued.ownerToken);
  const info = await client.info(context.signal);
  check("clientInfoV1", info.connected && info.protocolVersion === 1 && info.capabilities?.includes("capture") === true);
  const authRetried = await client.save(authRetryInput, context);
  check("sameUuidAfterAuthCorrectionSaved", authRetried.state === "saved" && !!authRetried.memory);
  let wrongScopeDenied = false;
  try { await requestJson(baseUrl, scoped, "POST", "/adapter-tokens/atr-authored/approve", { scope: "full" }, context.signal); }
  catch (error) { wrongScopeDenied = error instanceof Error && "code" in error && error.code === "FORBIDDEN"; }
  check("scopedTokenCannotApprove", wrongScopeDenied);

  report.stage = "memory";
  const assistant = new Assistant(config, client);
  const guardRequestId = randomUUID();
  const guardDenied = await client.save({ requestId: guardRequestId, audience, content: "테스트용 api_key = AAAAAAAAAAAAAAAA", kind: null }, context);
  check("writeGuardRejectedBeforeWrite", guardDenied.state === "rejected");
  const guardRetried = await client.save({ requestId: guardRequestId, audience, content: "테스트용 비밀값 경고 후 수정한 안전한 문장입니다.", kind: null }, context);
  check("sameUuidAfterBodyCorrectionSaved", guardRetried.state === "saved" && !!guardRetried.memory);
  let aiCalls = 0, aiFail = false;
  const localAi = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname !== "/api/chat") return new Response("", { status: 404 });
    aiCalls++;
    return aiFail ? new Response("", { status: 503 }) : Response.json({ message: { content: '{"kind":"idea"}' } });
  } });
  try {
    await config.save({ ai: { provider: "ollama", baseUrl: `http://127.0.0.1:${localAi.port}`, model: "authored-fixture" } });
    const autoAssistant = new Assistant(config, client);
    const guardedAuto = await autoAssistant.save({ requestId: randomUUID(), audience, content: "테스트용 api_key = AAAAAAAAAAAAAAAA", autoClassify: true }, context);
    check("writeGuardRunsBeforeAnyAiCall", guardedAuto.state === "rejected" && aiCalls === 0);
    const classified = await autoAssistant.save({ requestId: randomUUID(), audience, content: "새로운 가상 프로젝트의 아이디어를 기록한다.", autoClassify: true }, context);
    check("savedThenAiCapturePatch", classified.state === "saved" && classified.memory?.metadata?.capture?.source === "ai" && classified.memory.metadata.capture.kind === "idea" && aiCalls === 1);
    aiFail = true;
    const afterAiFailure = await autoAssistant.save({ requestId: randomUUID(), audience, content: "AI 장애에도 남겨야 하는 가상 메모다.", autoClassify: true }, context);
    check("aiFailureKeepsConfirmedSave", afterAiFailure.state === "saved" && afterAiFailure.memory?.metadata?.capture === undefined && aiCalls === 2 && afterAiFailure.classification?.outcome === "failed" && !!afterAiFailure.classification.reason);
  } finally { localAi.stop(true); await config.save({ ai: { provider: "none", baseUrl: "", model: "" } }); }
  const firstId = randomUUID();
  const firstContent = "테스트용 무지개 항성지도는 보라색 보관함에 있다.";
  const first = await assistant.save({ requestId: firstId, audience, content: firstContent, kind: null, autoClassify: true }, context);
  check("unclassifiedSaved", first.state === "saved" && !!first.memory && first.memory.metadata?.capture === undefined);
  const confirmed = await client.status(firstId, context, audience);
  check("receiptSaved", confirmed.state === "saved" && confirmed.memory?.id === first.memory?.id);
  const repeated = await client.save({ requestId: firstId, audience, content: firstContent, kind: null }, context);
  check("receiptIdempotent", repeated.state === "saved" && repeated.memory?.id === first.memory?.id);
  const absent = await client.status(randomUUID(), context, audience);
  check("missingReceiptUnknown", absent.state === "unknown");

  const second = await assistant.save({ requestId: randomUUID(), audience, content: "테스트용 푸른 수집기의 새 배치 아이디어를 보관한다.", kind: "idea" }, context);
  check("explicitCaptureSaved", second.state === "saved" && second.memory?.metadata?.capture?.kind === "idea" && second.memory.metadata.capture.source === "user");
  const changed = await client.update({ id: second.memory!.id, audience, content: "테스트용 푸른 수집기는 북쪽 선반에 보관한다.", expectedRevision: 0, capture: null }, context);
  check("revisionZeroEditAndUnclassify", changed.revision === 1 && changed.metadata?.capture === undefined);
  const tagged = await client.save({ requestId: randomUUID(), audience, content: "가상 문서의 위치는 서쪽 선반이다. #fixturetag", kind: null }, context);
  assert(tagged.state === "saved" && tagged.memory, "tagged input saved");
  const taggedRead = await client.get(tagged.memory.id, context, audience);
  check("editableBodyExcludesTags", taggedRead.content.includes("#fixturetag") && typeof taggedRead.editableContent === "string" && !taggedRead.editableContent.includes("#fixturetag"));
  const recaptured = await client.update({ id: taggedRead.id, audience, expectedRevision: taggedRead.revision, capture: { kind: "task", source: "user" } }, context);
  check("captureOnlyKeepsRawTags", recaptured.content.includes("#fixturetag") && recaptured.metadata?.capture?.kind === "task" && recaptured.revision === 1);
  const bodyEdited = await client.update({ id: taggedRead.id, audience, expectedRevision: recaptured.revision, content: "가상 문서의 위치는 동쪽 선반이다." }, context);
  check("bodyEditPreservesExistingTags", bodyEdited.content.includes("동쪽 선반") && bodyEdited.content.includes("#fixturetag") && bodyEdited.editableContent === "가상 문서의 위치는 동쪽 선반이다.");
  const found = await client.search("무지개 항성지도 보라색 보관함", context);
  check("realSearch", found.results.some((hit) => hit.memory.id === first.memory?.id));
  const ask = await assistant.ask("무지개 항성지도는 어디에 있나?", context, audience);
  check("searchOnlyGrounded", ask.generated === false && ask.sources.some((memory) => memory.id === first.memory?.id));

  report.stage = "uncertain-transport";
  let postCount = 0, statusCount = 0;
  const uncertainServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/ingest") { postCount++; return Response.json({ error: "response lost after dispatch" }, { status: 500 }); }
    if (request.method === "GET" && path.startsWith("/ingest/status/")) { statusCount++; return Response.json({ state: "unknown" }); }
    return new Response("", { status: 404 });
  } });
  try {
    const faultConfig = new ConfigStore({ dataDir: join(temporary, "fault-pet"), resourceDir: temporary, bunPath: process.execPath }, new DpapiVault());
    const faultSettings = await faultConfig.save({ connection: { mode: "existing", baseUrl: `http://127.0.0.1:${uncertainServer.port}` }, token: "authored-fault-token" });
    const uncertain = await new MemoryClient(faultConfig, new CredentialRoutes(new LocalServer())).save({ requestId: randomUUID(), audience: connectionAudience(faultSettings.connection), content: "응답 유실 시 재전송을 금지하는 테스트 문장", kind: null }, context);
    check("unknownNeverAutoReposts", uncertain.state === "unknown" && postCount === 1 && statusCount === 1);
  } finally { uncertainServer.stop(true); }

  report.stage = "mcp";
  const mcp = new McpClient(baseUrl, scoped!, context.signal, () => client.assertSendable(settings.connection));
  const toolNames = new Set((await mcp.listTools()).map((tool) => tool.name));
  check("realMcpTools", ["cleanup_list_candidates", "cleanup_submit_proposal", "cleanup_report_no_finding"].every((name) => toolNames.has(name)));
  const counts: Record<string, number> = {};
  for (const stage of ["regexStrengthen", "personLink", "lensDraft"] as const) {
    const list = await mcp.call("cleanup_list_candidates", { stage, limit: 3 });
    assert(list.stage === stage && Array.isArray(list.candidates), `${stage} candidate response`);
    counts[stage] = list.candidates.length;
  }
  report.candidateCounts = counts;
  check("cleanupCandidatesWithoutServerLlm", Object.keys(counts).length === 3);

  report.stage = "cleanup-proposal";
  const personList = await mcp.call("cleanup_list_candidates", { stage: "personLink", limit: 3 });
  const personCandidates = personList.candidates as Candidate[];
  check("realPersonCandidates", personCandidates.length >= 2 && candidateIds.every((id) => personCandidates.some((candidate) => candidate.targetKey === String(id))) && personCandidates.every((candidate) => (candidate.content.topKPersonIds as string[]).includes(personId)));
  const candidate = personCandidates.find((entry) => entry.targetKey === String(candidateIds[1]))!;
  const personPayload = { nodeId: candidate.content.nodeId, personId };
  const altered = `${candidate.inputFingerprint[0] === "0" ? "1" : "0"}${candidate.inputFingerprint.slice(1)}`;
  const rpcId = 911;
  const staleResponse = await fetch(`${baseUrl}/mcp`, { method: "POST", redirect: "error", signal: context.signal,
    headers: { authorization: `Bearer ${scoped}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name: "cleanup_submit_proposal", arguments: { kind: "person_link", payload: personPayload,
      candidate: { stage: "personLink", targetKey: candidate.targetKey, inputFingerprint: altered, stageVersion: candidate.stageVersion } } } }) });
  assert(staleResponse.ok, "stale proposal MCP transport");
  const staleEnvelope = parseMcpResponse(await staleResponse.text(), staleResponse.headers.get("content-type") ?? "", rpcId) as { isError?: boolean; content?: Array<{ text?: string }> };
  const staleError = JSON.parse(staleEnvelope.content?.[0]?.text ?? "null") as { code?: string } | null;
  check("staleFingerprintRejected", staleEnvelope.isError === true && staleError?.code === "STALE_CANDIDATE");

  await config.save({ cleanup: { provider: "codex", model: "" } });
  const cleanup = new CleanupService(config, client);
  const frontier = await cleanup.run({ limit: 1 }, context); // one actual tool-free Codex decision
  const rejected = frontier.rejected ?? 0; // present only when the server's quality checks turned a rule down
  report.frontier = { submitted: frontier.submitted, noFinding: frontier.noFinding, skipped: frontier.skipped, rejected };
  check("restrictedFrontierProcessedCandidate", frontier.submitted + frontier.noFinding + rejected === 1 && frontier.skipped === 0);
  if (frontier.submitted === 1) {
    const db = new Database(prepared.env.MEMORY_DB_PATH, { readonly: true });
    const proposal = db.prepare("SELECT id, status FROM cleanup_proposals WHERE kind = 'person_link' AND CAST(payload_json ->> '$.nodeId' AS INTEGER) = ?").get(candidateIds[0]) as { id?: string; status?: string } | null;
    const edgeCount = (db.prepare("SELECT COUNT(*) AS count FROM node_person_edges WHERE node_id = ?").get(candidateIds[0]) as { count: number }).count;
    db.close();
    check("frontierProposalPendingWithoutMutation", typeof proposal?.id === "string" && proposal.status === "pending" && edgeCount === 0);
  }
  if (frontier.noFinding === 1) {
    const db = new Database(prepared.env.MEMORY_DB_PATH, { readonly: true });
    const ledger = db.prepare("SELECT status FROM cleanup_stage_results WHERE stage = 'person_link' AND target_key = ?").get(String(candidateIds[0])) as { status?: string } | null;
    db.close();
    check("frontierNoFindingRecorded", ledger?.status === "completed_noop");
  }

  // Independently authored fixture proves proposal submission even if the model judges no finding.
  const authored = parseProposalDecision("personLink", candidate, { finding: true, payload: { personId } });
  assert(authored.finding, "authored proposal validation");
  const proposed = await mcp.call("cleanup_submit_proposal", { kind: authored.kind, payload: authored.payload,
    candidate: { stage: "personLink", targetKey: candidate.targetKey, inputFingerprint: candidate.inputFingerprint, stageVersion: candidate.stageVersion } });
  assert(typeof proposed.proposalId === "string", "proposal id");
  const proposalId = proposed.proposalId as string;
  const pending = await cleanup.list(context);
  check("validProposalPending", proposed.status === "pending" && pending.some((entry) => entry.id === proposalId && entry.status === "pending"));
  let approvalDenied = false;
  try { await requestJson(baseUrl, scoped, "POST", `/cleanup-proposals/${proposalId}/approve`, {}, context.signal); }
  catch (error) { approvalDenied = error instanceof Error && "code" in error && error.code === "FORBIDDEN"; }
  const verifyDb = new Database(prepared.env.MEMORY_DB_PATH, { readonly: true });
  const linkCount = (verifyDb.prepare("SELECT COUNT(*) AS count FROM node_person_edges WHERE node_id IN (?, ?)").get(...candidateIds) as { count: number }).count;
  const proposalStatus = (verifyDb.prepare("SELECT status FROM cleanup_proposals WHERE id = ?").get(proposalId) as { status?: string } | null)?.status;
  verifyDb.close();
  check("scopedCannotSelfApproveOrMutate", approvalDenied && linkCount === 0 && proposalStatus === "pending");

  report.stage = "optional-ollama";
  const ollama = await probeOllama();
  if (ollama.available) {
    await config.save({ ai: { provider: "ollama", baseUrl: DEFAULT_AI_URLS.ollama, model: OPTIONAL_OLLAMA_MODEL } });
    const localAnswer = await assistant.ask("무지개 항성지도는 어디에 있나?", context, audience);
    const grounded = localAnswer.generated && localAnswer.sources.some((memory) => memory.id === first.memory?.id);
    report.optionalOllama = { attempted: true, grounded };
    check("optionalOllamaGrounded", grounded);
  } else report.optionalOllama = { attempted: false, reason: ollama.reason };
  report.stage = "complete";
  report.outcome = "passed";
} catch (error) {
  report.errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "E2E_FAILURE";
  process.exitCode = 1;
} finally {
  if (server) { server.kill(); await Promise.race([server.exited, Bun.sleep(5000)]); }
  await mkdir(resolve(import.meta.dir, "../.omx/e2e"), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ outcome: report.outcome, stage: report.stage, errorCode: report.errorCode, tests: Object.keys(report.tests as object).length, optionalOllama: report.optionalOllama, reportPath }));
}
