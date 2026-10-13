/**
 * routes/memories-edit-split.ts — PATCH /memories/by-source 의 대상 노드별 적용(WP-B1-20T 설계 5.6).
 *
 * 외부 메시지 하나가 고쳐졌을 때, 그 메시지의 출처 행(memory_node_sources)을 가진 auto_capture 노드 E 마다:
 *   1) 본문이 같으면(정규화 뒤) 건너뛴다.
 *   2) E 에 이 메시지 말고 다른 출처 행이 없으면 지금처럼 같은 id 로 고친다(editNodeContent — 주장이
 *      바뀌면 계보 무효화 5.8, 재추출·재청크 B1-06, 충돌 재검사).
 *   3) 다른 출처 행(다른 메시지·대시보드·AI 저장)이 있으면 분리한다 — 그 출처의 내용을 이 메시지 수정으로
 *      덮지 않는다(C1). 새 본문으로 새 원문 N 을 만들고(saveOriginThenChunks: 유사-중복 관문을 거치지 않는다 —
 *      외부 수정의 동기화이지 새 사용자 저장이 아니다, 설계 D9), E 의 이 메시지 행을 N 으로 옮기고, E 의
 *      메시지 표시를 거두며, 수정 이력 E -> N 을 남긴다. E 의 본문·파생은 그대로다. N 의 본문이 이미 있는
 *      노드와 같으면 그 노드가 이 메시지 행을 받는다(reused). N 은 추출 기록 없이 저장돼 백필이 쓰기 잠금 밖에서
 *      추출한다 — 잠금 안에서 LLM 을 부르지 않는다(B1-08).
 *
 * 호출자(memories-edit.ts)가 쓰기 잠금·쓰기 관문·행위자 규칙(SA-1)·expectedRevision 사전 확인(SL-6, 쓰기 전에
 * 대상 전부)을 마친 뒤 부른다.
 */

import type { Context } from "hono";
import type { EditBySourceSplit } from "../../api-client-types.ts";
import type { MemoryNode } from "../../memory/types.ts";
import type { NodeSourceRef } from "../../memory/node-sources/source-ref.ts";
import type { MessageSourceRows } from "../../db/store-internal/args-types.ts";
import { messageSourceRefOfRow } from "../../db/store-internal/node-source-repository.ts";
import { contentHash } from "../../memory/content-hash.ts";
import { SOURCE_MESSAGE_ID_KEY } from "../../memory/source-message.ts";
import { SharedMemoryMutationError } from "../../memory/shared-memory-mutation-error.ts";
import { parseHashtagEntities } from "../../memory/parsers/hashtag-entity-parser.ts";
import { EVENT_TYPES } from "../event-bus.ts";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";
import { deriveTitle, exceedsChunkTokenCap, saveOriginThenChunks } from "../save-input-plain.ts";
import type { SaveTextChunkingSettings, SaveTextInputArgs } from "../save-input-types.ts";
import {
  UNEDITABLE_SOURCE_TYPES,
  normalizeEditableBody,
  recheckEditedNodeConflicts,
  rewireEditedNodeContent,
} from "./memories-shared.ts";

/** memory_revisions.reason 의 분리 표시 머리말(설계 5.6 (c)). 뒤에 편집 사유가 붙는다. */
export const MESSAGE_EDIT_SPLIT_REASON_PREFIX = "message edit split";

/**
 * 분리로 만든 새 원문이 옛 노드 metadata 에서 이어받는 칸 — 어느 통로·플랫폼·작성자 id 로 들어온 글인가.
 * 제목·태그·보호 기한은 새 본문에서 다시 만들고, 서버 관리 칸(sharedMemory·extracted·extractedTo)은
 * 새 노드의 상태가 아니라 이어받지 않는다. 메시지 표시(messageId·channelId·guildId)는 이 메시지의 출처 행에서 채운다.
 */
const SPLIT_CARRIED_METADATA_KEYS = ["source", "platform", "user_id"] as const;
const CHANNEL_ID_MARKER_KEY = "channelId";
const GUILD_ID_MARKER_KEY = "guildId";

