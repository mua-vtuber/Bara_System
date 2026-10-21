import { connectionAudience, type CleanupFailure, type CleanupProposal, type CleanupRejection, type CleanupResult, type CleanupSkippedName, type RequestContext } from "../shared/contracts.ts";
import { AiClient } from "./ai.ts";
import { HTTP_STATUS_FAILURE_CODES, MemoryClient, requestJson } from "./client.ts";
import { runCliJson } from "./cli.ts";
import { ConfigStore } from "./config.ts";
import { ServiceError, serviceError } from "./errors.ts";
import { causeOf, FETCH_FAILURE_CODES } from "./fetch-failure.ts";
import { parseEntityRegisterDecision, type SkippedEntityName } from "./cleanup-entity-register.ts";
import { cliPrompt, cliStageInstruction, hasServerInstruction, ownStageInstruction, PROPOSAL_JSON_MAX_CHARS } from "./cleanup-instruction.ts";
import { parseRegexStrengthenDecision } from "./cleanup-regex-strengthen.ts";
import { McpClient, type McpTool } from "./mcp.ts";
import { messages } from "../ui/messages.ts";

export type CleanupStage = "regexStrengthen" | "entityRegister" | "personLink" | "lensDraft";
export interface Candidate { targetKey: string; inputFingerprint: string; stageVersion: number; content: Record<string, unknown> }
type Decision = { finding: false } | { finding: true; kind: "regex_pattern_add" | "entity_register" | "person_link" | "lens_draft"; payload: Record<string, unknown>; skippedNames?: SkippedEntityName[] };
// entityRegister is last so the existing stages keep their turn while the backlog of all existing memos drains.
const STAGES: CleanupStage[] = ["regexStrengthen", "personLink", "lensDraft", "entityRegister"];
/** The per-memo stages "입력한 메모 바로 정리" runs (the others need the whole store, not one memo). */
const ON_SAVE_STAGES: readonly CleanupStage[] = ["entityRegister", "personLink"];
const KINDS = { regexStrengthen: "regex_pattern_add", entityRegister: "entity_register", personLink: "person_link", lensDraft: "lens_draft" } as const;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const exact = (value: Record<string, unknown>, names: string[]): boolean => Object.keys(value).every((key) => names.includes(key));

