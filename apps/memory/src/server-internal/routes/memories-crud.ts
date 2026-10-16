/**
 * routes/memories-crud.ts — POST /memories 저장 + GET 조회 세 라우트.
 *
 * routes/memories.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). POST /memories(saveTextInput
 * 위임 저장), GET /memories(최근 목록), GET /memories/:id, GET /memories/:id/revisions
 * 를 등록한다. 등록 순서·핸들러 로직·응답 형식은 옛 파일 그대로(동작 불변).
 *
 * deps 동적 lookup 규율 — autoCleanupTrigger / getSettings / extractor 는
 * createMemoryApi 가 나중에 mutate 하므로 핸들러 안에서 호출 시점에 deps.xxx 로
 * 접근한다(구조분해 금지). store 같은 부팅 시점 고정 의존만 구조분해 허용.
 */

import { listNodePlaces } from "../../memory/node-places.ts";
import type { Hono } from "hono";
import type { MemoryApiDeps, IngestBody } from "../types.ts";
import { isPositiveString, parseLimit, parseIntParam, err } from "../http-helpers.ts";
import { saveTextInput } from "../save-input.ts";
import { notifyMemoSaved } from "../memo-saved-cleanup.ts";
import { saveSharedMemoryInput, MemoryEvidenceError, type MemoryEvidenceInput } from "../shared-memory-write.ts";
import {
  duplicateRejectionResponse,
  secretRejectionResponse,
} from "../write-guard/write-guard-http.ts";
import type { MemoryType, MemoryNode } from "../../memory/types.ts";
import { EVENT_TYPES } from "../event-bus.ts";
import { normalizeProjectId } from "../../memory/project-scope.ts";
import { stripTagsForDisplay } from "../../memory/tag-extractor.ts";
import {
  parseClientMetadata,
  preparedExtractionConflictResponse,
  resolveRestAttribution,
  sourceKeyDelimiterResponse,
} from "./memories-shared.ts";

interface ImageAttachmentRow {
  node_id: number;
  content: string;
  metadata_json: string | null;
}

export interface ImageAttachment {
  nodeId: number;
  content: string;
  assetSha256: string;
  thumbSha256?: string;
  width?: number;
  height?: number;
  mime?: string;
  originalName?: string;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 깨진 metadata 는 이미지 미리보기에서 제외한다. 원본 memory 조회는 그대로 성공.
  }
  return {};
}

function imageAttachmentFromRow(row: ImageAttachmentRow): ImageAttachment | null {
  const metadata = parseJsonObject(row.metadata_json);
  const assetSha256 = stringField(metadata.asset_sha256);
  if (!assetSha256) return null;
  return {
    nodeId: row.node_id,
    content: row.content,
    assetSha256,
    thumbSha256: stringField(metadata.thumb_sha256),
    width: numberField(metadata.width),
    height: numberField(metadata.height),
    mime: stringField(metadata.mime),
    originalName: stringField(metadata.original_name),
  };
}

/**
 * 부모 노드(parentNodeId)에 parent_of 로 연결된 image_asset 자식들을 미리보기 형태로
 * 조회한다. MCP T4(get_memory 도구)와 REST GET /memories/:id 가 공유하는 서비스 함수로
 * 클로저에서 최상위로 끌어올렸다(store 인자화 — 본문 무변경).
 */
export function listImageAttachments(
  store: MemoryApiDeps["store"],
  parentNodeId: number,
): ImageAttachment[] {
  const rows = store
    .getRawDb()
    .query(
      `SELECT child.id AS node_id, child.content, child.metadata_json
         FROM knowledge_edges e
         JOIN knowledge_nodes child ON child.id = e.source_id
        WHERE e.target_id = ?
          AND e.relation = 'parent_of'
          AND child.source_type = 'image_asset'
        ORDER BY e.created_at ASC, child.id ASC`,
    )
    .all(parentNodeId) as ImageAttachmentRow[];
  return rows
    .map(imageAttachmentFromRow)
    .filter((image): image is ImageAttachment => image !== null);
}

/**
 * GET /memories 목록 응답 조립. MCP T4(list_recent 도구)와 REST GET /memories 가
 * 공유하는 서비스 함수로 라우트 인라인 매핑에서 추출했다(본문 무변경).
 */
export function toRecentListPayload(
  memories: Awaited<ReturnType<MemoryApiDeps["store"]["getRecent"]>>,
): { count: number; memories: unknown[] } {
  return {
    count: memories.length,
    memories: memories.map((m) => ({
      id: m.id,
      content: m.content,
      memoryType: m.memoryType,
      importance: m.importance,
      confidence: m.confidence,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      lastAccessedAt: m.lastAccessedAt,
      mentionCount: m.mentionCount,
    })),
  };
}