export interface BySourceEditInput {
  messageId: string;
  platform: string | null;
  /** 그 메시지의 출처 행을 가진 auto_capture 노드(id 오름차순). */
  editable: MemoryNode[];
  /** 노드마다 그 메시지 행과 나머지 출처 행(store.readMessageSources). */
  sources: ReadonlyMap<number, MessageSourceRows>;
  nextStoredContent: string;
  expectedRevision: number | undefined;
  reason: string;
  editor: string | null;
  editSource: string;
}

export interface BySourceEditOutcome {
  editedIds: number[];
  revisions: unknown[];
  warnings: string[];
  /** 편집하지 못하고 건너뛴 노드(호출자가 이미 모은 목록 뒤에 붙인다). */
  skippedIds: number[];
  splits: EditBySourceSplit[];
}

function chunkingOf(deps: MemoryApiDeps): SaveTextChunkingSettings | undefined {
  const chunking = deps.getSettings?.().chunking;
  return chunking ? { tokenCap: chunking.tokenCap, minChunkTokens: chunking.minChunkTokens } : undefined;
}

/** 새 원문 metadata — 옛 노드의 통로·작성자 id 칸과 이 메시지 출처의 표시. */
function splitOriginMetadata(existing: MemoryNode, message: NodeSourceRef): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of SPLIT_CARRIED_METADATA_KEYS) {
    const value = existing.metadata[key];
    if (typeof value === "string") metadata[key] = value;
  }
  metadata[SOURCE_MESSAGE_ID_KEY] = message.externalId;
  if (message.detail.channelId !== undefined) metadata[CHANNEL_ID_MARKER_KEY] = message.detail.channelId;
  if (message.detail.guildId !== undefined) metadata[GUILD_ID_MARKER_KEY] = message.detail.guildId;
  return metadata;
}

/**
 * 분리 한 건(설계 5.6 2단계 셋째 갈래). 새 본문이 옛 본문과 정확-중복 키(NFC·앞뒤 공백)로 같으면 옮길 내용이
 * 없어 null 을 돌려준다 — 그대로 저장하면 같은 본문 흡수가 옛 노드 자신을 고른다.
 */
async function splitFromSharedNode(
  store: MemoryApiDeps["store"],
  deps: MemoryApiDeps,
  existing: MemoryNode,
  messageRows: MessageSourceRows["messageRows"],
  input: BySourceEditInput,
): Promise<EditBySourceSplit | null> {
  if (contentHash(input.nextStoredContent) === contentHash(existing.content)) return null;
  const [primary] = messageRows;
  if (primary === undefined) {
    throw new Error(`기억 ${existing.id} 에 메시지 ${input.messageId} 의 출처 행이 없어 분리할 수 없습니다`);
  }
  const messageSource = messageSourceRefOfRow(primary);
  const settings = deps.getSettings?.();
  const chunking = chunkingOf(deps);
  const userId = existing.metadata.user_id;
  const args: SaveTextInputArgs = {
    content: input.nextStoredContent,
    source: existing.platform,
    author: existing.author,
    userId: typeof userId === "string" ? userId : undefined,
    memoryType: existing.memoryType,
    projectId: existing.projectId,
    extraMetadata: splitOriginMetadata(existing, messageSource),
    chunking,
    regexL0: deps.regexL0,
    regexEnabled: settings?.extractor?.regex?.enabled === true,
    trigger: deps.autoCleanupTrigger,
  };
  const saved = await saveOriginThenChunks(
    store,
    args,
    deriveTitle(input.nextStoredContent),
    exceedsChunkTokenCap(input.nextStoredContent, chunking),
    messageSource,
  );
  const newNodeId = saved.originNodeId;
  if (newNodeId === null) {
    throw new Error(`기억 ${existing.id} 분리: 새 본문 원문 노드 id 가 없습니다`);
  }
  store.completeMessageSplit({
    fromNodeId: existing.id,
    toNodeId: newNodeId,
    messageId: input.messageId,
    platform: input.platform ?? undefined,
    reason: `${MESSAGE_EDIT_SPLIT_REASON_PREFIX}: ${input.reason}`,
    editor: input.editor,
    editSource: input.editSource,
  });
  deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, {
    reason: "memory-split-by-source",
    nodeId: newNodeId,
    fromNodeId: existing.id,
  });
  return { fromNodeId: existing.id, newNodeId, reused: saved.cacheHit };
}