export function parseProposalDecision(stage: CleanupStage, candidate: Candidate, value: unknown): Decision {
  const decision = record(value);
  if (!decision || !exact(decision, ["finding", "payload", "payloadJson"]) || typeof decision.finding !== "boolean") throw serviceError("AI_PROPOSAL", messages.cleanupService.proposalFormat);
  if (("payload" in decision) === ("payloadJson" in decision)) throw serviceError("AI_PROPOSAL", messages.cleanupService.proposalFormat);
  let decoded: unknown = decision.payload;
  if (typeof decision.payloadJson === "string") {
    if (decision.payloadJson.length > PROPOSAL_JSON_MAX_CHARS) throw serviceError("AI_PROPOSAL", messages.cleanupService.proposalTooLarge);
    try { decoded = JSON.parse(decision.payloadJson); } catch { throw serviceError("AI_PROPOSAL", messages.cleanupService.proposalJsonUnreadable); }
  }
  const raw = record(decoded);
  if (!raw) throw serviceError("AI_PROPOSAL", messages.cleanupService.proposalFormat);
  const content = record(candidate.content);
  if (!content || !candidate.targetKey || !Number.isSafeInteger(candidate.stageVersion) || candidate.stageVersion < 0 || !/^[a-f0-9]{64}$/.test(candidate.inputFingerprint)) throw serviceError("CANDIDATE_INVALID", messages.cleanupService.candidateUnreadable);
  if (!decision.finding) {
    if (Object.keys(raw).length > 0) throw serviceError("AI_PROPOSAL", messages.cleanupService.noFindingHasProposal);
    return { finding: false };
  }
  if (stage === "entityRegister") return parseEntityRegisterDecision(candidate, raw);
  if (stage === "personLink") {
    const nodeId = content.nodeId;
    if (!exact(raw, ["personId"]) || typeof raw.personId !== "string" || !Array.isArray(content.topKPersonIds) || !content.topKPersonIds.includes(raw.personId) || !Number.isSafeInteger(nodeId) || String(nodeId) !== candidate.targetKey) throw serviceError("AI_PROPOSAL", messages.cleanupService.personLinkUnconfirmed);
    return { finding: true, kind: "person_link", payload: { nodeId, personId: raw.personId } };
  }
  if (stage === "regexStrengthen") return parseRegexStrengthenDecision(candidate, raw);
  if (!exact(raw, ["values"]) || !record(raw.values) || typeof content.typeName !== "string" || typeof content.entityId !== "string" || `${content.typeName}\u001f${content.entityId}` !== candidate.targetKey || !Array.isArray(content.emptyColumnKeys)) throw serviceError("AI_PROPOSAL", messages.cleanupService.entityEnrichUnconfirmed);
  const values = record(raw.values)!;
  const columns = record(values.columns);
  if (!exact(values, ["columns", "labels", "relations", "metadata"]) || !columns || !record(values.labels) || !record(values.relations) || !record(values.metadata) || Object.keys(columns).length === 0 || JSON.stringify(values).length > PROPOSAL_JSON_MAX_CHARS || Object.keys(columns).some((key) => !(content.emptyColumnKeys as unknown[]).includes(key)) || Object.values(columns).some((entry) => !["string", "number", "boolean"].includes(typeof entry)) || Object.keys(record(values.labels)!).length || Object.keys(record(values.relations)!).length || Object.keys(record(values.metadata)!).length) throw serviceError("AI_PROPOSAL", messages.cleanupService.entityEnrichUnconfirmed);
  return { finding: true, kind: "lens_draft", payload: { typeName: content.typeName, entityId: content.entityId, values } };
}

const OUTPUT_SCHEMA: Record<string, unknown> = { type: "object", additionalProperties: false, required: ["finding", "payloadJson"], properties: { finding: { type: "boolean" }, payloadJson: { type: "string" } } };
function candidateRef(stage: CleanupStage, candidate: Candidate): Record<string, unknown> {
  return { stage, targetKey: candidate.targetKey, inputFingerprint: candidate.inputFingerprint, stageVersion: candidate.stageVersion };
}

/** What the cleanup server did with one submitted proposal. */
export type SubmitResult = { outcome: "submitted" } | { outcome: "rejected"; reason: string; detail: string };
/** Reads the `cleanup_submit_proposal` answer for a proposal of `kind`: a proposal id, a `null` id only for
 * entity_register (the server applied the answer without queueing anything), or, only for regex_pattern_add,
 * a rejection by the server's quality checks with its reason. Any other answer is not counted as a success. */
export function parseSubmitResponse(kind: (typeof KINDS)[CleanupStage], value: Record<string, unknown>): SubmitResult {
  const unreadable = () => serviceError("MCP_RESPONSE", messages.cleanupService.submitResponseUnreadable);
  if ("rejected" in value) {
    const rejected = record(value.rejected);
    if (kind !== "regex_pattern_add" || value.proposalId !== null || !rejected || typeof rejected.reason !== "string" || !rejected.reason || typeof rejected.detail !== "string") throw unreadable();
    return { outcome: "rejected", reason: rejected.reason, detail: rejected.detail };
  }
  if (typeof value.proposalId === "string" || (value.proposalId === null && kind === "entity_register")) return { outcome: "submitted" };
  throw unreadable();
}
/** Whether the connected server's candidate tool offers `stage` in its enum (an older server does not know a newer stage). */
export function stageSupported(tool: McpTool | undefined, stage: CleanupStage): boolean {
  const stageSchema = record(record(tool?.inputSchema.properties)?.stage);
  return Array.isArray(stageSchema?.enum) && stageSchema!.enum.includes(stage);
}
function verifyTool(tool: McpTool | undefined, fields: string[]): void {
  const properties = record(tool?.inputSchema.properties);
  if (!tool || tool.inputSchema.type !== "object" || !properties || fields.some((field) => !(field in properties))) throw serviceError("MCP_SCHEMA", messages.cleanupService.toolInputMismatch);
}