/**
 * POST /memories/batch-get · get_memory(ids) 가 공유하는 복수 id 조회 상한.
 *
 * search-service.ts 의 INDEX_MODE_LIMIT_MAX(=100) 와 값이 같지만 독립된 상수다 —
 * 그쪽은 index 모드 *응답 크기*(오탐 방지용 요약 항목 수) 튜닝값이고, 이 상수는
 * SQL `WHERE id IN (...)` 배치 조회의 파라미터 개수 상한(쿼리 규모·응답 payload
 * 크기 관점)이라 우연히 같은 숫자일 뿐 같은 개념이 아니다. 두 상수를 묶어두면
 * 한쪽을 튜닝할 때 다른 쪽이 리뷰 없이 조용히 같이 움직인다 — 단일 출처 원칙은
 * "같은 개념"에 적용하는 것이지 "우연히 같은 숫자"에 적용하는 것이 아니다.
 */
export const BATCH_GET_IDS_MAX = 100;

export interface BatchGetResult {
  memories: Array<Record<string, unknown> & { imageAttachments: ImageAttachment[] }>;
  notFound: number[];
}

/**
 * 복수 id 배치 조회 — REST `POST /memories/batch-get` 과 MCP `get_memory(ids)` 가
 * 공유하는 내부 서비스 함수(T22 / spec C). ONE 라운드트립(getNodesByIds 단일 쿼리) +
 * 요청 순서 보존 + notFound 정직 노출이 계약이다.
 *
 * getNodesByIds 는 `WHERE id IN (...)` 라 반환 순서가 요청 순서와 다를 수 있다
 * (compute-aggregate.ts 선례와 같은 특성) — 여기서 요청 순서로 재정렬한다. 존재하지
 * 않는 id 는 결과에서 조용히 빠지는 대신 notFound 배열에 담아 정직하게 알린다.
 *
 * imageAttachments 는 노드마다 listImageAttachments 를 순회 호출한다 — 이미지 첨부는
 * 드문 경우라(brief D-D) parent_of 인덱스 조회를 N번 도는 것이 배치 쿼리 신설보다
 * 낫다고 판단했다(단일 노드 조회 get_memory 의 기존 패턴과 동일 비용 구조를 유지).
 */
export async function batchGetMemories(
  store: MemoryApiDeps["store"],
  ids: readonly number[],
): Promise<BatchGetResult> {
  const nodes = await store.getNodesByIds(ids);
  const byId = new Map<number, MemoryNode>(nodes.map((n) => [n.id, n]));

  const memories: BatchGetResult["memories"] = [];
  const notFound: number[] = [];
  for (const id of ids) {
    const node = byId.get(id);
    if (!node) {
      notFound.push(id);
      continue;
    }
    memories.push({ ...node, imageAttachments: listImageAttachments(store, id) });
  }
  return { memories, notFound };
}