/**
 * 대상 노드마다 같은 id 편집 또는 분리를 적용한다. 편집 저장소 오류는 지금처럼 409/400/500 응답으로 돌려준다.
 */
export async function applyBySourceEdit(
  c: Context,
  deps: MemoryApiDeps,
  input: BySourceEditInput,
): Promise<BySourceEditOutcome | Response> {
  const { store } = deps;
  const directFields = new Set(
    parseHashtagEntities(input.nextStoredContent).directFields.map((f) => f.column),
  );
  const outcome: BySourceEditOutcome = { editedIds: [], revisions: [], warnings: [], skippedIds: [], splits: [] };

  for (const existing of input.editable) {
    if (UNEDITABLE_SOURCE_TYPES.has(existing.sourceType)) {
      outcome.skippedIds.push(existing.id);
      continue;
    }
    if (normalizeEditableBody(existing.content) === input.nextStoredContent) {
      continue;
    }

    const sources = input.sources.get(existing.id);
    if (sources === undefined) {
      return err(c, 500, `메모리 source 수정 실패: 기억 ${existing.id} 의 출처 행을 읽지 못했습니다`);
    }
    if (sources.otherRows.length > 0) {
      let split;
      try {
        split = await splitFromSharedNode(store, deps, existing, sources.messageRows, input);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(c, 500, `메모리 source 분리 실패: ${msg}`);
      }
      if (split !== null) outcome.splits.push(split);
      continue;
    }

    // WP-B1-20U 설계 17.6 — 같은 id 수정 이력 행에 메시지 id 와 이 기억의 메시지 출처 행 플랫폼을 적어, 메시지가
    // 지워지면 그 행의 본문이 지워지게 한다. 플랫폼은 요청이 아니라 행에서 읽는다(플랫폼 없이 부른 수정도 플랫폼 준
    // 삭제가 찾는다). 행이 여럿이면(플랫폼 없는 수정이 여러 플랫폼의 같은 messageId 행을 잡은 경우) 분리와 같은 첫 행.
    const [messageRow] = sources.messageRows;
    if (messageRow === undefined) {
      return err(c, 500, `메모리 source 수정 실패: 기억 ${existing.id} 에 메시지 ${input.messageId} 의 출처 행이 없습니다`);
    }

    if (!directFields.has("event_at")) {
      await store.clearEventAt(existing.id, "direct");
    }
    if (!directFields.has("event_until")) {
      await store.clearEventUntil(existing.id, "direct");
    }

    let result;
    try {
      result = await store.editNodeContent({
        nodeId: existing.id,
        content: input.nextStoredContent,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        editor: input.editor,
        editSource: input.editSource,
        sourceMessage: { messageId: input.messageId, platform: messageRow.platform },
      });
    } catch (e) {
      if (e instanceof SharedMemoryMutationError) return c.json({ code: e.code, error: e.message, nodeId: e.nodeId, currentRevision: e.currentRevision }, e.code === "CONFLICT" ? 409 : 400);
      const msg = e instanceof Error ? e.message : String(e);
      return err(c, 500, `메모리 source 수정 실패: ${msg}`);
    }
    if (!result) {
      outcome.skippedIds.push(existing.id);
      continue;
    }

    outcome.editedIds.push(existing.id);
    outcome.revisions.push(result.revision);
    outcome.warnings.push(
      ...(await rewireEditedNodeContent(store, deps, existing.id, input.nextStoredContent)),
    );
    // 본문이 바뀐 노드만 여기 도달한다(위 무변경 continue) — 충돌 재검사.
    outcome.warnings.push(...(await recheckEditedNodeConflicts(store, deps, existing.id)));

    deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, {
      reason: "memory-edited-by-source",
      nodeId: existing.id,
    });
  }
  return outcome;
}
