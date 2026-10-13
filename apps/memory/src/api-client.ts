/**
 * Thin HTTP client over the memory-api REST endpoints.
 *
 * Why a hand-rolled fetch wrapper instead of openapi-fetch / axios: we
 * have a single endpoint set, the request shapes are tiny, and the bot's
 * binary size matters less than zero-extra-dependencies and easy reading.
 */

import type { ArchivedNode, EvolverActivitySummary } from "./memory/types.js";
import type { DocumentParseStatus } from "./memory/document-parse-status.ts";
import type { CleanupProposal } from "./db/store-internal/cleanup-proposals-repository.ts";
import type {
  MemoryRow,
  SearchResult,
  StatsResult,
  ExtractFromTextResult,
  DeleteBySourceResult,
  EditBySourceArgs,
  EditBySourceResult,
  ForgetResult,
  MemoryCreateApiResult,
  MemoryEditApiResult,
  MemoryAppendApiResult,
  MemoryTagAddApiResult,
  PostIngestArgs,
  PostIngestApiResult,
  DocumentOcrCandidate,
  DocumentOcrApplyResult,
  DocumentOcrFailureResult,
  DocumentOcrRuntimeConfig,
  AdapterTokenEnrollRequest,
  AdapterTokenEnrollResponse,
  AdapterTokenPickupResponse,
  IngestImageResponse,
  MemoryApiClientOptions,
  DateOccurrenceResponse,
  DateOccurrencesQuery,
} from "./api-client-types.ts";

// 외부 모듈 타입 re-export (기존 공개 API 보존).
export type { ArchivedNode, EvolverActivitySummary } from "./memory/types.js";
export type { Tier1Detection } from "./memory/canonicalize/types.js";
export type {
  DocumentParseMetadata,
  DocumentParseStatus,
} from "./memory/document-parse-status.ts";
export type { CleanupProposal } from "./db/store-internal/cleanup-proposals-repository.ts";

// api-client-types.ts 로 옮긴 요청·응답 타입을 다시 export (기존 공개 API 보존).
export type * from "./api-client-types.ts";

/**
 * memory-api 가 비2xx 로 응답할 때 `unwrap` 이 던지는 에러.
 *
 * HTTP status 를 `status` 필드로 직접 노출하는 이유: 옛 코드는 status 숫자를
 * 오직 메시지 문자열("memory-api request failed: 401 ...") 안에만 담아, 호출자가
 * 재시도 여부를 가리려면 그 문장을 정규식으로 도로 파내야 했다(군더더기 + 깨지기
 * 쉬움). status 를 필드로 들면 `err.status === 401` 같은 깔끔한 비교로 바뀐다.
 *
 * 메시지 문자열은 옛 형식(`memory-api request failed: <status> <statusText> — <body.error>`)
 * 을 그대로 보존한다 — 메시지 문자열을 읽던 기존 호출자(테스트 포함)가 깨지지 않게
 * 하위 호환을 지킨다.
 */
export class MemoryApiError extends Error {
  /** HTTP status 숫자(예: 401·403·503). 문자열 파싱 없이 바로 분기하라고 노출한다. */
  readonly status: number;
  /** HTTP statusText(예: "Unauthorized"). status 와 짝으로 보존한다. */
  readonly statusText: string;

  constructor(status: number, statusText: string, message: string) {
    super(message);
    this.name = "MemoryApiError";
    this.status = status;
    this.statusText = statusText;
  }
}

export class MemoryApiClient {
  private readonly token?: string;

  constructor(
    private readonly baseUrl: string,
    opts: MemoryApiClientOptions = {},
  ) {
    this.token = opts.token;
  }