/** The codes of a request to the cleanup AI's own server (Ollama or an OpenAI-compatible one) that failed:
 * under a `CLEANUP_AI_` prefix, so the cleanup screen names the cleanup AI and the failure never reads as
 * the cleanup server's (`MCP_FAILURE_CODES`), as the memory server's (`AUTH_REQUIRED`: "server
 * authentication needed") or as a bare code. */
export const CLEANUP_AI_FAILURE_CODES = {
  network: "CLEANUP_AI_NETWORK", timeout: "CLEANUP_AI_TIMEOUT", redirect: "CLEANUP_AI_REDIRECT",
  authRequired: "CLEANUP_AI_AUTH_REQUIRED", forbidden: "CLEANUP_AI_FORBIDDEN", httpFailed: "CLEANUP_AI_HTTP_FAILED",
  response: "CLEANUP_AI_RESPONSE", unexpected: "CLEANUP_AI_REQUEST_UNEXPECTED",
} as const;
/** Every code `requestJson` gives an HTTP answer other than a success, read from its own list. */
const HTTP_STATUS_FAILURES: ReadonlySet<string> = new Set(Object.values(HTTP_STATUS_FAILURE_CODES));

/** A failure of the cleanup AI's decision call, with every code of a failed request renamed to the cleanup
 * AI's and given a text that says so. Only what the cleanup AI's server did is renamed: a cancellation, the
 * Pet's own settings check (`AI_NOT_CONFIGURED`) and the reading of the model's answer (`AI_RESPONSE`) pass
 * through unchanged, as does everything that is not a `ServiceError`. The two that carry a cause sentence
 * (an answer that is not HTTP or cannot be read, an exception no code names) keep the request layer's own
 * sentence, which `causeOf` already checked. */
export function cleanupAiFailure(error: unknown): unknown {
  if (!(error instanceof ServiceError)) return error;
  const text = messages.cleanupService.aiServer;
  if (error.code === FETCH_FAILURE_CODES.network) return serviceError(CLEANUP_AI_FAILURE_CODES.network, text.networkFailed);
  if (error.code === FETCH_FAILURE_CODES.timeout) return serviceError(CLEANUP_AI_FAILURE_CODES.timeout, text.timedOut);
  if (error.code === FETCH_FAILURE_CODES.redirect) return serviceError(CLEANUP_AI_FAILURE_CODES.redirect, text.redirected);
  if (error.code === FETCH_FAILURE_CODES.unexpected) return serviceError(CLEANUP_AI_FAILURE_CODES.unexpected, text.failedWith(error.publicMessage));
  if (error.code === HTTP_STATUS_FAILURE_CODES.authRequired) return serviceError(CLEANUP_AI_FAILURE_CODES.authRequired, text.authRejected);
  if (error.code === HTTP_STATUS_FAILURE_CODES.forbidden) return serviceError(CLEANUP_AI_FAILURE_CODES.forbidden, text.forbidden);
  if (error.code === "SERVER_RESPONSE") return serviceError(CLEANUP_AI_FAILURE_CODES.response, text.failedWith(error.publicMessage));
  // Every other status the request was answered with (401 and 403 are named above).
  if (HTTP_STATUS_FAILURES.has(error.code)) return serviceError(CLEANUP_AI_FAILURE_CODES.httpFailed, text.httpFailed);
  return error;
}

/** One skipped stage or candidate as the screen lists it. An exception no service code names keeps its own
 * cause sentence, built the one way every cause sentence is (`causeOf`). */
function failureOf(stage: CleanupStage, error: unknown): CleanupFailure {
  return error instanceof ServiceError ? { stage, code: error.code, message: error.publicMessage } : { stage, code: "UNKNOWN", message: causeOf(error) };
}

