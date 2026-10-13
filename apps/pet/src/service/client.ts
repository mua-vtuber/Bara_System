import { audienceMatches, CAPTURE_KINDS, connectionAudience, MEMORY_EDIT_ERROR_CODES, QUESTION_MAX_CHARS, REQUIRED_CAPABILITIES, type Capture, type CaptureKind, type ConnectionSettings, type ConnectionStatus, type Enrollment, type Memory, type RequestContext, type SaveInput, type SaveResult, type SearchResult, type StoredCapture } from "../shared/contracts.ts";
import { ConfigStore, type CredentialSnapshot } from "./config.ts";
import type { CredentialRoutes } from "./install/credential-routes.ts";
import { clientInfoFailure, interpretClientInfo, type ClientInfo } from "./client-info.ts";
import { ServiceError, serviceError, type ServerErrorDetail } from "./errors.ts";
import { causeOf, classifyFetchFailure, FETCH_FAILURE_CODES } from "./fetch-failure.ts";
import { publicError } from "./protocol.ts";
import { messages } from "../ui/messages.ts";
import { SAVE_BODY_MAX_CHARS, validateCapture, validateId, validateRequestId, validateSaveInput, validateText } from "./validation.ts";

const MAX_RESPONSE = 2_000_000;
const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The text for a failure caught where the answer is a result and not a throw (`info`, `save`). A service
 * failure keeps its own text, and so does an error that carries a checked public text of its own (the
 * native vault's); `publicError` answers the generic `messages.rpc.internal` only when an error has none.
 * Any other exception is unexpected: its own cause goes into the sentence `unexpected` builds, so no fixed
 * sentence stands in for what actually failed. */
function failureText(error: unknown, unexpected: (cause: string) => string): string {
  if (error instanceof ServiceError) return error.publicMessage;
  const checked = publicError(error).message;
  return checked !== messages.rpc.internal ? checked : unexpected(causeOf(error));
}

/** The server returns flat search rows and wraps GET/PATCH memory in {memory}. Unlike `validateCapture`
 * (used for outgoing values in `update`/`save`, where an unknown kind is genuinely this Pet's own bug),
 * a capture kind the server sends back that this Pet does not recognize is not a validation failure --
 * it is a newer server feature this Pet has not learned yet. That case becomes `unknownCapture` instead
 * of throwing, so opening a memory the server tagged with a new kind never looks like a user input error. */
export function normalizeMemory(value: unknown, audience?: string): Memory {
  const row = asRecord(value);
  if (!row || !Number.isSafeInteger(row.id) || (row.id as number) <= 0 || typeof row.content !== "string") throw serviceError("SERVER_RESPONSE", messages.serverClient.memoryUnreadable);
  const metadata = asRecord(row.metadata) ?? undefined;
  const shared = asRecord(metadata?.sharedMemory);
  const revision = Number.isSafeInteger(shared?.revision) && (shared!.revision as number) >= 0 ? shared!.revision as number : 0;
  const rawCapture = asRecord(metadata?.capture);
  // A capture object with a kind or source that is not even a string is not a classification this Pet
  // has never heard of -- it is the server breaking its own response contract, so it is reported as a
  // server response error rather than silently relabeled "unknown" (that would hide real server-side
  // corruption behind an honest-looking category badge).
  if (rawCapture && (typeof rawCapture.kind !== "string" || typeof rawCapture.source !== "string"))
    throw serviceError("SERVER_RESPONSE", messages.serverClient.captureUnreadable);
  // A known kind keeps the server's own source string even when it is not "user"/"ai": `StoredCapture`
  // (unlike the outgoing `Capture`) types `source` as a plain string, so this never needs a cast. The
  // source is never re-sent to the server (memory-edit.ts always writes its own fresh "user" on save) and
  // is not shown in the UI, so preserving it verbatim cannot corrupt a later write -- unlike substituting
  // "ai", it does not misrepresent what the server actually said. An unknown kind is never mistaken for a
  // known one just because its source happens to be odd.
  const knownCapture: StoredCapture | undefined = rawCapture && CAPTURE_KINDS.includes(rawCapture.kind as CaptureKind)
    ? { kind: rawCapture.kind as CaptureKind, source: rawCapture.source as string } : undefined;
  const unknownCapture = rawCapture && !knownCapture ? { kind: rawCapture.kind as string, source: rawCapture.source as string } : undefined;
  // `capture` is deleted before re-adding it, not just overwritten: when the raw value is unknown, the
  // spread below must not leave the server's raw (invalid) capture object sitting under `capture` --
  // `memory-view.ts` reads `metadata.capture` directly and must see either a known StoredCapture or nothing.
  const { capture: _rawCaptureField, ...metadataRest } = metadata ?? {};
  return { id: row.id as number, content: row.content, ...(audience ? { audience } : {}), ...(typeof row.createdAt === "string" ? { createdAt: row.createdAt } : {}),
    ...(typeof row.editableContent === "string" ? { editableContent: row.editableContent } : {}),
    ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}), revision,
    ...(typeof row.memoryType === "string" ? { memoryType: row.memoryType } : {}),
    ...(metadata ? { metadata: { ...metadataRest, ...(knownCapture ? { capture: knownCapture } : {}), ...(unknownCapture ? { unknownCapture } : {}) } } : {}) };
}

