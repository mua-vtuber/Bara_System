/**
 * routes/memories-append.ts — POST /memories/:id/append.
 *
 * routes/memories.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). 기존 노드에 새 글 노드를
 * saveTextInput 으로 저장한 뒤 links_to 엣지로 덧붙이는 라우트를 등록한다.
 *
 * 쓰기 잠금 경계(WP-B1-08, SL-7): 짧은 글 즉시 추출의 LLM 호출은 수십 초가 걸릴 수 있어
 * 잠금 밖에서 한다.
 *   잠금 밖  body 파싱·검증 → metadata·작성자 검사(SA-0) → 대상 노드 확인 →
 *            prepareImmediateExtraction(LLM 호출, DB 쓰기 없음).
 *   잠금 안  대상 노드 재조회(없으면 404, 현재 기억이 아니면 409) →
 *            saveTextInput(preparedExtraction — LLM 을 다시 부르지 않는다) → links_to 엣지.
 */

import type { Context, Hono } from "hono";
import { withMemoryMutationLock, withMemoryWriteActivity } from "../../memory/shared-memory-mutation-lock.ts";
import { isCurrentMemory } from "../../memory/shared-memory-contract.ts";
import type { MemoryApiDeps } from "../types.ts";
import { isPositiveString, parseIntParam, err } from "../http-helpers.ts";
import {
  prepareImmediateExtraction,
  saveTextInput,
  type PreparedImmediateExtraction,
  type SaveTextInputArgs,
} from "../save-input.ts";
import { secretRejectionResponse } from "../write-guard/write-guard-http.ts";
import { parseTags } from "../../memory/tag-extractor.ts";
import type { MemoryNode, MemoryType } from "../../memory/types.ts";
import { EVENT_TYPES } from "../event-bus.ts";
import { notifyMemoSaved } from "../memo-saved-cleanup.ts";
import { normalizeProjectId } from "../../memory/project-scope.ts";
import {
  optionalTrimmedString,
  parseClientMetadata,
  preparedExtractionConflictResponse,
  resolveRestAttribution,
  sourceKeyDelimiterResponse,
} from "./memories-shared.ts";