export class CleanupService {
  private readonly ai: AiClient;
  constructor(private readonly config: ConfigStore, private readonly client: MemoryClient) { this.ai = new AiClient(config); }

  async list(ctx: RequestContext): Promise<CleanupProposal[]> {
    const { settings, token } = await this.config.snapshot();
    const audience = connectionAudience(settings.connection);
    if (!token) throw serviceError("AUTH_REQUIRED", messages.serverClient.tokenMissing);
    await this.client.assertSendable(settings.connection);
    const response = record(await requestJson(settings.connection.baseUrl, token, "GET", "/cleanup-proposals?status=pending&limit=100", undefined, ctx.signal));
    if (!response || !Array.isArray(response.proposals)) throw serviceError("SERVER_RESPONSE", messages.cleanupService.proposalListUnreadable);
    return response.proposals.map((item: unknown) => {
      const proposal = record(item);
      if (!proposal || typeof proposal.id !== "string" || typeof proposal.kind !== "string" || typeof proposal.status !== "string") throw serviceError("SERVER_RESPONSE", messages.cleanupService.proposalListUnreadable);
      return { id: proposal.id, kind: proposal.kind, status: proposal.status, summary: typeof proposal.summary === "string" ? proposal.summary : proposal.kind, audience };
    });
  }

