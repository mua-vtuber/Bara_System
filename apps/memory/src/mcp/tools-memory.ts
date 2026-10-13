/**
 * mcp/tools-memory.ts — 기본 검색·저장 도구 4종 (spec 5.1).
 * REST 재노출 원칙: HTTP 자기호출 없이 같은 내부 서비스 함수를 부른다 —
 * search_memory=runSearchPipeline / get_memory=store.getNode(+listImageAttachments) /
 * list_recent=store.getRecent(+toRecentListPayload) / store_memory=saveTextInput.
 * search_memory 는 D-5 확정대로 POST /search body 세부 칸 전부를 선택 입력으로
 * 노출한다(미전달 = REST 칸 부재와 동일 동작). author 는 입력 칸이 아니다 —
 * 서버가 토큰 유래 adapterId 로 기록한다(spec 7.3).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SearchBody } from "../server-internal/types.ts";
import {
  runSearchPipeline,
  SearchInputError,
} from "../server-internal/routes/search-service.ts";
import {
  listImageAttachments,
  toRecentListPayload,
  batchGetMemories,
  BATCH_GET_IDS_MAX,
} from "../server-internal/routes/memories-crud.ts";
import { saveSharedMemoryInput, memoryEvidenceSchema, MemoryEvidenceError, listMemoryEvidence } from "../server-internal/shared-memory-write.ts";
import { memoryReadScopeSchema, readSharedMemoryForNode } from "../memory/shared-memory-contract.ts";
import { rowToNode } from "../db/store-internal/helpers.ts";
import type { KnowledgeNodeRow } from "../db/store-internal/row-types.ts";
import { canUseMcpTool } from "./access.ts";
import { readMemoryVisibility } from "../memory/shared-memory-read.ts";
import { listOpenConflicts, listOriginMarks } from "../memory/open-conflicts.ts";
import { SecretDetectedError } from "../server-internal/write-guard/write-guard.ts";
import { PreparedExtractionMismatchError } from "../server-internal/save-input.ts";
import { messageSourceInputProblem } from "../memory/node-sources/source-ref.ts";
import { DuplicateMemoryError } from "../server-internal/write-guard/duplicate-check.ts";
import { notifyMemoSaved } from "../server-internal/memo-saved-cleanup.ts";
import { EVENT_TYPES } from "../server-internal/event-bus.ts";
import type { MemoryType } from "../memory/types.ts";
import { TOOL_DESCRIPTIONS } from "./descriptions.ts";
import { TOOL_ANNOTATIONS } from "./annotations.ts";
import {
  MCP_SOURCE,
  requireAdapterId,
  toolError,
  toolJson,
  type McpToolContext,
} from "./server.ts";

const MEMORY_TYPE_ENUM = z.enum(["fact", "preference", "triple", "insight", "episode"]);

/**
 * spec 5.1 칸 목록 그대로 — 전부 선택, memoryType 은 camelCase 한 칸만(별칭 이중 칸 금지).
 * 통과형 스키마(spec 5.1 D-5): 범위·enum 제약을 MCP 층에서 걸지 않는다 — 무효 값
 * (limit 0·polarity 오타·memoryType 미지원 등)은 runSearchPipeline 의 REST 공유 방어
 * 파싱이 조용히 미적용한다. query 검증(비어 있음·비문자열)도 SearchInputError 경유로
 * REST 와 같은 400 문구가 toolError 로 회신된다 — description 문안("invalid values are
 * ignored the same way the REST API ignores them")과 이 스키마는 한 몸이다.
 */
const SEARCH_MEMORY_SHAPE = {
  query: z.string(),
  limit: z.number().optional(),
  contextBudget: z.number().optional(),
  project: z.string().optional(),
  scope: memoryReadScopeSchema.optional(),
  includeInactive: z.boolean().optional(),
  polarity: z.string().optional(),
  filter: z.record(z.string(), z.string()).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  place: z.string().optional(),
  withSummaries: z.boolean().optional(),
  memoryType: z.string().optional(),
  kind: z.string().optional(),
  fieldFilters: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  imageSearch: z.boolean().optional(),
  relaxFilters: z.boolean().optional(),
  /**
   * T21(spec C) — 2단계 검색 토글. 이 칸만 예외적으로 enum + 설명문을 단다.
   *
   * 위 통과형 칸들과 달리 여기에 enum 을 두는 이유: 나머지 칸은 무효값이 "필터
   * 미적용"으로 조용히 떨어져도 회신 *양식* 이 같지만, responseMode 오타는 AI 가
   * 색인을 기대하고 본문 전체를 받는 양식 착오를 만든다. 오타를 호출 시점에
   * 되돌려주는 편이 정직하다(runSearchPipeline 의 방어 파싱은 REST 통로를 위해
   * 그대로 유지 — 두 겹 다 full 로 떨어진다).
   *
   * 설명문을 도구 description(TOOL_DESCRIPTIONS)이 아니라 *스키마 칸* 에 두는
   * 이유: 도구 설명문은 세션 초기화마다 전량 지불되는 토큰이고 90단어 예산이
   * 걸려 있다(mcp/server.test.ts 문안 길이 예산). 칸 설명문은 그 예산 밖이고
   * 기존 문안 고정(DESCRIPTION_PINS)도 건드리지 않는다.
   */
  responseMode: z
    .enum(["full", "index"])
    .optional()
    .describe(
      "full (default) returns complete memory content. index returns only " +
        "{id, memoryType, oneLine, entities, date, score} plus a pointer sentence — " +
        "use it to survey what exists, then call get_memory with the ids you need. " +
        "index skips heavy post-processing and allows a higher limit (max 100).",
    ),
};

