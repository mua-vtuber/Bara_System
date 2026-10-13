/**
 * routes/memories-edit-attachments.ts — PATCH /memories/by-source 의 본문 대상 규칙과 첨부 갈래(WP-B1-20U 설계 17.9,
 * Q6 기본값).
 *
 * 본문 칸 attachmentIds?: string[] 는 수정 뒤 그 메시지에 남은 첨부 id 전부다. 있으면 그 메시지의 첨부 출처 행 중 목록에
 * 없는 첨부의 행을 메시지 삭제와 같은 제거 루틴으로 지운다(store.removeMessageAttachments — 행 삭제 → message 계획 →
 * 영구 삭제·표시 거둠 → 그 키들의 보관표 정리 → 이력 정리. 첨부 파일은 저장소 메서드가 커밋 뒤 같은 쓰기 잠금 안에서
 * 지우고 그 결과 assetCleanup 을 돌려준다 — 이 모듈은 응답에 담기만 한다). content 와 attachmentIds 중 하나는 있어야
 * 하고(둘 다 없으면 400), attachmentIds 만 있으면 글 수정은 하지 않는다(글이 빈 메시지).
 *
 * 순서: 라우트(memories-edit.ts)가 쓰기 잠금 안에서 글 수정을 먼저 하고 — expectedRevision 이 어긋난 409 는 아무것도
 * 쓰기 전에 돌려준다 — 응답을 만들 때 withAttachmentRemoval 이 첨부를 제거해 결과를 담는다. 글 수정이 오류 응답(409·
 * 400·500)이면 첨부 제거도 하지 않는다. attachmentIds 를 보내지 않은 수정(옛 클라이언트, 첨부 목록을 모르는 봇)은
 * 첨부를 건드리지 않고 attachmentRemoval 에 빈 배열들을 담는다.
 */

import type { Context } from "hono";
import type { EditBySourceAttachmentRemoval } from "../../api-client-types.ts";
import { noAssetCleanup } from "../../db/store-internal/asset-release.ts";
import type { MemoryApiDeps } from "../types.ts";
import { err, isPositiveString } from "../http-helpers.ts";
import { sourceKeyPartProblem } from "../../memory/node-sources/source-ref.ts";

/** PATCH by-source 본문에서 고칠 대상 — 메시지 id(trim), 고친 글(없으면 null), 남은 첨부 id(trim, 없으면 null). */
export interface BySourceEditTargets {
  messageId: string;
  content: string | null;
  attachmentIds: string[] | null;
}

/**
 * 본문의 messageId·content·attachmentIds 규칙. 어기면 400 응답을 돌려준다. 첨부 id 는 POST /ingest 의
 * sourceMessage.attachmentId 와 같이 trim 한다 — 출처 행 키가 그 값으로 만들어졌다.
 */
export function readBySourceEditTargets(
  c: Context,
  body: { messageId?: unknown; content?: unknown; attachmentIds?: unknown },
): BySourceEditTargets | Response {
  if (!isPositiveString(body.messageId)) return err(c, 400, "messageId must be a non-empty string");
  if (body.content === undefined && body.attachmentIds === undefined) {
    return err(c, 400, "content or attachmentIds is required");
  }
  if (body.content !== undefined && !isPositiveString(body.content)) {
    return err(c, 400, "content must be a non-empty string");
  }
  let attachmentIds: string[] | null = null;
  if (body.attachmentIds !== undefined) {
    if (!Array.isArray(body.attachmentIds) || !body.attachmentIds.every(isPositiveString)) {
      return err(c, 400, "attachmentIds must be an array of non-empty strings");
    }
    attachmentIds = body.attachmentIds.map((id) => id.trim());
  }
  // 출처 키 구분자(설계 17.18 설계 7) — messageId·첨부 id 의 `:` 는 다른 (메시지, 첨부) 쌍의 키와 섞이므로 400.
  const messageId = body.messageId.trim();
  let keyProblem = sourceKeyPartProblem("messageId", messageId);
  for (const attachmentId of attachmentIds ?? []) keyProblem ??= sourceKeyPartProblem("attachmentId", attachmentId);
  if (keyProblem !== null) return err(c, 400, keyProblem);
  return { messageId, content: body.content ?? null, attachmentIds };
}

/** attachmentIds 를 보내지 않은 수정의 결과 — 첨부를 건드리지 않았다. */
function noAttachmentRemoval(): EditBySourceAttachmentRemoval {
  return {
    removedAttachmentKeys: [], deletedIds: [], derivedDeletedIds: [], keptIds: [], archivePurgedIds: [],
    assetCleanup: noAssetCleanup(),
  };
}

/**
 * 글 수정 응답(payload)에 첨부 제거 결과를 담는다. targets.attachmentIds 가 있으면 여기서 제거한다 — 라우트가 쓰기
 * 잠금 안에서 글 수정을 마친 뒤 응답을 만들 때 부른다. 첨부 행을 지웠으면 changed 를 참으로 한다. 저장소 오류는
 * 그대로 던진다(DELETE by-source 라우트와 같다 — Hono 기본 오류 처리가 500 으로 알린다).
 */
export async function withAttachmentRemoval<T extends { changed: boolean }>(
  store: MemoryApiDeps["store"],
  targets: BySourceEditTargets,
  platform: string | null,
  payload: T,
): Promise<T & { attachmentRemoval: EditBySourceAttachmentRemoval }> {
  if (targets.attachmentIds === null) return { ...payload, attachmentRemoval: noAttachmentRemoval() };
  const attachmentRemoval = await store.removeMessageAttachments({
    messageId: targets.messageId,
    platform: platform ?? undefined,
    keepAttachmentIds: targets.attachmentIds,
  });
  return {
    ...payload,
    changed: payload.changed || attachmentRemoval.removedAttachmentKeys.length > 0,
    attachmentRemoval,
  };
}