export function registerMemoriesAppendRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps; // 부팅 시점 고정 의존만 구조분해

  // ── POST /memories/:id/append — 기존 노드에 새 글 노드를 덧붙여 연결 ─────
  app.post("/memories/:id/append", (c) => withMemoryWriteActivity(store, async () => {
    const id = parseIntParam(c.req.param("id"));
    if (id === null) return err(c, 400, "id must be a positive integer");

    let body: {
      content?: unknown;
      reason?: unknown;
      metadata?: unknown;
      author?: unknown;
      platform?: unknown;
      projectId?: unknown;
      project?: unknown;
      importance?: unknown;
      memoryType?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (!isPositiveString(body.content)) {
      return err(c, 400, "content must be a non-empty string");
    }
    if (parseTags(body.content).cleanContent.trim().length === 0) {
      return err(c, 400, "append content must include searchable text");
    }
    // SA-0 — POST /memories 와 같은 신뢰 경계: 서버 관리 metadata 칸은 400, 제한 토큰의
    // 작성자는 adapterId(다른 author·metadata.user_id 는 403).
    const metadata = parseClientMetadata(c, body.metadata);
    if (metadata instanceof Response) return metadata;
    const attribution = resolveRestAttribution(c, { author: body.author, metadata });
    if (attribution instanceof Response) return attribution;

    const target = await store.getNode(id);
    const targetProblem = appendTargetProblem(c, id, target);
    if (targetProblem) return targetProblem;

    const { author, userId } = attribution;
    const platform = typeof body.platform === "string" ? body.platform : "";
    // 출처 키 구분자(설계 17.18 설계 7) — POST /memories 와 같은 400.
    const keyProblem = sourceKeyDelimiterResponse(c, { source: platform, author, metadata });
    if (keyProblem) return keyProblem;
    const reason = optionalTrimmedString(body.reason);
    const requestedProjectId = normalizeProjectId(body.projectId ?? body.project);
    const projectId = requestedProjectId ?? target!.projectId;
    const settings = deps.getSettings?.();
    const extractorSlot = settings?.llm.extractor;
    const importance =
      typeof body.importance === "number" && Number.isFinite(body.importance)
        ? Math.max(0, Math.min(1, body.importance))
        : undefined;
    const memoryType: MemoryType | undefined =
      typeof body.memoryType === "string" &&
      ["fact", "preference", "triple", "insight", "episode"].includes(body.memoryType)
        ? (body.memoryType as MemoryType)
        : undefined;

    const saveArgs: SaveTextInputArgs = {
      content: body.content,
      source: platform,
      author,
      userId,
      memoryType,
      importance,
      extraMetadata: {
        ...metadata,
        appendedTo: id,
        ...(reason ? { appendReason: reason } : {}),
      },
      projectId,
      chunking: settings?.chunking
        ? {
            tokenCap: settings.chunking.tokenCap,
            minChunkTokens: settings.chunking.minChunkTokens,
          }
        : undefined,
      extractor: deps.extractor,
      extractorSettings: extractorSlot,
      regexL0: deps.regexL0,
      regexEnabled: settings?.extractor?.regex?.enabled === true,
      trigger: deps.autoCleanupTrigger,
      // T15(결정 D-C) — 저장 관문 토글. 미주입이면 관문이 가동(fail-safe).
      writeGuard: settings?.writeGuard,
    };

    // 잠금 밖 — 즉시 추출 갈래면 LLM 까지 준비한다. 즉시 추출이 아니면 undefined.
    let prepared: PreparedImmediateExtraction | undefined;
    try {
      prepared = await prepareImmediateExtraction(store, saveArgs);
    } catch (e) {
      return appendSaveFailure(c, e);
    }

    return withMemoryMutationLock(store, async () => {
      // 잠금 안 — 준비하는 동안 대상이 지워졌거나 철회됐을 수 있다.
      const current = await store.getNode(id);
      const currentProblem = appendTargetProblem(c, id, current);
      if (currentProblem) return currentProblem;
      if (requestedProjectId === null && current!.projectId !== projectId) {
        return err(c, 409, `memory ${id} moved to another project while the append was prepared`);
      }

      let saveResult;
      try {
        saveResult = await saveTextInput(store, {
          ...saveArgs,
          ...(prepared !== undefined ? { preparedExtraction: prepared } : {}),
        });
      } catch (e) {
        return appendSaveFailure(c, e);
      }

      if (saveResult.kind === "entity_patch" || saveResult.originNodeId === null) {
        return err(c, 400, "append content must create a memory node");
      }
      notifyMemoSaved(deps, saveResult);

      await store.addEdge({
        sourceId: saveResult.originNodeId,
        targetId: id,
        relation: "links_to",
        provenance: "user_input",
        sourceNodeId: saveResult.originNodeId,
        weight: 1.0,
      });
      deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, {
        reason: "memory-appended",
        nodeId: saveResult.originNodeId,
        targetId: id,
      });

      const node = await store.getNode(saveResult.originNodeId);
      return c.json(
        {
          targetId: id,
          appendedId: saveResult.originNodeId,
          node,
          nodeIds: saveResult.nodeIds,
          extracted: saveResult.extracted,
          bumped: saveResult.bumped,
          warnings: saveResult.warnings,
        },
        201,
      );
    });
  }));
}

/** 덧붙일 대상이 없으면 404, 현재 기억이 아니면(철회·대체·기간 밖) 409. 문제없으면 null. */
function appendTargetProblem(c: Context, id: number, target: MemoryNode | null): Response | null {
  if (!target) return err(c, 404, `memory ${id} not found`);
  if (!isCurrentMemory(target.metadata)) return err(c, 409, `memory ${id} is not a current memory`);
  return null;
}

/**
 * 준비·저장 실패 응답 — 비밀값은 400 구조화 본문, 준비 결과를 쓸 수 없게 된 요청은 409 + code
 * (아무것도 저장 안 함, 재전송 안내), 그 밖은 500(옛 문자열 그대로).
 */
function appendSaveFailure(c: Context, e: unknown): Response {
  const rejected = secretRejectionResponse(c, e);
  if (rejected) return rejected;
  const prepared = preparedExtractionConflictResponse(c, e);
  if (prepared) return prepared;
  const msg = e instanceof Error ? e.message : String(e);
  return err(c, 500, `메모리 추가 기록 실패: ${msg}`);
}