  /**
   * 공통 헤더를 만든다.
   *
   * - `extra`로 전달한 헤더(예: `{ "Content-Type": "application/json" }`)를 먼저 넣는다.
   * - 토큰이 설정돼 있으면 `Authorization: Bearer <token>`을 추가한다.
   * - 토큰이 없으면 Authorization 헤더는 붙지 않는다(부트스트랩 호출 포함).
   */
  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  /**
   * JSON body 를 담은 POST 요청을 보낸다 — method/Content-Type 헤더/
   * `JSON.stringify` body/`unwrap` 응답 처리가 같던 호출처들을 한 군데로 합친다.
   *
   * 인증 토큰 배선은 그대로 살아 있다 — `headers({...})` 가 토큰이 있으면
   * `Authorization: Bearer <token>` 을 붙인다(보안 단계 정합). 비2xx 는 `unwrap`
   * 이 `MemoryApiError` 로 throw(silent 빈 결과 금지). 응답 본문에서 한 필드만
   * 꺼내야 하는 호출처(예: `/search` 의 `results`)는 이 메서드로 응답을 받은 뒤
   * 호출처에서 추출한다.
   */
  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    return this.unwrap<T>(res);
  }

  /**
   * 주의 — 이 메서드는 이름이 ingest 지만 **POST /memories**(글 하나 저장 통로,
   * 봇 single-path)를 부른다. 문서 라우트 **POST /ingest**(자산 보관 + canonicalize
   * + 청크)는 아래 `postIngest` 다. 이름 혼동 금지.
   */
  async ingest(args: {
    content: string;
    metadata?: Record<string, unknown>;
    /** Attribution display name (spec 4.5). 옵션. */
    author?: string;
    /** Attribution adapter identifier (spec 4.5). 옵션. */
    platform?: string;
    /** 다중 프로젝트 스코프. 서버가 trim/NULL 정규화한다. */
    projectId?: string;
    importance?: number;
    memoryType?: string;
  }): Promise<MemoryCreateApiResult> {
    return this.postJson<MemoryCreateApiResult>("/memories", args);
  }

  /**
   * 진짜 문서 라우트 **POST /ingest**(14a)를 부른다 — 자산 보관 + canonicalize +
   * 청크 분해 + 노드 저장 + attribution + 정직한 경고를 한 흐름으로 잇는다.
   * 위 `ingest()`(=POST /memories)와 다른 통로다.
   *
   * 14a 응답(`{ ok, assetSha256, documentId, nodeIds, cacheHit, warnings, detection }`)을
   * 그대로 반환한다. 비2xx 는 `unwrap` 이 구체 에러를 throw(silent 빈 결과 금지) —
   * assetStore 미주입 503·잘못된 body 400 등을 호출자가 그대로 보게 된다.
   */
  async postIngest(args: PostIngestArgs): Promise<PostIngestApiResult> {
    return this.postJson<PostIngestApiResult>("/ingest", args);
  }

  /**
   * POST /ingest 안 image 갈래(Phase 11a T5)를 부른다 — `content.type='image'` +
   * base64. 텍스트 응답(`IngestDocumentApiResult`)과 양식이 달라 별 메서드로 둔다.
   *
   * 응답 양식: `{ ok: true, type: "image", images: [...] }`(T5 라우트 정합). 비2xx
   * 는 `unwrap` 이 구체 에러를 throw — image embedder 미주입 503·지원 안 하는 image
   * mime 400 등을 호출자가 그대로 보게 된다(silent fallback 금지).
   */
  async postIngestImage(args: PostIngestArgs): Promise<IngestImageResponse> {
    return this.postJson<IngestImageResponse>("/ingest", args);
  }

  /**
   * GET /api/documents/ocr-candidates — OCR/파싱 후처리가 필요한 문서 목록.
   * 빈 배열은 정상적인 "할 일 없음" 상태다.
   */
  async listOcrCandidates(options: {
    status?: readonly DocumentParseStatus[];
    limit?: number;
  } = {}): Promise<DocumentOcrCandidate[]> {
    const params = new URLSearchParams();
    if (options.status && options.status.length > 0) {
      params.set("status", options.status.join(","));
    }
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${this.baseUrl}/api/documents/ocr-candidates${qs}`, {
      headers: this.headers(),
    });
    const body = await this.unwrap<{ candidates: DocumentOcrCandidate[] }>(res);
    return body.candidates;
  }

  /**
   * GET /api/documents/ocr-runtime-config — companion/server OCR 실행 힌트.
   * API key 같은 비밀값은 포함하지 않고 hasApiKey 여부만 온다.
   */
  async getDocumentOcrRuntimeConfig(): Promise<DocumentOcrRuntimeConfig> {
    const res = await fetch(`${this.baseUrl}/api/documents/ocr-runtime-config`, {
      headers: this.headers(),
    });
    const body = await this.unwrap<{ config: DocumentOcrRuntimeConfig }>(res);
    return body.config;
  }

  /**
   * POST /api/documents/ocr-jobs/claim — companion worker 가 처리할 문서 하나를 lease 한다.
   * 후보가 없으면 job=null.
   */
  async claimDocumentOcrJob(args: {
    workerId: string;
    statuses?: readonly DocumentParseStatus[];
    leaseSeconds?: number;
  }): Promise<DocumentOcrCandidate | null> {
    const body = await this.postJson<{ job: DocumentOcrCandidate | null }>(
      "/api/documents/ocr-jobs/claim",
      args,
    );
    return body.job;
  }

  /**
   * POST /api/documents/:id/ocr-result — 외부 OCR Markdown 을 같은 documentId 에 적용.
   */
  async applyDocumentOcrResult(
    documentId: string,
    args: {
      markdown: string;
      source?: "manual" | "companion";
      providerName?: string;
      workerId?: string;
    },
  ): Promise<DocumentOcrApplyResult> {
    return this.postJson<DocumentOcrApplyResult>(
      `/api/documents/${encodeURIComponent(documentId)}/ocr-result`,
      args,
    );
  }

  /**
   * POST /api/documents/:id/ocr-failure — companion/manual OCR 실패를 문서 metadata 에 기록.
   */
  async reportDocumentOcrFailure(
    documentId: string,
    args: {
      errorMessage: string;
      source?: "manual" | "companion";
      providerName?: string;
      workerId?: string;
    },
  ): Promise<DocumentOcrFailureResult> {
    return this.postJson<DocumentOcrFailureResult>(
      `/api/documents/${encodeURIComponent(documentId)}/ocr-failure`,
      args,
    );
  }

  /** GET /assets/:sha — 등록된 자산을 binary 로 내려받는다. */
  async downloadAsset(sha256: string): Promise<{
    arrayBuffer: ArrayBuffer;
    contentType: string | null;
  }> {
    const res = await fetch(
      `${this.baseUrl}/assets/${encodeURIComponent(sha256)}`,
      { headers: this.headers() },
    );
    if (!res.ok) await this.unwrap<never>(res);
    return {
      arrayBuffer: await res.arrayBuffer(),
      contentType: res.headers.get("content-type"),
    };
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const body = await this.postJson<{ results: SearchResult[] }>("/search", {
      query,
      limit,
    });
    return body.results;
  }

  async recent(limit = 10): Promise<MemoryRow[]> {
    const res = await fetch(
      `${this.baseUrl}/memories?recent=${limit}`,
      { headers: this.headers() },
    );
    const body = await this.unwrap<{ memories: MemoryRow[] }>(res);
    return body.memories;
  }

  async show(id: number): Promise<MemoryRow | null> {
    const res = await fetch(
      `${this.baseUrl}/memories/${id}`,
      { headers: this.headers() },
    );
    if (res.status === 404) return null;
    const body = await this.unwrap<{ memory: MemoryRow }>(res);
    return body.memory;
  }

  async editMemory(id: number, args: {
    content: string;
    reason?: string;
    editor?: string;
    source?: "dashboard" | "discord" | "api" | "mcp" | string;
  }): Promise<MemoryEditApiResult> {
    const res = await fetch(`${this.baseUrl}/memories/${id}`, {
      method: "PATCH",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(args),
    });
    return this.unwrap<MemoryEditApiResult>(res);
  }

  async appendToMemory(id: number, args: {
    content: string;
    reason?: string;
    metadata?: Record<string, unknown>;
    author?: string;
    platform?: string;
    projectId?: string;
    importance?: number;
    memoryType?: string;
  }): Promise<MemoryAppendApiResult> {
    return this.postJson<MemoryAppendApiResult>(`/memories/${id}/append`, args);
  }

  async addTagToMemory(id: number, args: {
    tag: string;
    editor?: string;
    source?: "dashboard" | "discord" | "api" | "mcp" | string;
  }): Promise<MemoryTagAddApiResult> {
    return this.postJson<MemoryTagAddApiResult>(`/memories/${id}/tags`, args);
  }

  /**
   * DELETE /memories/:id — 기억 하나를 영구 삭제한다. 출처 없는 계보 자손도 함께 지워지고 그 수는
   * derivedDeletedIds 로 온다(WP-B1-20U 설계 17.3). 없는 기억이면 null.
   */
  async forget(id: number): Promise<ForgetResult | null> {
    const res = await fetch(`${this.baseUrl}/memories/${id}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    return this.unwrap<ForgetResult>(res);
  }

  async stats(): Promise<StatsResult> {
    const res = await fetch(
      `${this.baseUrl}/stats`,
      { headers: this.headers() },
    );
    return this.unwrap<StatsResult>(res);
  }

  /**
   * GET /federation/apps/:id/settings — 코어가 어댑터 보호 settings 경로를
   * 실제로 프록시할 수 있는지 확인할 때도 쓴다. 봇 부트스트랩은 응답 값을
   * 사용하지 않고, 424/401 같은 status 로 adminToken 메타 유실을 감지한다.
   */
  async getFederationAppSettings(adapterId: string): Promise<unknown> {
    const res = await fetch(
      `${this.baseUrl}/federation/apps/${encodeURIComponent(adapterId)}/settings`,
      { headers: this.headers() },
    );
    return this.unwrap<unknown>(res);
  }

  /**
   * Send a free-form text to the LLM extractor and let it split into atomic
   * memories. The server returns 503 if no LLM provider is configured —
   * callers should surface that to the user rather than treating it as a
   * network failure.
   */
  async extractFromText(args: {
    text: string;
    author?: string;
    platform?: string;
    /**
     * Optional metadata that the extractor will attach to every extracted
     * child node. The Discord bot uses this to carry `messageId`,
     * `channelId`, `guildId`, etc. so that `deleteBySource` later catches
     * the children when the source message is removed.
     */
    metadata?: Record<string, unknown>;
    /**
     * If true the server also stores the original text as a `auto_capture`
     * node and links every extracted child to it via `merged_into`. Safety
     * net for when the LLM compresses or paraphrases badly — the user's
     * exact wording survives in SQLite. Default false at the wire level;
     * the Discord bot turns this ON for both auto-extract and `/extract`.
     */
    preserveRaw?: boolean;
    /** 다중 프로젝트 스코프. 서버가 trim/NULL 정규화한다. */
    projectId?: string;
  }): Promise<ExtractFromTextResult> {
    return this.postJson<ExtractFromTextResult>("/memories/from-text", args);
  }

  /**
   * Delete every memory whose metadata identifies it as coming from the
   * given source message. Used to mirror an external message deletion
   * (e.g. Discord MessageDelete). Returns the count and ids removed —
   * 0 is a valid response when nothing was stored under that messageId.
   */
  async deleteBySource(args: {
    messageId: string;
    platform?: string;
  }): Promise<DeleteBySourceResult> {
    const params = new URLSearchParams({ messageId: args.messageId });
    if (args.platform) params.set("platform", args.platform);
    const res = await fetch(
      `${this.baseUrl}/memories/by-source?${params.toString()}`,
      { method: "DELETE", headers: this.headers() },
    );
    return this.unwrap<DeleteBySourceResult>(res);
  }

  /**
   * Edit the raw memory row associated with an external source message.
   * Used by adapters to mirror upstream message edits without teaching the
   * memory core about Discord/Slack/etc. policy. `attachmentIds` (WP-B1-20U
   * design 17.9) is the full list of attachments the message still has after
   * the edit; the core deletes the memories of attachments missing from it.
   * Omit it when the attachment list is unknown.
   */
  async editBySource(args: EditBySourceArgs): Promise<EditBySourceResult> {
    const res = await fetch(`${this.baseUrl}/memories/by-source`, {
      method: "PATCH",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(args),
    });
    return this.unwrap<EditBySourceResult>(res);
  }

  /**
   * GET /archive — 휴지통 노드 목록.
   * `since`: ISO 날짜 문자열 (이 시점 이후 아카이브된 노드만).
   * `limit`: 최대 반환 수 (기본 50, 서버 상한 200).
   */
  async getArchive(
    options: { since?: string; limit?: number } = {},
  ): Promise<ArchivedNode[]> {
    const params = new URLSearchParams();
    if (options.since) params.set("since", options.since);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(
      `${this.baseUrl}/archive${qs}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`getArchive failed: ${res.status}`);
    const body = (await res.json()) as { archive: ArchivedNode[] };
    return body.archive;
  }

  /**
   * POST /archive/:id/restore — 아카이브 노드를 메인 DB로 복구.
   * 없는 id면 서버가 404를 반환하고 이 메서드는 Error를 throw.
   */
  async restoreArchived(id: number): Promise<MemoryRow> {
    const res = await fetch(`${this.baseUrl}/archive/${id}/restore`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`restoreArchived failed: ${res.status}`);
    const body = (await res.json()) as { restored: MemoryRow };
    return body.restored;
  }

  /**
   * GET /evolver/activity — 최근 evolver 사이클 로그.
   * `limit`: 최대 반환 수 (기본 7, 서버 상한 100).
   */
  async getEvolverActivity(limit?: number): Promise<EvolverActivitySummary[]> {
    const qs = limit !== undefined ? `?limit=${limit}` : "";
    const res = await fetch(
      `${this.baseUrl}/evolver/activity${qs}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`getEvolverActivity failed: ${res.status}`);
    const body = (await res.json()) as { activity: EvolverActivitySummary[] };
    return body.activity;
  }

  /**
   * GET /api/date-occurrences — schedule/date candidates over memory nodes and
   * entity date fields. Adapters use this as read-only input for their own
   * reminder policy.
   */
  async listDateOccurrences(
    options: DateOccurrencesQuery = {},
  ): Promise<DateOccurrenceResponse> {
    const params = new URLSearchParams();
    if (options.days !== undefined) params.set("days", String(options.days));
    if (options.pastDays !== undefined) params.set("pastDays", String(options.pastDays));
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.kind) params.set("kind", options.kind);
    if (options.column) params.set("column", options.column);
    if (options.q) params.set("q", options.q);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${this.baseUrl}/api/date-occurrences${qs}`, {
      headers: this.headers(),
    });
    return this.unwrap<DateOccurrenceResponse>(res);
  }

  /**
   * POST /adapter-enroll — 새 어댑터가 토큰을 신청한다.
   * 응답의 requestId + pickupSecret 을 보관한 뒤, 대시보드 승인까지
   * pickupAdapterToken 으로 polling 한다. pickupSecret 은 이 응답에서만 평문으로 온다.
   * requestedScope 는 승인 화면 표시용이다(권한은 관리자가 고른다) — 필드 설명은
   * api-client-types.ts 의 AdapterTokenEnrollRequest.
   */
  async enrollAdapterToken(
    args: AdapterTokenEnrollRequest,
  ): Promise<AdapterTokenEnrollResponse> {
    const res = await fetch(`${this.baseUrl}/adapter-enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    return this.unwrap<AdapterTokenEnrollResponse>(res);
  }

  /**
   * GET /adapter-enroll/:requestId/token — 승인된 요청의 토큰을 회수한다.
   * pending 은 HTTP 202 + `{ status: "pending" }` 으로 정상 응답이다.
   */
  async pickupAdapterToken(
    requestId: string,
    pickupSecret: string,
  ): Promise<AdapterTokenPickupResponse> {
    const params = new URLSearchParams({ pickupSecret });
    const res = await fetch(
      `${this.baseUrl}/adapter-enroll/${encodeURIComponent(requestId)}/token?${params.toString()}`,
    );
    return this.unwrap<AdapterTokenPickupResponse>(res);
  }

  /**
   * GET /cleanup-proposals?status=pending — 검토 대기 중인 정리 제안 목록.
   * 봇이 알림 DM 에 띄울 근거(payload.evidence 등)를 이 목록에서 읽는다.
   * 빈 배열 = 대기 제안 없음이라는 진짜 빈 상태(실패 위장 아님).
   */
  async listPendingProposals(
    limit = 20,
  ): Promise<{ proposals: CleanupProposal[]; total: number }> {
    const res = await fetch(
      `${this.baseUrl}/cleanup-proposals?status=pending&limit=${limit}`,
      { headers: this.headers() },
    );
    return this.unwrap<{ proposals: CleanupProposal[]; total: number }>(res);
  }

  /**
   * POST /cleanup-proposals/:id/approve — 제안 수락. 서버가 kind 별로 적용한다.
   *
   * 갱신되는 status 는 kind 갈래에 따라 다르다(spec 5-9 / T32 상태 확장):
   *   - 추가형(metadata_fill · person_link · regex_pattern_add) — 옛 단일 승인 어휘
   *     그대로 status='approved'. 회신도 `{ approved: id }` 한 칸 그대로다.
   *     (metadata_fill 이면 place→setPlace / event_at→setEventAt)
   *   - 파괴형(lens_draft) — 항목별로 적용하고 결과에 따라 'applied'(전 항목 적용) /
   *     'partially_applied'(일부만) / 'needs_revision'(적용 0 — 적용 시점 대조 실패 등)
   *     로 갈린다. 회신에 status·appliedCount·items(항목별 결과)가 함께 실린다.
   *
   * 이 메서드는 body 를 안 보내므로 파괴형도 전건 승인으로 동작한다(부분 승인을 쓰려면
   * body 에 itemKeys 를 실어야 한다 — 봇 경로는 현재 전건 승인만 쓴다).
   *
   * 비2xx(이미 처리됨·없는 id·payload 어긋남·적용 0건)는 unwrap 이 구체 에러로 throw —
   * 봇이 그대로 사용자에게 정직하게 알린다(silent 무동작 금지).
   */
  async approveProposal(id: string): Promise<{ approved: string }> {
    const res = await fetch(
      `${this.baseUrl}/cleanup-proposals/${encodeURIComponent(id)}/approve`,
      { method: "POST", headers: this.headers() },
    );
    return this.unwrap<{ approved: string }>(res);
  }

  /**
   * POST /cleanup-proposals/:id/reject — 제안 거절. 적용 함수는 호출 안 되고
   * status='rejected' 만 갱신된다(데이터 변동 0). 비2xx 는 unwrap 이 throw.
   */
  async rejectProposal(id: string): Promise<{ rejected: string }> {
    const res = await fetch(
      `${this.baseUrl}/cleanup-proposals/${encodeURIComponent(id)}/reject`,
      { method: "POST", headers: this.headers() },
    );
    return this.unwrap<{ rejected: string }>(res);
  }

  async cleanup(): Promise<{ phase: number; message: string }> {
    const res = await fetch(`${this.baseUrl}/cleanup`, {
      method: "POST",
      headers: this.headers(),
    });
    // 501 is *expected* for the Phase 2 placeholder; surface the body
    // text to the user instead of treating it as an error.
    const body = (await res.json()) as { phase?: number; message?: string };
    return {
      phase: body.phase ?? 2,
      message: body.message ?? "Phase 2 placeholder",
    };
  }

  private async unwrap<T>(res: Response): Promise<T> {
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const errBody = (await res.json()) as { error?: string };
        if (errBody.error) detail = `${detail} — ${errBody.error}`;
      } catch {
        // ignore — non-JSON error body
      }
      // status 를 필드로 담아 던진다 — 호출자가 메시지 문자열을 정규식으로
      // 파내지 않고 err.status 로 바로 분기하게 한다. 메시지 형식은 옛 그대로
      // 보존(하위 호환).
      throw new MemoryApiError(
        res.status,
        res.statusText,
        `memory-api request failed: ${detail}`,
      );
    }
    return (await res.json()) as T;
  }
}