export function registerMemoriesCrudRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps; // 부팅 시점 고정 의존만 구조분해

  // ── POST /memories — 메모리 저장 ─────────────────────────────────────────
  //
  // 입력 통로 통합 Task 6 (spec §3 D1) — 글 저장을 공통 함수 saveTextInput 에 위임한다.
  // /ingest 텍스트 분기와 *같은 규칙*으로 원본 한 노드(원문 그대로, 안 잘림) + 길이
  // 조건부 청크 + 조건부 immediate 추출 + regex Level 0 atomic + mentions + author +
  // protectUntil 을 만든다. 라우트는 body 파싱 + saveTextInput 호출 + autoCleanupTrigger
  // 신호 + 응답 조립만 한다(저장 권위는 saveTextInput 한 곳).
  //
  // 추출 타이밍은 settings.llm.extractor 슬롯(enabled·mode)이, regex atomic 토글은
  // settings.extractor.regex.enabled 가 결정한다 — 둘 다 saveTextInput 인자로 넘긴다.
  // deps.getSettings / deps.extractor / deps.regexL0 / deps.autoCleanupTrigger 는
  // 호출 시점에 deps.xxx 로 lookup (구조분해 금지 — createMemoryApi 가 나중에 mutate).
  //
  // 응답 형식 호환(봇 api-client 는 `id` 칸만 읽음):
  //   - 짧은 글 + immediate 추출 가동 → { id, extracted, bumped, extractor, node }
  //   - 그 외(긴 글 / backfill / extractor 미가용) → { id, node }
  // immediate 추출이 가동됐는지는 saveResult.extracted 가 아니라 extractor 가용 +
  // mode 판정으로 가른다(regex atomic 도 extracted 에 들어가므로 extracted 길이로
  // 판정하면 backfill 인데 regex 만 잡힌 경우를 immediate 로 오인한다).
  app.post("/memories", async (c) => {
    let body: IngestBody;
    try {
      body = await c.req.json<IngestBody>();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (!isPositiveString(body.content)) {
      return err(c, 400, "content must be a non-empty string");
    }

    // SA-0 — 서버 관리 칸(sharedMemory·extracted·extractedTo)이 든 metadata 는 400.
    const metadata = parseClientMetadata(c, body.metadata);
    if (metadata instanceof Response) return metadata;

    const importance =
      typeof body.importance === "number" && Number.isFinite(body.importance)
        ? Math.max(0, Math.min(1, body.importance))
        : undefined;

    const memoryType: MemoryType | undefined =
      typeof body.memoryType === "string" &&
      ["fact", "preference", "triple", "insight", "episode"].includes(body.memoryType)
        ? (body.memoryType as MemoryType)
        : undefined;

    // SA-0 — 작성자는 토큰 권한으로 정한다. 근거가 있는 저장은 모든 토큰에서 adapterId,
    // 제한 토큰은 무근거 저장도 adapterId 이고 다른 author·metadata.user_id 는 403.
    // full 토큰(옛 scope 없는 토큰 포함)의 무근거 저장은 봇 중계를 위해 신고를 그대로 쓴다.
    const attribution = resolveRestAttribution(
      c,
      { author: body.author, metadata },
      { pinToToken: body.evidence !== undefined },
    );
    if (attribution instanceof Response) return attribution;
    const { author } = attribution;
    const platform = typeof body.platform === "string" ? body.platform : "";
    // 출처 키 구분자(설계 17.18 설계 7) — messageId·플랫폼에 `:` 가 있으면 다른 (메시지, 첨부) 쌍의 키와 섞이므로 저장 전에 400.
    const keyProblem = sourceKeyDelimiterResponse(c, { source: platform, author, metadata });
    if (keyProblem) return keyProblem;
    // 작성자 영구 ID는 저장·추출 경로에 보존한다. 사람 자동 연결 여부는
    // linkAuthorPerson이 출처별로 결정한다(Discord는 attribution만 보존).
    const { userId } = attribution;
    const projectId = normalizeProjectId(body.projectId ?? body.project);

    // settings snapshot 한 번 — extractor 슬롯(immediate 판정) + regex 토글 + 청크
    // 한도를 같은 호출 시점 값으로 읽는다(구조분해 금지 — deps.getSettings 동적 lookup).
    const settings = deps.getSettings?.();
    const extractorSlot = settings?.llm.extractor;

    let saveResult;
    try {
      const save = body.evidence === undefined ? saveTextInput :
        (target: typeof store, args: Parameters<typeof saveTextInput>[1]) => saveSharedMemoryInput(target, args, body.evidence as MemoryEvidenceInput);
      saveResult = await save(store, {
        content: body.content,
        // platform 을 입력 출처로 쓴다 — 봇은 "discord", 외부 SDK 는 빈 문자열. 옛
        // 흐름이 platform/author 를 노드에 반영하던 동작 정합(saveTextInput 이 source 를
        // platform 칸으로, author 를 author 칸으로 저장).
        source: platform,
        author,
        // Discord도 작성자 ID는 유지한다. ID 제거로 사람 자동 연결을 끄지 않는다.
        userId,
        memoryType,
        importance,
        // 봇·외부 SDK 가 보낸 metadata(messageId/channelId 등)를 원본 노드 metadata 에
        // 합친다 — deleteBySource 가 messageId 로 자식까지 지우는 흐름 보존. 고정 칸
        // (title/tags/protectUntil)은 saveTextInput 이 뒤에 둬 우선한다.
        extraMetadata: metadata,
        projectId,
        chunking: settings?.chunking
          ? {
              tokenCap: settings.chunking.tokenCap,
              minChunkTokens: settings.chunking.minChunkTokens,
            }
          : undefined,
        // immediate 추출 — extractor·settings 동적 lookup. saveTextInput 안에서
        // wantsImmediate(짧은 글 + enabled + mode='immediate') 판정 후에만 가동.
        extractor: deps.extractor,
        extractorSettings: extractorSlot,
        // regex Level 0 atomic — 토글 + regexL0 동적 lookup. 둘 다 만족 시에만 가동.
        regexL0: deps.regexL0,
        regexEnabled: settings?.extractor?.regex?.enabled === true,
        // 태그 wiring 입력 시점 이동(T2) — 태그 개념 노드 신규 작성 신호 통로.
        // deps.autoCleanupTrigger 동적 lookup(구조분해 금지). 미주입이면 no-op.
        trigger: deps.autoCleanupTrigger,
        // T15(결정 D-C) — 저장 관문 토글. 미주입(getSettings 없음)이면 관문이
        // 비밀값 검사를 가동한다(fail-safe).
        writeGuard: settings?.writeGuard,
        // T16(결정 D-A) — 유사-중복 검사 설정. 미주입이면 검사가 가동(fail-safe).
        duplicateCheck: settings?.writeGuard?.duplicateCheck,
        // force=true 면 "비슷한 기억이 있는 걸 알고도 따로 남긴다"는 명시 선택 —
        // 중복 검사만 건너뛴다(비밀값 관문·sanitize 는 못 넘는다).
        force: body.force === true,
      });
    } catch (e) {
      // 비밀값 거부는 사용자가 본문을 고쳐야 풀리는 문제라 400 + 구조화 본문으로
      // 회신한다(저장 실패 500 과 구분).
      if (e instanceof MemoryEvidenceError) return err(c, 400, e.message);
      const rejected = secretRejectionResponse(c, e);
      if (rejected) return rejected;
      // 유사-중복 거부는 이미 있는 기억과 부딪힌 것이라 409 + 구조화 본문(기존
      // 기억 id·닮은 정도·발췌)으로 회신한다 — 호출자가 갱신/force 를 고를 재료.
      const duplicate = duplicateRejectionResponse(c, e);
      if (duplicate) return duplicate;
      // WP-B1-08 — 준비한 즉시 추출 결과를 쓸 수 없게 된 요청(아무것도 저장 안 함)은 409 + 재전송 안내.
      const prepared = preparedExtractionConflictResponse(c, e);
      if (prepared) return prepared;
      const msg = e instanceof Error ? e.message : String(e);
      return err(c, 500, `메모리 저장 실패: ${msg}`);
    }

    // Phase 5.7.3 W3 — 외부 SDK 직접 호출 통로 신호. store.addNode 의
    // 'raw-memory-added' 와 같은 throttle 윈도우 안에서 흡수 — 두 reason 이 같은 한
    // 입력에 동시 송출되어도 가동 1회만. deps.autoCleanupTrigger 동적 lookup.
    deps.autoCleanupTrigger?.emit("external-sdk-write");
    notifyMemoSaved(deps, saveResult);

    if (saveResult.kind === "entity_patch") {
      deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "entity-patched" });
      return c.json(
        {
          type: "entity_patch",
          id: null,
          originNodeId: null,
          nodeIds: [],
          entities: saveResult.entities,
          warnings: saveResult.warnings,
        },
        201,
      );
    }

    const originNodeId = saveResult.originNodeId;
    if (originNodeId === null) {
      return err(c, 500, "메모리 저장 실패: origin node id 누락");
    }

    // 그래프 라이브 연출 2a — 새 글이 진짜 저장된 끝에서 graph_changed 를 발행한다.
    // 대시보드가 이 신호를 받아 overview 를 다시 받아 화면을 가만히 봐도 자란다.
    // 저장이 성공한 이 자리에서만 발행한다(에러 응답 경로는 여기 못 온다). eventBus
    // 미주입이면 no-op — 옛 흐름 보존. deps.eventBus 동적 lookup(다른 deps 와 같은 양식).
    deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "memory-added" });

    const node = await store.getNode(originNodeId);

    // immediate LLM 추출이 *실제로 가동·성공*한 경우만 extracted/bumped/extractor 칸을
    // 응답에 넣는다 — 옛 immediate 분기 응답 형식 보존. 추출 실패 fallback·긴 글·backfill·
    // extractor 미가용이면 saveResult.immediateExtractionRan 이 false 라 옛 { id, node }
    // 형식. deps.extractor 는 가동 성공 시 항상 존재하지만 응답 조립 안전을 위해 가드.
    if (saveResult.immediateExtractionRan && deps.extractor) {
      return c.json(
        {
          type: "memory",
          id: originNodeId,
          originNodeId,
          extracted: saveResult.extracted,
          bumped: saveResult.bumped,
          extractor: { provider: deps.extractor.llmName },
          // P0-A 입력 멱등성 — 정확-중복 재사용 여부. 봇 api-client 는 id 칸만 읽으므로
          // id 는 기존 노드 id 로 유지돼 호환된다(spec §5.1). cacheHit 은 성공 신호이지
          // 실패가 아니다. immediate 갈래는 프리체크로 재입력이면 이 분기에 안 오므로
          // 여기선 항상 false 지만, 계약 일관성을 위해 saveResult.cacheHit 를 그대로 싣는다.
          cacheHit: saveResult.cacheHit,
          node,
        },
        201,
      );
    }
    return c.json(
      { type: "memory", id: originNodeId, originNodeId, cacheHit: saveResult.cacheHit, node },
      201,
    );
  });

  // ── GET /memories — 최근 목록 ─────────────────────────────────────────────
  // Query: ?recent=N (1..100). Default 10.
  app.get("/memories", async (c) => {
    const recentParam = c.req.query("recent");
    const limit = parseLimit(recentParam, 10, 100);
    const memories = await store.getRecent(limit);
    return c.json(toRecentListPayload(memories));
  });

  // ── GET /memories/:id ────────────────────────────────────────────────────
  app.get("/memories/:id", async (c) => {
    const id = parseIntParam(c.req.param("id"));
    if (id === null) return err(c, 400, "id must be a positive integer");

    const node = await store.getNode(id);
    if (!node) return err(c, 404, `memory ${id} not found`);

    // place/places — 대시보드 검토 화면이 "현재 장소"를 보이려고 읽는다(추가형·기존 칸 불변).
    // 장소는 노드 칸이 아니라 분류·엔티티 엣지에 있어 따로 읽는다. 없으면 place:null, places:[].
    const places = listNodePlaces(store.getRawDb(), id);
    return c.json({
      memory: {
        ...node,
        editableContent: stripTagsForDisplay(node.content),
        imageAttachments: listImageAttachments(store, id),
        place: places[0] ?? null,
        places,
      },
    });
  });

  // ── POST /memories/batch-get — 복수 id 조회 (T22 / spec C) ────────────────
  //
  // ids 배열 하나로 여러 기억을 한 라운드트립에 받는다 — search_memory
  // responseMode:"index" 가 안내하는 "get_memory with ids" 포인터 문장(T21)을
  // 실제로 성립시키는 끝단. 본문(id: number 단일)은 GET /memories/:id 가 그대로
  // 맡고 있어 이 라우트는 새 표면(POST + 배열 body)으로 추가한다.
  app.post("/memories/batch-get", async (c) => {
    let body: { ids?: unknown };
    try {
      body = await c.req.json<{ ids?: unknown }>();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (
      !Array.isArray(body.ids) ||
      body.ids.length === 0 ||
      !body.ids.every((v) => typeof v === "number" && Number.isInteger(v) && v > 0)
    ) {
      return err(c, 400, "ids must be a non-empty array of positive integers");
    }
    // 상한 초과는 clamp(자름) 대신 reject(거부) 한다 — 자르면 호출자가 명시적으로
    // 지정한 id 목록 뒤쪽이 조용히 버려져 "요청했는데 안 왔다"는 사실이 응답
    // 어디에도 안 남는다. 이는 notFound 로 누락을 정직하게 알리는 이 함수의 계약과
    // 같은 원칙 계열이다 — 존재하지 않는 id 는 notFound 로 보여주지만, 존재해도
    // 상한 밖이라 조회조차 안 된 id 는 clamp 로는 구분이 안 된다(존재 안 함과
    // 혼동됨). 400 으로 거부하면 호출자가 요청을 나눠 재시도해야 함을 즉시 안다.
    if (body.ids.length > BATCH_GET_IDS_MAX) {
      return err(c, 400, `ids must contain at most ${BATCH_GET_IDS_MAX} entries`);
    }

    const result = await batchGetMemories(store, body.ids as number[]);
    return c.json(result);
  });

  // ── GET /memories/:id/revisions — 노드 변경 이력 (Phase 7 ④ Task 7) ───────
  // 한 노드에 붙은 revision(변경 이력) 전체를 시간 역순으로 노출한다. Task 6 이
  // conflict-checker supersede 시점에 memory_revisions 에 기록한 행을 *보이게* 하는
  // 조회 끝단이다. old_node_id·new_node_id 양쪽 매칭이라 옛 노드(바뀜)·새 노드(갱신함)
  // 어느 쪽 id 로 물어도 그 변경이 나온다. store.getRevisionsForNode 한 메서드 위임.
  //
  // 이력 없는 노드는 빈 배열을 회신한다 — 진짜 빈 상태(정상)이지 에러도 위장도 아니다.
  // (No-fallback: getRevisionsForNode 가 성공적으로 0행을 돌려준 정직한 빈 결과.)
  app.get("/memories/:id/revisions", async (c) => {
    const id = parseIntParam(c.req.param("id"));
    if (id === null) return err(c, 400, "id must be a positive integer");

    const revisions = await store.getRevisionsForNode(id);
    return c.json({ revisions });
  });
}
