/**
 * routes/memories-edit.ts — PATCH /memories/:id 수동 편집 + POST /memories/:id/tags.
 *
 * routes/memories.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). 같은 노드 id 를 유지하는
 * 본문 수동 편집과, 본문 수정과 분리된 키워드 태그 추가 두 라우트를 등록한다.
 * 등록 순서·핸들러 로직·에러 문자열은 옛 파일 그대로(동작 불변).
 *
 * T15(결정 D-C + T12 인계) — 본문을 바꾸는 두 라우트(PATCH by-source · PATCH :id)는
 * saveTextInput 을 거치지 않는 우회 저장 통로였다. 이제 둘 다 저장 경로와 같은
 * applyWriteGuard 를 지나 비밀값을 거부하고 울타리 태그를 씻는다. POST :id/tags 는
 * 자유 서술을 받지 않고(태그 이름 양식 검증 통과분만) 본문은 이미 DB 에 있던 값을
 * 재조립하는 것이라 관문 대상이 아니다.
 */

import type { Hono } from "hono";
import { withMemoryMutationLock } from "../../memory/shared-memory-mutation-lock.ts";
import { SharedMemoryMutationError } from "../../memory/shared-memory-mutation-error.ts";
import { readSharedMemory } from "../../memory/shared-memory-contract.ts";
import type { MemoryApiDeps } from "../types.ts";
import { isPositiveString, parseIntParam, err } from "../http-helpers.ts";
import {
  extractHashtagTokens,
  hasHashtagSyntax,
  parseTags,
  stripTagsForDisplay,
} from "../../memory/tag-extractor.ts";
import { EVENT_TYPES } from "../event-bus.ts";
import { applyWriteGuard } from "../write-guard/write-guard.ts";
import { secretRejectionResponse } from "../write-guard/write-guard-http.ts";
import { parseCapture } from "./capture.ts";
import {
  UNEDITABLE_SOURCE_TYPES,
  contentWithPreservedTags,
  normalizeEditableBody,
  normalizePlainTagInput,
  optionalTrimmedString,
  recheckEditedNodeConflicts,
  resolveRestWriter,
  rewireEditedNodeContent,
} from "./memories-shared.ts";
import { applyBySourceEdit } from "./memories-edit-split.ts";
import { readBySourceEditTargets, withAttachmentRemoval } from "./memories-edit-attachments.ts";
import { sourceKeyPartProblem } from "../../memory/node-sources/source-ref.ts";
import type { Context } from "hono";

/**
 * PATCH·POST 편집 라우트 공용 행위자 결정 (SA-1). resolveRestWriter 를 editor 에
 * 적용한다 — MCP 수정 도구가 행위자를 토큰에서 고정하는 것과 같은 규칙을 REST 편집도
 * 따라야 다른 신원을 사칭한 수정 이력이 남지 않는다.
 *
 * editSource 는 by-source 라우트에서 platform 값으로도 채워지지만, 그 폴백은 제한
 * 토큰에는 적용하지 않는다 — 제한 토큰의 editSource 는 항상 "api" 고정이고, body 가
 * 다른 값을 신고하면(편집자와 같은 신뢰 경계이므로) 403 이다.
 */
function resolveEditActor(
  c: Context,
  body: { editor?: unknown; editSource?: unknown; source?: unknown },
  editSourceFallback: string,
): { editor: string | null; editSource: string } | Response {
  const writer = resolveRestWriter(c, body.editor, { field: "editor" });
  if (writer instanceof Response) return writer;

  const claimedEditSource = optionalTrimmedString(body.editSource) ?? optionalTrimmedString(body.source);
  if (writer.restricted) {
    if (claimedEditSource !== null && claimedEditSource !== "api") {
      return c.json({ code: "FORBIDDEN", error: "제한 토큰은 editSource를 지정할 수 없습니다" }, 403);
    }
    return { editor: writer.writer, editSource: "api" };
  }
  return {
    editor: optionalTrimmedString(body.editor),
    editSource: claimedEditSource ?? editSourceFallback,
  };
}