export function registerMemoryTools(server: McpServer, ctx: McpToolContext): void {
  const { deps } = ctx;

  server.registerTool(
    "search_memory",
    {
      description: TOOL_DESCRIPTIONS.search_memory,
      annotations: TOOL_ANNOTATIONS.search_memory,
      inputSchema: SEARCH_MEMORY_SHAPE,
    },
    async (args) => {
      if (!canUseMcpTool(ctx.scope, "search_memory")) return toolError("FORBIDDEN", "search_memory is not allowed by this token");
      try {
        const response = await runSearchPipeline(
          deps,
          args as SearchBody,
          new URLSearchParams(),
          // T20(spec F / 단락 11 확정 3) — 여기가 AI 경로라 결과 하한선을 켠다.
          // 명시 플래그다: runSearchPipeline 이 호출자 정체를 추측해 조용히
          // 갈리지 않는다. 대시보드가 쓰는 REST /search 는 이 옵션을 안 넘겨
          // 전체 표시를 유지한다(사람 눈 탐색은 낮은 점수도 단서로 쓴다).
          // 하한선에 전부 걸리면 0건 회신 — processing_info 의 totalFound 와
          // afterFiltering 이 "있었지만 관련 있는 게 없음"을 구분해 보여준다.
          { applyResultFloor: true },
        );
        return toolJson(response);
      } catch (e) {
        if (e instanceof SearchInputError) return toolError("INVALID_INPUT", e.message);
        return toolError("INTERNAL", `검색 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "get_memory",
    {
      description: TOOL_DESCRIPTIONS.get_memory,
      annotations: TOOL_ANNOTATIONS.get_memory,
      inputSchema: {
        id: z.number().int().min(1).optional(),
        // T22(spec C) — search_memory responseMode:"index" 가 안내하는 포인터 문장
        // ("get_memory with ids")을 실제로 성립시킨다. id 와는 상호 배타적 — 단건은
        // 기존 id 칸, 복수는 이 칸(REST POST /memories/batch-get 과 같은 상한).
        // .max() 초과는 zod 검증 실패(reject)로 떨어진다 — clamp 하지 않는 이유는
        // memories-crud.ts 의 BATCH_GET_IDS_MAX 상한 검증 주석 참조(존재하지 않아
        // notFound 로 뜨는 id 와, 상한 밖이라 조회조차 안 된 id 를 혼동시키지 않기 위함).
        ids: z
          .array(z.number().int().min(1))
          .min(1)
          .max(BATCH_GET_IDS_MAX)
          .optional()
          .describe(
            `Fetch multiple memories in one call (max ${BATCH_GET_IDS_MAX}). ` +
              "Mutually exclusive with `id` — use exactly one. Missing ids are " +
              "reported honestly in `notFound` rather than silently dropped.",
          ),
      },
    },
    async (args) => {
      if (!canUseMcpTool(ctx.scope, "get_memory")) return toolError("FORBIDDEN", "get_memory is not allowed by this token");
      const hasId = args.id !== undefined;
      const hasIds = args.ids !== undefined;
      if (hasId === hasIds) {
        return toolError(
          "INVALID_INPUT",
          "id 와 ids 중 정확히 하나만 지정해야 합니다",
        );
      }

      if (hasIds) {
        const result = await batchGetMemories(deps.store, args.ids!);
        const visible = readMemoryVisibility(deps.store).allowedIds;
        const idNumbers = result.memories.map((node) => Number(node.id));
        // WP-B1-10(SL-3 표시) — 표시 대상 전체를 한 번의 일괄 질의로 조회해 N+1을 피한다.
        const openConflicts = listOpenConflicts(deps.store.getRawDb(), idNumbers);
        // WP-B1-10R — 원문(auto_capture 등)에 자식 계보 표시를 함께 싣는다(같은 일괄 질의 원칙).
        const originMarks = listOriginMarks(deps.store.getRawDb(), idNumbers);
        return toolJson({ ...result, memories: result.memories.map((node) => {
          const { records, omitted } = listMemoryEvidence(deps.store, Number(node.id));
          const omittedCount = omitted.malformed + omitted.unsafe;
          const marks = originMarks.get(Number(node.id));
          return {
            ...node, sharedMemory: readSharedMemoryForNode({
              sourceType: node.sourceType as string, metadata: node.metadata as Record<string, unknown>,
            }),
            evidence: records,
            ...(omittedCount > 0 ? { evidenceOmitted: omitted } : {}),
            current: visible === undefined || visible.has(Number(node.id)),
            conflicts: openConflicts.get(Number(node.id)) ?? [],
            ...(marks ? { originMarks: marks } : {}),
          };
        }) });
      }

      const node = await deps.store.getNode(args.id!);
      if (!node) return toolError("NOT_FOUND", `memory ${args.id} not found`);
      const visible = readMemoryVisibility(deps.store).allowedIds;
      const { records, omitted } = listMemoryEvidence(deps.store, node.id);
      const omittedCount = omitted.malformed + omitted.unsafe;
      const openConflicts = listOpenConflicts(deps.store.getRawDb(), [node.id]);
      // WP-B1-10R — 원문(auto_capture 등)에 자식 계보 표시를 함께 싣는다.
      const originMarks = listOriginMarks(deps.store.getRawDb(), [node.id]).get(node.id);
      return toolJson({
        memory: {
          ...node, sharedMemory: readSharedMemoryForNode(node),
          current: visible === undefined || visible.has(node.id),
          evidence: records,
          ...(omittedCount > 0 ? { evidenceOmitted: omitted } : {}),
          imageAttachments: listImageAttachments(deps.store, args.id!),
          conflicts: openConflicts.get(node.id) ?? [],
          ...(originMarks ? { originMarks } : {}),
        },
      });
    },
  );

  server.registerTool(
    "list_recent",
    {
      description: TOOL_DESCRIPTIONS.list_recent,
      annotations: TOOL_ANNOTATIONS.list_recent,
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        scope: memoryReadScopeSchema.optional(),
        includeInactive: z.boolean().optional(),
      },
    },
    async (args) => {
      if (!canUseMcpTool(ctx.scope, "list_recent")) return toolError("FORBIDDEN", "list_recent is not allowed by this token");
      const visible = readMemoryVisibility(deps.store, args.scope, args.includeInactive).allowedIds;
      const rows = deps.store.getRawDb().query(`SELECT * FROM knowledge_nodes
        WHERE source_type NOT IN ('document_chunk', 'llm_extract', 'image_caption')
        ORDER BY created_at DESC, id DESC`)
        .iterate() as Iterable<KnowledgeNodeRow>;
      const memories = [];
      for (const row of rows) {
        const node = rowToNode(row);
        if (visible !== undefined && !visible.has(node.id)) continue;
        memories.push(node);
        if (memories.length >= (args.limit ?? 10)) break;
      }
      const payload = toRecentListPayload(memories);
      return toolJson({ ...payload, memories: memories.map((node, i) => ({
        ...(payload.memories[i] as Record<string, unknown>), projectId: node.projectId,
        sharedMemory: readSharedMemoryForNode(node),
      })) });
    },
  );

  server.registerTool(
    "store_memory",
    {
      description: TOOL_DESCRIPTIONS.store_memory,
      annotations: TOOL_ANNOTATIONS.store_memory,
      inputSchema: {
        content: z.string().min(1),
        memoryType: MEMORY_TYPE_ENUM.optional(),
        importance: z.number().min(0).max(1).optional(),
        project: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        evidence: memoryEvidenceSchema.optional(),
        // T16(결정 D-A) — 유사-중복 차단 우회. 호출 AI 가 DUPLICATE 회신을 받고도
        // "따로 남길 기억이 맞다"고 판단했을 때만 켠다.
        force: z.boolean().optional(),
      },
    },
    async (args) => {
      if (!canUseMcpTool(ctx.scope, "store_memory")) return toolError("FORBIDDEN", "store_memory is not allowed by this token");
      try {
        const adapterId = requireAdapterId(ctx);
        // 출처 키 구분자(설계 17.18 설계 7) — REST 저장 경계와 같은 문구의 도구 오류.
        const keyProblem = messageSourceInputProblem({ source: MCP_SOURCE, author: adapterId, metadata: args.metadata });
        if (keyProblem !== null) return toolError("INVALID_INPUT", keyProblem);
        const settings = deps.getSettings?.();
        const saved = await saveSharedMemoryInput(deps.store, {
          content: args.content,
          source: MCP_SOURCE,
          // author = 토큰 유래 adapterId(spec 7.3). userId 는 비운다 — AI 클라이언트를
          // 사람 노드로 연결하지 않는다(linkAuthorPerson 은 userId 없으면 no-op).
          author: adapterId,
          memoryType: args.memoryType as MemoryType | undefined,
          importance: args.importance,
          extraMetadata: args.metadata,
          projectId: args.project ?? null,
          chunking: settings?.chunking
            ? {
                tokenCap: settings.chunking.tokenCap,
                minChunkTokens: settings.chunking.minChunkTokens,
              }
            : undefined,
          extractor: deps.extractor,
          extractorSettings: settings?.llm.extractor,
          regexL0: deps.regexL0,
          regexEnabled: settings?.extractor?.regex?.enabled === true,
          trigger: deps.autoCleanupTrigger,
          // T15(결정 D-C) — 저장 관문 토글. 미주입이면 관문이 가동(fail-safe).
          writeGuard: settings?.writeGuard,
          // T16(결정 D-A) — 유사-중복 검사 설정 + 우회 플래그.
          duplicateCheck: settings?.writeGuard?.duplicateCheck,
          force: args.force === true,
        }, args.evidence);
        // memories-crud.ts:233 과 같은 위치·같은 조건 — kind 분기 앞에서 무조건 emit
        // 한다(entity_patch 포함, REST 동형 계약, review Fix 2). deps.autoCleanupTrigger
        // 동적 lookup(구조분해 금지) — 미주입이면 no-op.
        deps.autoCleanupTrigger?.emit("external-sdk-write");
        notifyMemoSaved(deps, saved);
        if (saved.kind === "entity_patch") {
          // REST 201 entity_patch 응답과 같은 칸 — 도구 계약(id·originNodeId·cacheHit)의
          // 경계 사례를 REST 직렬화 그대로 정직 회신한다(spec "기존 REST 재노출").
          // memories-crud.ts:236 과 같은 조건·같은 이벤트 — MCP 저장도 REST 저장과
          // 똑같이 대시보드 라이브 그래프를 갱신시킨다(review Fix 1).
          deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "entity-patched" });
          return toolJson({
            type: "entity_patch",
            id: null,
            originNodeId: null,
            nodeIds: [],
            entities: saved.entities,
            warnings: saved.warnings,
          });
        }
        if (saved.originNodeId === null) {
          return toolError("INTERNAL", "메모리 저장 실패: origin node id 누락");
        }
        // memories-crud.ts:259 와 같은 조건·같은 이벤트(review Fix 1) — 저장 성공
        // 시점에서만 발행(에러 응답 경로는 여기 못 온다). eventBus 미주입이면 no-op.
        deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "memory-added" });
        // REST POST /memories 성공 응답과 같은 칸(review Fix 2) — MCP 도구도
        // { type, id, originNodeId, cacheHit, node } 전 칸을 그대로 회신한다.
        const node = await deps.store.getNode(saved.originNodeId);
        const visible = readMemoryVisibility(deps.store).allowedIds;
        const { records, omitted } = listMemoryEvidence(deps.store, saved.originNodeId);
        const omittedCount = omitted.malformed + omitted.unsafe;
        return toolJson({
          type: "memory",
          id: saved.originNodeId,
          originNodeId: saved.originNodeId,
          cacheHit: saved.cacheHit,
          node,
          current: visible === undefined || visible.has(saved.originNodeId),
          evidence: records,
          ...(omittedCount > 0 ? { evidenceOmitted: omitted } : {}),
        });
      } catch (e) {
        if (e instanceof MemoryEvidenceError) return toolError(e.code, e.message);
        // WP-B1-08 — 준비한 즉시 추출 결과를 쓸 수 없게 된 요청(아무것도 저장 안 함) — REST 409 와 같은
        // CONFLICT code 와 재전송 안내 메시지.
        if (e instanceof PreparedExtractionMismatchError) return toolError(e.code, e.message);
        // T15 — 비밀값 거부는 서버 결함이 아니라 보낸 본문 문제라 SECRET_DETECTED
        // 로 구분해 회신한다(REST 400 과 같은 code·message·details).
        if (e instanceof SecretDetectedError) {
          const payload = e.toPayload();
          return toolError(payload.code, payload.message, payload.details);
        }
        // T16 — 유사-중복 거부도 서버 결함이 아니라 이미 있는 기억과 부딪힌
        // 것이라 DUPLICATE 로 구분해 회신한다(REST 409 와 같은 code·message·
        // details). 호출 AI 는 details.existingId 로 기존 기억을 고치거나
        // force:true 로 다시 보낼 수 있다.
        if (e instanceof DuplicateMemoryError) {
          const payload = e.toPayload();
          return toolError(payload.code, payload.message, payload.details);
        }
        return toolError(
          "INTERNAL",
          `메모리 저장 실패: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );
}