export function normalizeSearch(value: unknown, query: string, audience?: string): SearchResult {
  const body = asRecord(value);
  if (!body || !Array.isArray(body.results)) throw serviceError("SERVER_RESPONSE", messages.serverClient.searchUnreadable);
  return { query, ...(audience ? { audience } : {}), results: body.results.map((entry: unknown) => {
    const row = asRecord(entry);
    if (!row) throw serviceError("SERVER_RESPONSE", messages.serverClient.searchUnreadable);
    return { memory: normalizeMemory(row, audience), ...(typeof row.score === "number" ? { score: row.score } : {}) };
  }) };
}

export function normalizeReceipt(value: unknown, requestId: string, audience?: string): SaveResult {
  const body = asRecord(value);
  const scoped = audience ? { audience } : {};
  const result = asRecord(body?.result);
  if (body?.state === "saved" && result?.ok === true) {
    if (result.type === "entity_patch") return { state: "saved", requestId, ...scoped, resultType: "entity_patch" };
    if (Number.isSafeInteger(result.originNodeId)) return { state: "saved", requestId, ...scoped, resultType: "memory" };
  }
  if (body?.state === "pending") return { state: "pending", requestId, ...scoped, message: messages.serverClient.receiptPending };
  return { state: "unknown", requestId, ...scoped, message: messages.serverClient.saveUnconfirmed };
}

/** The `ServiceError` for a request that threw. Cancellation, a time limit that ran out, a refused redirect,
 * a connection that never answered and an answer that is not HTTP each say so; any other exception reports
 * its own cause (`causeOf`), because blaming the connection for a Pet defect hides what to fix. */
function fetchFailureError(error: unknown, signal: AbortSignal): ServiceError {
  const kind = classifyFetchFailure(error, signal);
  if (kind === "cancelled") return serviceError("CANCELLED", messages.serverClient.requestCancelled);
  if (kind === "timeout") return serviceError(FETCH_FAILURE_CODES.timeout, messages.serverClient.timedOut);
  if (kind === "redirect") return serviceError(FETCH_FAILURE_CODES.redirect, messages.serverClient.redirected);
  if (kind === "network") return serviceError(FETCH_FAILURE_CODES.network, messages.serverClient.networkFailed);
  if (kind === "malformed") return serviceError("SERVER_RESPONSE", messages.serverClient.responseMalformed);
  return serviceError(FETCH_FAILURE_CODES.unexpected, messages.serverClient.requestUnexpected(causeOf(error)));
}

/** The `ServiceError` for a body read that threw after the answer began. The time limit, a cancellation and
 * an answer that turns out not to be HTTP keep their own texts (`fetchFailureError`); anything else, such as
 * the connection closing partway, is an unreadable answer that names its cause. */
function bodyReadError(error: unknown, signal: AbortSignal): ServiceError {
  const kind = classifyFetchFailure(error, signal);
  return kind === "cancelled" || kind === "timeout" || kind === "malformed"
    ? fetchFailureError(error, signal) : serviceError("SERVER_RESPONSE", messages.serverClient.responseReadFailed(causeOf(error)));
}

/** Shared by `requestJson` and `requestRaw`: URL validation, the fetch call itself (redirect-blocked,
 * bearer-authorized, cancellable), and the response-size guard. A request that gets no HTTP answer, an
 * answer that is not HTTP, a cancellation, a body that cannot be read and an oversized body are the only
 * things this throws, each with its own cause (`fetchFailureError`, `bodyReadError`); a non-2xx HTTP status
 * is left to the caller, since `requestJson` turns it into
 * a generic `ServiceError` while `requestRaw` hands the raw status on. */