interface BySourceEditBody {
  messageId?: unknown;
  platform?: unknown;
  content?: unknown;
  attachmentIds?: unknown;
  reason?: unknown;
  editor?: unknown;
  source?: unknown;
  editSource?: unknown;
  expectedRevision?: unknown;
}

export function registerMemoriesEditRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps; // 부팅 시점 고정 의존만 구조분해

  // ── PATCH /memories/by-source — 외부 메시지 수정과 동기화 ────────────────
  // Discord MessageUpdate 등 외부 surface가 원본 메시지를 고쳤을 때 호출.
  // 그 메시지의 출처 행을 가진 노드 중 원본 auto_capture 만 대상이고, llm_extract 같은 파생
  // 노드는 의미를 보존하기 위해 덮어쓰지 않는다. 대상이 다른 출처(다른 메시지·대시보드·AI
  // 저장)도 가졌으면 덮지 않고 새 노드로 분리한다(WP-B1-20T 설계 5.6, memories-edit-split.ts).
  //
  // 등록 순서 주의: `/memories/:id` 보다 먼저 와야 한다 — Hono 는 등록 순서대로
  // 시도하므로 뒤에 두면 `:id` 매처가 "by-source"를 id 로 받아 400 으로 떨어진다.
  app.patch("/memories/by-source", async (c) => withMemoryMutationLock(store, async () => {
    let body: BySourceEditBody;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    // WP-B1-20U 설계 17.9 — content·attachmentIds 중 하나는 있어야 한다(memories-edit-attachments.ts).
    const targets = readBySourceEditTargets(c, body);
    if (targets instanceof Response) return targets;

    const expectedRevision = body.expectedRevision;
    if (expectedRevision !== undefined && (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      return err(c, 400, "expectedRevision must be a non-negative integer");
    }

    const messageId = targets.messageId;
    const platform = optionalTrimmedString(body.platform);
    // 출처 키 구분자(설계 17.18 설계 7) — 플랫폼의 `:` 는 출처 키의 칸과 섞이므로 400(messageId·첨부 id 는 readBySourceEditTargets).
    const platformProblem = sourceKeyPartProblem("platform", platform);
    if (platformProblem !== null) return err(c, 400, platformProblem);
    // T15(결정 D-C + T12 인계) — 편집도 사용자 글이 DB 로 들어가는 통로다. 저장과
    // 같은 관문을 지나게 해 비밀값을 거부하고 울타리 태그를 씻는다. 관문이 먼저다 —
    // 거부될 편집이 노드 조회·정리 비용을 먼저 치르지 않게 한다.
    let guardedContent: string | null;
    let guardedReason: string | null;
    try {
      guardedContent = targets.content === null ? null : applyWriteGuard(targets.content, deps.getSettings?.().writeGuard);
      const claimedReason = optionalTrimmedString(body.reason);
      guardedReason = claimedReason === null
        ? null
        : applyWriteGuard(claimedReason, deps.getSettings?.().writeGuard);
    } catch (e) {
      const rejected = secretRejectionResponse(c, e);
      if (rejected) return rejected;
      throw e;
    }
    const nextStoredContent = guardedContent === null ? null : normalizeEditableBody(guardedContent);
    const reason = guardedReason ?? "external source edit";

    // SA-1 — editor·editSource 도 저장 작성자와 같은 신뢰 경계를 탄다: 제한 토큰은
    // 토큰 adapterId·"api" 로 고정되고 다른 값을 신고하면 403.
    const actor = resolveEditActor(c, body, platform ?? "api");
    if (actor instanceof Response) return actor;
    const { editor, editSource } = actor;

    const matched = nextStoredContent === null ? [] : await store.findNodesBySource({ messageId, platform: platform ?? undefined });
    // WP-B1-20U 설계 17.8 — 고칠 대상은 이 메시지의 글 행을 가진 auto_capture 노드다. 같은 메시지의 첨부 행만 가진
    // 노드(문서·이미지, 다른 저장에 흡수된 첨부)는 글을 고쳐도 그대로라 건너뛴다.
    const sources = store.readMessageSources({ messageId, platform: platform ?? undefined });
    const editable: typeof matched = [];
    const skippedIds: number[] = [];
    for (const node of matched) {
      if (node.sourceType === "auto_capture" && sources.get(node.id)!.messageRows.length > 0) editable.push(node);
      else skippedIds.push(node.id);
    }

    if (editable.length === 0 || nextStoredContent === null) {
      return c.json(await withAttachmentRemoval(store, targets, platform, {
        changed: false,
        messageId,
        platform,
        matchedCount: matched.length,
        editedCount: 0,
        editedIds: [],
        skippedIds,
        revisions: [],
        warnings:
          matched.length > 0
            ? ["matching source nodes exist, but no editable auto_capture node was found"]
            : [],
        splits: [],
      }));
    }

    // SL-6 — 편집 전에 대상 auto_capture 노드 *전부*의 revision 을 먼저 확인한다.
    // 예전에는 노드마다 확인 직후 바로 커밋해, 뒤 노드에서 409 가 나면 앞 노드는
    // 이미 바뀐 채로 남았다. 하나라도 어긋나면 아무것도 쓰지 않고 409 + 전체
    // conflicts 목록을 돌려준다. 라우트 전체가 withMemoryMutationLock 안이라
    // 확인과 적용 사이에 다른 잠금 쓰기가 끼지 않는다.
    if (expectedRevision !== undefined) {
      const revisions = editable.map((existing) => ({
        nodeId: existing.id,
        currentRevision: readSharedMemory(existing.metadata).revision,
      }));
      const hasMismatch = revisions.some((entry) => entry.currentRevision !== expectedRevision);
      // QA Medium(WP-B1-05R) — WP-B1-05 완료 기준대로 대상 auto_capture 노드
      // *전부*의 {nodeId, currentRevision} 을 돌려준다. 예전에는 어긋난 노드만
      // 걸러 담아, 호출자가 "무엇과 비교해 어긋났는지"를 판단하는 데 필요한
      // 일치하는 노드의 currentRevision 을 알 수 없었다(아무것도 안 쓴다는
      // 계약은 이미 지켜지고 있었다 — 응답 정보량만 부족했다).
      if (hasMismatch) {
        return c.json({ code: "CONFLICT", error: "memory changed since it was read", conflicts: revisions }, 409);
      }
    }

    // WP-B1-20T 설계 5.6 — 대상마다 같은 id 편집, 또는 다른 출처도 가진 노드면 분리(memories-edit-split.ts).
    const applied = await applyBySourceEdit(c, deps, {
      messageId, platform, editable, nextStoredContent, expectedRevision, reason, editor, editSource, sources,
    });
    if (applied instanceof Response) return applied;
    const { editedIds, revisions, warnings, splits } = applied;

    return c.json(await withAttachmentRemoval(store, targets, platform, {
      changed: editedIds.length > 0 || splits.length > 0,
      messageId,
      platform,
      matchedCount: matched.length,
      editedCount: editedIds.length,
      editedIds,
      skippedIds: [...skippedIds, ...applied.skippedIds],
      revisions,
      warnings,
      splits,
    }));
  }));

  // ── PATCH /memories/:id — 같은 노드 id 유지 수동 편집 ───────────────────
  app.patch("/memories/:id", async (c) => withMemoryMutationLock(store, async () => {
    const id = parseIntParam(c.req.param("id"));
    if (id === null) return err(c, 400, "id must be a positive integer");

    let body: {
      content?: unknown;
      reason?: unknown;
      editor?: unknown;
      source?: unknown;
      editSource?: unknown;
      expectedRevision?: unknown;
      capture?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) return err(c, 400, "invalid JSON body");

    let capture;
    try { capture = parseCapture(body.capture); }
    catch { return err(c, 400, "capture must contain a valid kind and source"); }
    if (body.content === undefined && capture === undefined) return err(c, 400, "content or capture is required");
    if (body.content !== undefined && !isPositiveString(body.content)) {
      return err(c, 400, "content must be a non-empty string");
    }
    if (typeof body.content === "string" && hasHashtagSyntax(body.content)) {
      return err(c, 400, "수정 본문에는 해시태그를 쓸 수 없습니다; 태그는 본문 수정과 분리해 관리해야 합니다 (hashtags not accepted)");
    }

    const expectedRevision = body.expectedRevision;
    if (expectedRevision !== undefined && (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      return err(c, 400, "expectedRevision must be a non-negative integer");
    }
    if (capture !== undefined && expectedRevision === undefined) return err(c, 400, "expectedRevision is required for capture edits");

    // T15 — 관문을 노드 조회보다 먼저 태운다(거부될 편집이 조회 비용을 치르지 않게).
    // SA-1 — reason 도 revision 이력에 저장되는 사용자 입력이라 같은 관문을 탄다.
    let guardedContent: string;
    let guardedReason: string | null;
    try {
      guardedContent = body.content === undefined ? "" : applyWriteGuard(body.content as string, deps.getSettings?.().writeGuard);
      const claimedReason = optionalTrimmedString(body.reason);
      guardedReason = claimedReason === null
        ? null
        : applyWriteGuard(claimedReason, deps.getSettings?.().writeGuard);
    } catch (e) {
      const rejected = secretRejectionResponse(c, e);
      if (rejected) return rejected;
      throw e;
    }

    const existing = await store.getNode(id);
    if (!existing) return err(c, 404, `memory ${id} not found`);
    const currentRevision = readSharedMemory(existing.metadata).revision;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      return c.json({ code: "CONFLICT", error: "memory changed since it was read", nodeId: id, currentRevision }, 409);
    }
    if (capture?.source === "ai" &&
        (existing.metadata.capture as { source?: unknown } | undefined)?.source === "user") {
      return c.json({ code: "CAPTURE_CONFLICT", error: "AI classification cannot replace a user classification", nodeId: id, currentRevision }, 409);
    }
    // PS-0 — document·image_asset 은 본문을 직접 못 고치지만, capture(분류) 만 바꾸는
    // 요청은 본문에 손대지 않으므로 이 제약 대상이 아니다. body.content 가 있을 때만
    // (본문 수정을 실제로 요청했을 때만) 이 검사를 태운다.
    if (body.content !== undefined && UNEDITABLE_SOURCE_TYPES.has(existing.sourceType)) {
      return c.json(
        {
          error:
            `memory ${id} source_type=${existing.sourceType} is not directly editable; ` +
            "upload searchable text or edit its derived text node instead",
        },
        409,
      );
    }

    const nextVisibleContent = body.content === undefined ? normalizeEditableBody(stripTagsForDisplay(existing.content)) : normalizeEditableBody(guardedContent);
    const existingVisibleContent = normalizeEditableBody(stripTagsForDisplay(existing.content));
    const contentChanged = existingVisibleContent !== nextVisibleContent;
    const captureChanged = capture !== undefined && JSON.stringify(existing.metadata.capture ?? null) !== JSON.stringify(capture);
    if (!contentChanged && !captureChanged) {
      return c.json({
        changed: false,
        memory: existing,
        revision: null,
        warnings: [],
      });
    }

    const nextStoredContent = contentChanged
      ? contentWithPreservedTags(nextVisibleContent, extractHashtagTokens(existing.content))
      : existing.content;

    const reason = guardedReason;
    // SA-1 — editor·editSource 도 저장 작성자와 같은 신뢰 경계를 탄다.
    const actor = resolveEditActor(c, body, "api");
    if (actor instanceof Response) return actor;
    const { editor, editSource } = actor;

    let result;
    try {
      result = await store.editNodeContent({
        nodeId: id,
        content: nextStoredContent,
        expectedRevision,
        reason,
        editor,
        editSource,
        capture,
      });
    } catch (e) {
      if (e instanceof SharedMemoryMutationError) return c.json({ code: e.code, error: e.message, nodeId: e.nodeId, currentRevision: e.currentRevision }, e.code === "CONFLICT" ? 409 : 400);
      const msg = e instanceof Error ? e.message : String(e);
      return err(c, 500, `메모리 수정 실패: ${msg}`);
    }
    if (!result) return err(c, 404, `memory ${id} not found`);

    const warnings = contentChanged ? await rewireEditedNodeContent(store, deps, id, nextStoredContent) : [];
    if (contentChanged) warnings.push(...(await recheckEditedNodeConflicts(store, deps, id)));

    deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, {
      reason: "memory-edited",
      nodeId: id,
    });

    const memory = (await store.getNode(id)) ?? result.node;
    return c.json({
      changed: true,
      memory,
      revision: result.revision,
      warnings,
    });
  }));

  // ── POST /memories/:id/tags — 본문 수정과 분리된 키워드 태그 추가 ───────
  app.post("/memories/:id/tags", async (c) => withMemoryMutationLock(store, async () => {
    const id = parseIntParam(c.req.param("id"));
    if (id === null) return err(c, 400, "id must be a positive integer");

    let body: {
      tag?: unknown;
      editor?: unknown;
      source?: unknown;
      editSource?: unknown;
      expectedRevision?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    const tag = normalizePlainTagInput(body.tag);
    if (!tag) {
      return err(c, 400, "tag must be a plain hashtag name: letters, numbers, underscore, max 64 chars");
    }
    // QA Medium(WP-B1-05R) — 태그 값도 저장 경로와 같은 비밀값 관문을 탄다.
    // normalizePlainTagInput 의 형식 검증([\p{L}\d_]{1,64})은 GitHub 토큰 모양
    // (`ghp_` + 영숫자 20자 이상)과 겹쳐, 토큰이 그대로 노드 본문과 revision
    // 사유("tag added: #...")에 남을 수 있었다. 노드 조회보다 먼저 태운다(거부될
    // 편집이 조회 비용을 먼저 치르지 않게 — 본문 편집 라우트와 같은 순서).
    try {
      applyWriteGuard(tag, deps.getSettings?.().writeGuard);
    } catch (e) {
      const rejected = secretRejectionResponse(c, e);
      if (rejected) return rejected;
      throw e;
    }

    const expectedRevision = body.expectedRevision;
    if (expectedRevision !== undefined && (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      return err(c, 400, "expectedRevision must be a non-negative integer");
    }

    const existing = await store.getNode(id);
    if (!existing) return err(c, 404, `memory ${id} not found`);
    const currentRevision = readSharedMemory(existing.metadata).revision;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      return c.json({ code: "CONFLICT", error: "memory changed since it was read", nodeId: id, currentRevision }, 409);
    }
    if (UNEDITABLE_SOURCE_TYPES.has(existing.sourceType)) {
      return c.json(
        {
          error:
            `memory ${id} source_type=${existing.sourceType} cannot accept inline hashtag tags yet; ` +
            "tag a derived text node instead",
        },
        409,
      );
    }

    const existingTags = new Set(parseTags(existing.content).tags);
    if (existingTags.has(tag)) {
      return c.json({
        changed: false,
        tag,
        memory: existing,
        revision: null,
        warnings: [],
      });
    }

    const nextStoredContent = contentWithPreservedTags(
      stripTagsForDisplay(existing.content),
      [...extractHashtagTokens(existing.content), `#${tag}`],
    );

    // SA-1 — editor·editSource 도 저장 작성자와 같은 신뢰 경계를 탄다.
    const actor = resolveEditActor(c, body, "api");
    if (actor instanceof Response) return actor;
    const { editor, editSource } = actor;

    let result;
    try {
      result = await store.editNodeContent({
        nodeId: id,
        content: nextStoredContent,
        expectedRevision,
        reason: `tag added: #${tag}`,
        editor,
        editSource,
      });
    } catch (e) {
      if (e instanceof SharedMemoryMutationError) return c.json({ code: e.code, error: e.message, nodeId: e.nodeId, currentRevision: e.currentRevision }, e.code === "CONFLICT" ? 409 : 400);
      const msg = e instanceof Error ? e.message : String(e);
      return err(c, 500, `태그 추가 실패: ${msg}`);
    }
    if (!result) return err(c, 404, `memory ${id} not found`);

    const warnings = await rewireEditedNodeContent(store, deps, id, nextStoredContent);

    deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, {
      reason: "memory-tag-added",
      nodeId: id,
      tag,
    });

    const memory = (await store.getNode(id)) ?? result.node;
    return c.json({
      changed: true,
      tag,
      memory,
      revision: result.revision,
      warnings,
    });
  }));
}