  async run({ limit = 10 }: { limit?: number }, ctx: RequestContext): Promise<CleanupResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw serviceError("INVALID_INPUT", messages.cleanupService.limitRange);
    return this.runStages(STAGES, { limit }, ctx);
  }

  /** One memo right after it was saved: the per-memo stages only, candidates limited to this memo. */
  async runForMemo(memoryId: number, signal: AbortSignal): Promise<CleanupResult> {
    const ctx: RequestContext = { signal, progress: () => {} };
    return this.runStages(ON_SAVE_STAGES, { limit: ON_SAVE_STAGES.length, nodeIds: [memoryId] }, ctx);
  }

  private async runStages(stages: readonly CleanupStage[], { limit, nodeIds }: { limit: number; nodeIds?: number[] }, ctx: RequestContext): Promise<CleanupResult> {
    const { settings, token } = await this.config.snapshot();
    const audience = connectionAudience(settings.connection);
    if (!token) throw serviceError("AUTH_REQUIRED", messages.serverClient.tokenMissing);
    const provider = settings.cleanup.provider;
    if (provider === "none") throw serviceError("CLEANUP_NOT_CONFIGURED", messages.cleanupService.pickCleanupAi);
    if ((provider === "ollama" || provider === "openai-compatible") && (!settings.cleanup.model || settings.ai.provider !== provider || !settings.ai.baseUrl)) throw serviceError("AI_NOT_CONFIGURED", messages.cleanupService.serverAndModelNeeded);
    if (provider === "claude" || provider === "codex") {
      const probe = await this.ai.probe("cleanup", ctx);
      if (!probe.available) throw serviceError("CLI_UNAVAILABLE", probe.message);
    }
    const mcp = new McpClient(settings.connection.baseUrl, token, ctx.signal, () => this.client.assertSendable(settings.connection));
    const tools = await mcp.listTools();
    verifyTool(tools.find((tool) => tool.name === "cleanup_list_candidates"), nodeIds ? ["stage", "limit", "nodeIds"] : ["stage", "limit"]);
    verifyTool(tools.find((tool) => tool.name === "cleanup_submit_proposal"), ["kind", "payload", "candidate"]);
    verifyTool(tools.find((tool) => tool.name === "cleanup_report_no_finding"), ["stage", "targetKey", "inputFingerprint", "stageVersion"]);
    const listTool = tools.find((tool) => tool.name === "cleanup_list_candidates");
    let submitted = 0, noFinding = 0, skipped = 0, seen = 0;
    const failures: CleanupFailure[] = [];
    const skippedNames: CleanupSkippedName[] = [];
    const rejections: CleanupRejection[] = [];
    for (const stage of stages) {
      if (seen >= limit) break;
      ctx.signal.throwIfAborted();
      ctx.progress("cleanup");
      if (!stageSupported(listTool, stage)) {
        skipped++;
        failures.push({ stage, code: "SERVER_STAGE_UNSUPPORTED", message: messages.cleanupService.stageUnsupported });
        continue;
      }
      let listed: Record<string, unknown>;
      try { listed = await mcp.call("cleanup_list_candidates", { stage, limit: limit - seen, ...(nodeIds ? { nodeIds } : {}) }); }
      catch (error) {
        if (ctx.signal.aborted) throw error;
        skipped++;
        failures.push(failureOf(stage, error));
        continue;
      }
      if (listed.stage !== stage || !Array.isArray(listed.candidates)) throw serviceError("MCP_RESPONSE", messages.cleanupService.candidateListUnreadable);
      for (const item of listed.candidates) {
        if (seen >= limit) break;
        seen++;
        const raw = record(item);
        if (!raw || typeof raw.targetKey !== "string" || typeof raw.inputFingerprint !== "string" || !Number.isSafeInteger(raw.stageVersion) || !record(raw.content)) {
          skipped++;
          failures.push({ stage, code: "CANDIDATE_INVALID", message: messages.cleanupService.candidateUnreadable });
          continue;
        }
        const candidate = raw as unknown as Candidate;
        try {
          const { outcome, skippedNames: dropped } = await this.processCandidate(mcp, stage, candidate, listed.shared, provider, settings.cleanup.model, ctx);
          if (outcome === "noFinding") noFinding++;
          else if (outcome.outcome === "submitted") submitted++;
          else rejections.push({ stage, reason: outcome.reason, detail: outcome.detail });
          for (const name of dropped) skippedNames.push({ stage, ...name });
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          skipped++;
          failures.push(failureOf(stage, error));
        }
      }
    }
    return {
      submitted, noFinding, skipped, audience, failures,
      ...(skippedNames.length > 0 ? { skippedNames } : {}),
      ...(rejections.length > 0 ? { rejected: rejections.length, rejections } : {}),
    };
  }

  /** One candidate: build the instruction, ask the cleanup AI, check the answer, then submit it or report no finding.
   * A submitted proposal comes back as what the server did with it (queued, or turned down by its quality checks).
   * Also returns the names the answer left out because their type was not offered (entityRegister only). */
  private async processCandidate(mcp: McpClient, stage: CleanupStage, candidate: Candidate, shared: unknown, provider: "ollama" | "openai-compatible" | "claude" | "codex", model: string, ctx: RequestContext): Promise<{ outcome: "noFinding" | SubmitResult; skippedNames: SkippedEntityName[] }> {
    // A stage whose instruction the server sends is asked with that instruction; its `shared` carries nothing
    // else, so it is not repeated in the prompt.
    const serverOwned = hasServerInstruction(stage);
    const instruction = serverOwned
      ? cliStageInstruction(stage, shared)
      : ownStageInstruction("cli");
    const prompt = cliPrompt(instruction, { stage, candidate: candidate.content, shared: serverOwned ? null : shared ?? null });
    const proposal = provider === "claude" || provider === "codex"
      ? await runCliJson(provider, prompt, OUTPUT_SCHEMA, model, ctx.signal)
      : await this.ai.cleanupDecision(stage, candidate.content, shared, provider, model, ctx)
        .catch((error: unknown) => { throw cleanupAiFailure(error); });
    const decision = parseProposalDecision(stage, candidate, proposal);
    if (!decision.finding) {
      await mcp.call("cleanup_report_no_finding", candidateRef(stage, candidate));
      return { outcome: "noFinding", skippedNames: [] };
    }
    if (decision.kind !== KINDS[stage]) throw serviceError("AI_PROPOSAL", messages.cleanupService.proposalKindMismatch);
    const answer = await mcp.call("cleanup_submit_proposal", { kind: decision.kind, payload: decision.payload, candidate: candidateRef(stage, candidate) });
    return { outcome: parseSubmitResponse(decision.kind, answer), skippedNames: decision.skippedNames ?? [] };
  }
}