async function fetchGuarded(baseUrl: string, token: string | null, method: string, path: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<{ response: Response; bodyText: string }> {
  if (!path.startsWith("/") || path.startsWith("//") || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw serviceError("INVALID_INPUT", messages.serverClient.requestInvalid);
  const url = new URL(path, `${baseUrl}/`);
  if (url.origin !== baseUrl) throw serviceError("INVALID_INPUT", messages.serverClient.serverAddressInvalid);
  // The header values and the body are the Pet's own: a token that cannot be a header value or a body that
  // cannot be serialized is a Pet defect found before anything is sent (`writeNotStarted`), never a failure
  // of the connection.
  let init: RequestInit;
  try {
    init = { method, redirect: "error",
      headers: new Headers({ ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), accept: "application/json" }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
  } catch (error) { throw serviceError(FETCH_FAILURE_CODES.unexpected, messages.serverClient.requestUnexpected(causeOf(error)), true); }
  const guard = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let response: Response;
  try { response = await fetch(url, { ...init, signal: guard }); }
  catch (error) { throw fetchFailureError(error, signal); }
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_RESPONSE) throw serviceError("SERVER_RESPONSE", messages.serverClient.responseTooLarge);
  let bodyText: string;
  // The same time limit and cancellation still apply while the body streams in.
  try { bodyText = await response.text(); }
  catch (error) { throw bodyReadError(error, signal); }
  if (bodyText.length > MAX_RESPONSE) throw serviceError("SERVER_RESPONSE", messages.serverClient.responseTooLarge);
  return { response, bodyText };
}

/** Reads what a 409 (or 429) body says about the refusal: the server's own `code` ("CONFLICT" for a stale
 * revision, "CAPTURE_CONFLICT" for an AI classification over a user one) and the node's `currentRevision`
 * (bara `routes/memories-edit.ts`). A 409 whose body is not JSON or names neither (e.g. the "source type
 * is not directly editable" answer, which carries only `error`) yields no detail; the caller still throws
 * the same generic CONFLICT error for it, so nothing here turns a refusal into anything else. A 429 carries
 * only a `code` (the enrollment limits below). */
function conflictDetail(bodyText: string): ServerErrorDetail {
  let parsed: unknown;
  try { parsed = JSON.parse(bodyText); } catch { return {}; }
  const body = asRecord(parsed);
  return { ...(typeof body?.code === "string" ? { serverCode: body.code } : {}),
    ...(Number.isSafeInteger(body?.currentRevision) && (body!.currentRevision as number) >= 0 ? { currentRevision: body!.currentRevision as number } : {}) };
}

/** The code `requestJson` gives each HTTP answer other than a success: 400 and 413, 401, 403, 404, 409, any
 * other status. The one list of them: `cleanupAiFailure` (`cleanup.ts`) renames every code here to the
 * cleanup AI's, so a code added here is renamed there too, and `describeProbeFailure` (`ai.ts`) reads the
 * credential refusals from here. */
export const HTTP_STATUS_FAILURE_CODES = {
  invalidInput: "INVALID_INPUT", authRequired: "AUTH_REQUIRED", forbidden: "FORBIDDEN", notFound: "NOT_FOUND", conflict: "CONFLICT", failed: "SERVER_ERROR",
} as const;
type HttpStatusFailureCode = typeof HTTP_STATUS_FAILURE_CODES[keyof typeof HTTP_STATUS_FAILURE_CODES];

/** The code and the text of a refused request, chosen together from its HTTP status, so a status can never
 * get one branch's code and another's text. */
function httpStatusFailure(status: number): { code: HttpStatusFailureCode; message: string } {
  const codes = HTTP_STATUS_FAILURE_CODES;
  const text = messages.serverClient.http;
  if (status === 400 || status === 413) return { code: codes.invalidInput, message: text.rejectedInput };
  if (status === 401) return { code: codes.authRequired, message: text.authRequired };
  if (status === 403) return { code: codes.forbidden, message: text.forbidden };
  if (status === 409) return { code: codes.conflict, message: text.conflict };
  if (status === 404) return { code: codes.notFound, message: text.notFound };
  return { code: codes.failed, message: text.failed(status) };
}

export async function requestJson(baseUrl: string, token: string | null, method: string, path: string, body: unknown, signal: AbortSignal, timeoutMs = 15_000): Promise<unknown> {
  const { response, bodyText } = await fetchGuarded(baseUrl, token, method, path, body, signal, timeoutMs);
  if (!response.ok) {
    const { code, message } = httpStatusFailure(response.status);
    const ingest = method === "POST" && new URL(path, `${baseUrl}/`).pathname === "/ingest";
    const writeNotStarted = ingest && (response.status === 401 || response.status === 403 || response.headers.get("X-Ingest-Retryable") === "true");
    throw serviceError(code, message, writeNotStarted, response.status === 409 || response.status === 429 ? conflictDetail(bodyText) : {});
  }
  try { return JSON.parse(bodyText); } catch { throw serviceError("SERVER_RESPONSE", messages.serverClient.responseUnreadable); }
}

/** A memory PATCH refused with the server's named conflict gets its own cause and code, keeping the
 * server's detail; every other failure (including a 409 that names no known conflict) passes through. */
function editConflictError(error: unknown): unknown {
  if (!(error instanceof ServiceError) || error.code !== "CONFLICT") return error;
  const detail: ServerErrorDetail = { serverCode: error.serverCode, currentRevision: error.currentRevision };
  if (error.serverCode === "CONFLICT") return serviceError(MEMORY_EDIT_ERROR_CODES.conflict, messages.memory.editConflict, false, detail);
  if (error.serverCode === "CAPTURE_CONFLICT") return serviceError(MEMORY_EDIT_ERROR_CODES.captureConflict, messages.memory.captureConflict, false, detail);
  return error;
}

/** Like `requestJson`, but for a call whose interpretation depends on the exact HTTP status and raw
 * body rather than the generic status -> ServiceError mapping above (`/client-info`, `interpretClientInfo`).
 * Never throws for a non-2xx response; only network failure, cancellation, or an oversized body throw. */
export async function requestRaw(baseUrl: string, token: string | null, path: string, signal: AbortSignal, timeoutMs = 15_000): Promise<{ status: number; bodyText: string }> {
  const { response, bodyText } = await fetchGuarded(baseUrl, token, "GET", path, undefined, signal, timeoutMs);
  return { status: response.status, bodyText };
}

/** The codes bara's POST /adapter-enroll names when it refuses a request (`federation/adapter-enroll-limits.ts`):
 * a request for this adapter already waits for approval (409), the approval queue is full or holds too
 * many requests from this address (429), or this address asked too often (429). Each becomes its own Pet code and sentence; any other refusal passes through. */
const ENROLLMENT_PENDING_EXISTS = "ENROLLMENT_PENDING_EXISTS";
const ENROLLMENT_REFUSALS: Readonly<Record<string, { code: string; message: () => string }>> = {
  ADAPTER_ENROLL_PENDING_EXISTS: { code: ENROLLMENT_PENDING_EXISTS, message: () => messages.serverClient.enrollmentPendingExists },
  ADAPTER_ENROLL_ADDRESS_PENDING_LIMIT: { code: "ENROLLMENT_ADDRESS_QUEUE_FULL", message: () => messages.serverClient.enrollmentAddressQueueFull },
  ADAPTER_ENROLL_PENDING_LIMIT: { code: "ENROLLMENT_QUEUE_FULL", message: () => messages.serverClient.enrollmentQueueFull },
  ADAPTER_ENROLL_RATE_LIMITED: { code: "ENROLLMENT_RATE_LIMITED", message: () => messages.serverClient.enrollmentRateLimited },
};

export function enrollmentRefusal(error: unknown): unknown {
  if (!(error instanceof ServiceError) || error.serverCode === undefined) return error;
  const refusal = ENROLLMENT_REFUSALS[error.serverCode];
  return refusal ? serviceError(refusal.code, refusal.message(), false, { serverCode: error.serverCode }) : error;
}

export class MemoryClient {
  /** `routes` is the owner of the local listeners this service verified (`InstallManager.routes`). */
  constructor(readonly config: ConfigStore, private readonly routes: Pick<CredentialRoutes, "assertServes">) {}

  /** Right before a request to the memory server: the snapshot's connection is still the saved one
   * (address and SSH route), and the listener at that address is the SSH tunnel or local server this
   * service verified. Callers send right after this resolves, with no other await in between. */
  async assertSendable(connection: ConnectionSettings): Promise<void> {
    await this.config.assertConnectionCurrent(connection);
    this.routes.assertServes(connection);
  }

  private async pinned(expectedAudience?: string): Promise<{ snapshot: CredentialSnapshot; audience: string }> {
    const snapshot = await this.config.snapshot();
    const audience = connectionAudience(snapshot.settings.connection);
    if (expectedAudience !== undefined && !audienceMatches(expectedAudience, snapshot.settings.connection)) throw serviceError("CONNECTION_CHANGED", messages.connectionChange.serverSwitched, true);
    return { snapshot, audience };
  }
  private async requestAt(snapshot: CredentialSnapshot, method: string, path: string, body: unknown, ctx: RequestContext, timeoutMs?: number): Promise<unknown> {
    await this.config.assertConnectionCurrent(snapshot.settings.connection);
    if (!snapshot.token) throw serviceError("AUTH_REQUIRED", messages.serverClient.tokenMissing, true);
    this.routes.assertServes(snapshot.settings.connection);
    return requestJson(snapshot.settings.connection.baseUrl, snapshot.token, method, path, body, ctx.signal, timeoutMs);
  }
  private async getAt(snapshot: CredentialSnapshot, audience: string, id: number, ctx: RequestContext): Promise<Memory> {
    const body = asRecord(await this.requestAt(snapshot, "GET", `/memories/${validateId(id)}`, undefined, ctx));
    return normalizeMemory(body?.memory, audience);
  }

  /** Turns a raw `/client-info` answer into a parsed `ClientInfo` or throws the specific cause for this
   * class's callers, `info()` and `allowedCaptureKinds()`. The judgment itself lives in
   * `interpretClientInfo`/`clientInfoFailure` (`client-info.ts`), which install-time readiness
   * (`install/net.ts`) calls directly with its own polling; only those two functions are shared, not
   * this method. Never returns a "ready" verdict
   * without a body that actually parsed; `retry` (5xx) becomes a plain server-error throw here since
   * none of this class's callers poll -- each call is a single attempt reported to its caller. */
  private async clientInfoAt(snapshot: CredentialSnapshot, signal: AbortSignal): Promise<ClientInfo> {
    await this.config.assertConnectionCurrent(snapshot.settings.connection);
    if (!snapshot.token) throw serviceError("AUTH_REQUIRED", messages.serverClient.tokenMissing, true);
    this.routes.assertServes(snapshot.settings.connection);
    const { status, bodyText } = await requestRaw(snapshot.settings.connection.baseUrl, snapshot.token, "/client-info", signal, 8000);
    const verdict = interpretClientInfo(status, bodyText);
    if (verdict.kind === "failed") throw clientInfoFailure(verdict);
    if (verdict.kind === "retry") throw serviceError("SERVER_ERROR", messages.serverClient.http.failed(verdict.status));
    return verdict.info;
  }

  /** A protocol-version mismatch and a missing required capability are different causes and get
   * different messages (contrast with a scope error, which is a real auth/connection problem, not a
   * version one). Unlike a plain connection failure, a capability-missing answer still proves the
   * server's actual capability list, so that list is returned alongside `connected: false` instead of
   * being dropped -- a caller that only cares about `memory-deeplink` (`dashboard.link`) can still act
   * on it instead of being told nothing more than "not connected". */
  async info(signal: AbortSignal = new AbortController().signal): Promise<ConnectionStatus> {
    try {
      const { snapshot } = await this.pinned();
      const parsed = await this.clientInfoAt(snapshot, signal);
      const missing = REQUIRED_CAPABILITIES.filter((name) => !parsed.capabilities.includes(name));
      if (missing.length > 0) return { connected: false, message: messages.connectionErrors.CAPABILITY_MISSING(missing.join(", ")),
        protocolVersion: parsed.protocolVersion, serverVersion: parsed.version, capabilities: parsed.capabilities };
      return { connected: true, message: messages.serverClient.connected, protocolVersion: parsed.protocolVersion,
        serverVersion: parsed.version, capabilities: parsed.capabilities };
    } catch (error) {
      return { connected: false, message: failureText(error, messages.serverClient.connectionCheckFailed) };
    }
  }

  async search(query: string, ctx: RequestContext, expectedAudience?: string): Promise<SearchResult> {
    const input = validateText(query, messages.fieldLabels.question, QUESTION_MAX_CHARS);
    const { snapshot, audience } = await this.pinned(expectedAudience);
    return normalizeSearch(await this.requestAt(snapshot, "POST", "/search", { query: input, limit: 10 }, ctx), input, audience);
  }

  /** Shares `info()`'s `/client-info` judgment (via `clientInfoAt`/`interpretClientInfo`) so a
   * version-incompatible server is never mistaken for a permission failure here (a 403/404 on a
   * pre-integration server used to surface as "FORBIDDEN"/"NOT_FOUND" through the generic requestAt
   * mapping). */
  async allowedCaptureKinds(ctx: RequestContext, expectedAudience?: string): Promise<CaptureKind[]> {
    const { snapshot } = await this.pinned(expectedAudience);
    const parsed = await this.clientInfoAt(snapshot, ctx.signal);
    if (!parsed.captureKinds) throw serviceError("SERVER_VERSION", messages.serverClient.captureKindsUnknown);
    return parsed.captureKinds.filter((kind): kind is CaptureKind => CAPTURE_KINDS.includes(kind as CaptureKind));
  }

  /** The added category needs an upgraded core; legacy kinds retain their existing request flow. */
  private async requireCaptureSupport(snapshot: CredentialSnapshot, capture: Capture | null | undefined, signal: AbortSignal): Promise<void> {
    if (capture?.kind !== "information") return;
    const info = await this.clientInfoAt(snapshot, signal);
    if (!info.captureKinds?.includes(capture.kind))
      throw serviceError("SERVER_UPGRADE_REQUIRED", messages.serverClient.informationCategoryUnsupported, true);
  }

  async get(id: number, ctx: RequestContext, expectedAudience?: string): Promise<Memory> {
    const { snapshot, audience } = await this.pinned(expectedAudience);
    return this.getAt(snapshot, audience, id, ctx);
  }

  /** Always returns the memory as re-read with GET after the PATCH, never the PATCH answer itself: the
   * PATCH answer is the raw node without `editableContent`, and an editor seeded from it would put the
   * tagged original back into the next PATCH. If that re-read fails, the edit is already saved, so the
   * error says exactly that (`EDIT_REREAD_FAILED`) instead of handing back the tag-bearing PATCH body.
   * `expectedRevision` is required at runtime: reading the latest revision here and sending it back would
   * make the server's stale-revision check always pass, so a missing one is refused instead. */
  async update(params: { id: number; audience?: string; content?: string; expectedRevision?: number; capture?: Capture | null }, ctx: RequestContext): Promise<Memory> {
    const { snapshot, audience } = await this.pinned(params.audience);
    const id = validateId(params.id);
    const content = params.content === undefined ? undefined : validateText(params.content, messages.fieldLabels.memoryContent, SAVE_BODY_MAX_CHARS);
    if (params.expectedRevision !== undefined && (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0)) throw serviceError("INVALID_INPUT", messages.serverClient.editRevisionInvalid);
    const capture = params.capture === undefined ? undefined : validateCapture(params.capture);
    if (content === undefined && capture === undefined) throw serviceError("INVALID_INPUT", messages.serverClient.editNothing);
    if (params.expectedRevision === undefined) throw serviceError("INVALID_INPUT", messages.memory.editRevisionMissing);
    await this.requireCaptureSupport(snapshot, capture, ctx.signal);
    let body: Record<string, unknown> | null;
    try {
      body = asRecord(await this.requestAt(snapshot, "PATCH", `/memories/${id}`, { ...(content !== undefined ? { content } : {}), expectedRevision: params.expectedRevision, ...(capture !== undefined ? { capture } : {}) }, ctx, 30_000));
    } catch (error) { throw editConflictError(error); }
    const savedButUnread = (error: unknown) => serviceError(MEMORY_EDIT_ERROR_CODES.rereadFailed, messages.memory.editRereadFailed(error instanceof ServiceError ? error.publicMessage : undefined));
    // Still validated so a malformed PATCH answer is reported, even though the result comes from the re-read.
    // The server already answered the PATCH with success, so the edit is saved: a malformed answer is the same
    // "saved, reload to check" case as a failed re-read, not a failed save.
    try { normalizeMemory(body?.memory, audience); }
    catch (error) { throw savedButUnread(error); }
    try { return await this.getAt(snapshot, audience, id, ctx); }
    catch (error) { throw savedButUnread(error); }
  }

  async save(input: SaveInput, ctx: RequestContext, classified?: Capture | null): Promise<SaveResult> {
    const requestId = input && typeof input.requestId === "string" ? input.requestId : "";
    const expectedAudience = input && typeof input.audience === "string" ? input.audience : undefined;
    let capture: Capture | null;
    try {
      validateSaveInput(input);
      capture = classified === undefined ? (input.kind === undefined || input.kind === null ? null : { kind: input.kind, source: "user" }) : validateCapture(classified);
    } catch (error) {
      return { state: "rejected", requestId, ...(expectedAudience ? { audience: expectedAudience } : {}), message: failureText(error, messages.serverClient.saveInputCheckFailed) };
    }
    let pinned;
    try { pinned = await this.pinned(input.audience); }
    catch (error) { return { state: "rejected", requestId, audience: input.audience, capture, message: failureText(error, messages.serverClient.saveConnectionCheckFailed) }; }
    const { snapshot, audience } = pinned;
    try { await this.requireCaptureSupport(snapshot, capture, ctx.signal); }
    catch (error) { return { state: "rejected", requestId, audience, capture, message: failureText(error, messages.serverClient.saveConnectionCheckFailed) }; }
    const body = { requestId: input.requestId, source: "pet", content: { type: "text", data: input.content }, ...(capture ? { capture } : {}) };
    try {
      const response = asRecord(await this.requestAt(snapshot, "POST", "/ingest", body, ctx, 60_000));
      if (!response || response.ok !== true) throw serviceError("SERVER_RESPONSE", messages.serverClient.saveResultUnconfirmed);
      // A bodyless entity-only input (e.g. `#가계부:미용 #금액:28000원`) updates an existing entity's
      // fields instead of creating a memory node; `originNodeId: null` is this type's normal value, not
      // a missing one, so the integer check below applies only to the `memory` type (or an older server
      // with no `type` field at all).
      if (response.type === "entity_patch") return { state: "saved", requestId: input.requestId, audience, capture, resultType: "entity_patch" };
      if (!Number.isSafeInteger(response.originNodeId)) throw serviceError("SERVER_RESPONSE", messages.serverClient.saveResultUnconfirmed);
      let memory: Memory | undefined;
      try { memory = await this.getAt(snapshot, audience, response.originNodeId as number, ctx); } catch { /* confirmed receipt still means saved */ }
      return { state: "saved", requestId: input.requestId, audience, ...(memory ? { memory } : {}), capture, resultType: "memory" };
    } catch (error) {
      if (error instanceof ServiceError && error.writeNotStarted) return { state: "rejected", requestId: input.requestId, audience, capture, message: error.publicMessage };
      try {
        return { ...(await this.statusAt(snapshot, audience, input.requestId, ctx)), capture };
      } catch { /* receipt can be absent after server restart; never resend */ }
      return { state: "unknown", requestId: input.requestId, audience, capture, message: messages.serverClient.saveUnconfirmed };
    }
  }

  private async statusAt(snapshot: CredentialSnapshot, audience: string, requestId: string, ctx: RequestContext): Promise<SaveResult> {
    validateRequestId(requestId);
    const body = asRecord(await this.requestAt(snapshot, "GET", `/ingest/status/${requestId}`, undefined, ctx, 8000));
    const result = normalizeReceipt(body, requestId, audience);
    const saved = asRecord(body?.result);
    // An entity_patch receipt has no origin node to fetch; `originNodeId: null` is that type's
    // normal value, so the lookup below applies only when normalizeReceipt judged this a `memory` save.
    if (result.state === "saved" && result.resultType === "memory" && Number.isSafeInteger(saved?.originNodeId)) {
      try { result.memory = await this.getAt(snapshot, audience, saved!.originNodeId as number, ctx); } catch { /* receipt itself proves the save */ }
    }
    return result;
  }
  async status(requestId: string, ctx: RequestContext, expectedAudience: string): Promise<SaveResult> {
    const { snapshot, audience } = await this.pinned(expectedAudience);
    return this.statusAt(snapshot, audience, requestId, ctx);
  }

  async enrollmentStart(ctx: RequestContext): Promise<Enrollment> {
    const { settings, token: existingToken, ownerToken: owner } = await this.config.snapshot();
    await this.assertSendable(settings.connection);
    let body: Record<string, unknown> | null;
    try { body = asRecord(await requestJson(settings.connection.baseUrl, null, "POST", "/adapter-enroll", { adapterId: "bara-pet", displayName: messages.nativeHost.productTitle, endpoint: settings.connection.baseUrl, ...(existingToken ? { existingToken } : {}) }, ctx.signal, 15_000)); }
    catch (error) {
      const refusal = enrollmentRefusal(error);
      // The waiting request the server keeps may be this Pet's own: resume it instead of asking the owner.
      if (refusal instanceof ServiceError && refusal.code === ENROLLMENT_PENDING_EXISTS) {
        const resumed = await this.resumeSavedEnrollment(settings.connection, owner, refusal, ctx);
        if (resumed) return resumed;
      }
      throw refusal;
    }
    if (!body || typeof body.requestId !== "string" || typeof body.pickupSecret !== "string") throw serviceError("SERVER_RESPONSE", messages.serverClient.enrollmentRequestUnconfirmed);
    await this.config.setEnrollment(JSON.stringify({ requestId: body.requestId, pickupSecret: body.pickupSecret, baseUrl: settings.connection.baseUrl }), settings.connection);
    if (body.status === "approved") return this.enrollmentPoll(ctx);
    if (owner) return this.approveAsOwnerAndPoll(settings.connection, owner, body.requestId, ctx);
    return { state: "pending", requestId: body.requestId, message: messages.serverClient.enrollmentApprovePending };
  }

  /** With the owner token this Pet approves its own request, then picks the token up. */
  private async approveAsOwnerAndPoll(connection: ConnectionSettings, owner: string, requestId: string, ctx: RequestContext): Promise<Enrollment> {
    await this.assertSendable(connection);
    await requestJson(connection.baseUrl, owner, "POST", `/adapter-tokens/${encodeURIComponent(requestId)}/approve`, { scope: "mcp-standard" }, ctx.signal, 15_000);
    return this.enrollmentPoll(ctx);
  }

  /** The server already keeps a waiting request for this Pet. When the request this Pet saved is for the
   * same server address, that request is ours: approve it with the owner token (when this Pet holds one)
   * or check it once more. Answers null when nothing usable is saved, so the caller reports the refusal.
   * When the owner approval finds the saved request gone (404), the saved request was not the one the
   * server keeps: it is cleared and `refusal` (the 409 guidance) is thrown rather than a bare NOT_FOUND. */
  private async resumeSavedEnrollment(connection: ConnectionSettings, owner: string | null | undefined, refusal: ServiceError, ctx: RequestContext): Promise<Enrollment | null> {
    const { enrollment: stored } = await this.config.enrollmentSnapshot();
    if (!stored) return null;
    let saved: Record<string, unknown> | null;
    try { saved = asRecord(JSON.parse(stored)); } catch { return null; }
    if (!saved || saved.baseUrl !== connection.baseUrl || typeof saved.requestId !== "string" || typeof saved.pickupSecret !== "string") return null;
    if (owner) {
      try { return await this.approveAsOwnerAndPoll(connection, owner, saved.requestId, ctx); }
      catch (error) {
        if (error instanceof ServiceError && error.code === HTTP_STATUS_FAILURE_CODES.notFound) { await this.config.clearEnrollment(); throw refusal; }
        throw error;
      }
    }
    return this.enrollmentPoll(ctx);
  }

  async enrollmentPoll(ctx: RequestContext): Promise<Enrollment> {
    const { snapshot, enrollment: stored } = await this.config.enrollmentSnapshot();
    if (!stored) throw serviceError("ENROLLMENT_MISSING", messages.serverClient.enrollmentMissing);
    let pending: Record<string, unknown>;
    try { pending = JSON.parse(stored); } catch { throw serviceError("ENROLLMENT_INVALID", messages.serverClient.enrollmentRestart); }
    const { settings } = snapshot;
    if (pending.baseUrl !== settings.connection.baseUrl || typeof pending.requestId !== "string" || typeof pending.pickupSecret !== "string") throw serviceError("ENROLLMENT_INVALID", messages.serverClient.enrollmentAddressChanged);
    if (typeof pending.token === "string" && pending.token.length > 0) {
      await this.config.save({ token: pending.token }, settings.connection);
      await this.config.clearEnrollment();
      return { state: "approved", requestId: pending.requestId, message: messages.serverClient.enrollmentApproved };
    }
    const path = `/adapter-enroll/${encodeURIComponent(pending.requestId)}/token?pickupSecret=${encodeURIComponent(pending.pickupSecret)}`;
    let result: Record<string, unknown> | null;
    try { await this.assertSendable(settings.connection); result = asRecord(await requestJson(settings.connection.baseUrl, null, "GET", path, undefined, ctx.signal, 15_000)); }
    catch (error) {
      if (error instanceof ServiceError && error.code === "FORBIDDEN") { await this.config.clearEnrollment(); return { state: "rejected", message: messages.serverClient.enrollmentRejected }; }
      // The server drops a request nobody approved within its waiting time; the stored one can never be picked up.
      if (error instanceof ServiceError && error.code === "NOT_FOUND") { await this.config.clearEnrollment(); throw serviceError("ENROLLMENT_EXPIRED", messages.serverClient.enrollmentExpired); }
      throw error;
    }
    if (result?.status === "pending") return { state: "pending", requestId: pending.requestId, message: messages.serverClient.enrollmentWaiting };
    if (result?.status !== "approved" || typeof result.token !== "string") throw serviceError("SERVER_RESPONSE", messages.serverClient.enrollmentResultUnreadable);
    await this.config.setEnrollment(JSON.stringify({ ...pending, token: result.token }), settings.connection);
    await this.config.save({ token: result.token }, settings.connection);
    await this.config.clearEnrollment();
    return { state: "approved", requestId: pending.requestId, message: messages.serverClient.enrollmentApproved };
  }
}
