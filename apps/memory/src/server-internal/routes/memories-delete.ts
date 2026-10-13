/**
 * routes/memories-delete.ts — DELETE /memories/by-source + DELETE /memories/:id
 * + POST /memories/:id/trash.
 *
 * routes/memories.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md).
 *
 * 절대 제약 — 등록 순서: DELETE /memories/by-source 가 DELETE /memories/:id 보다
 * 먼저 와야 한다. Hono 는 등록 순서대로 매칭하므로 `:id` 가 먼저면 "by-source" 를
 * id 로 받아 400 으로 떨어진다. 두 라우트를 이 한 함수 안에 순서 고정으로 둔다.
 * POST /memories/:id/trash 는 메서드가 달라 이 제약과 무관.
 */

import type { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { parseIntParam, err } from "../http-helpers.ts";
import { sourceKeyPartProblem } from "../../memory/node-sources/source-ref.ts";

export function registerMemoriesDeleteRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps; // 부팅 시점 고정 의존만 구조분해

  // ── DELETE /memories/by-source — 외부 메시지 삭제와 동기화 ───────────────
  // Discord MessageDelete 등 외부 surface가 원본 메시지를 지웠을 때 호출.
  // 서버 출처 표(memory_node_sources)에서 그 메시지의 출처 행을 지우고, 출처 행도 살아 남는
  // 계보 부모도 없게 된 노드를 계보 자손(청크·청크의 추출 자식·regex 원자)과 함께 영구
  // 삭제한다. 같은 본문을 다른 메시지·대시보드·AI 도 저장했으면 그 출처 행이 노드를 붙잡는다.
  // 휴지통에 있던 그 메시지의 노드도 정리한다(store.deleteBySource, WP-B1-20T 설계 5.3·5.5).
  //
  // 응답(필드 추가만 — 기존 칸의 뜻 유지):
  //   deletedIds·deletedCount = 이 메시지의 출처 행을 가졌고 영구 삭제된 노드,
  //   derivedDeletedIds = 계보로 함께 영구 삭제된 노드,
  //   keptIds = 이 메시지의 출처 행을 잃었지만 다른 출처로 남은 노드,
  //   archivePurgedIds = 휴지통에서 영구 삭제한 노드,
  //   revisionBodiesCleared = 이 메시지의 동기 수정(PATCH by-source)이 남긴 수정 이력 행 중, 다른 출처로 남은
  //     노드·휴지통에 남은 노드의 행에서 본문을 지운 행 수(WP-B1-20U 설계 17.6 — 누가·언제·왜는 남는다),
  //   retractedDerivedDeletedIds = 다른 출처로 남은 노드 아래에서, 이 메시지의 동기 수정이 계보 무효화로 철회해 둔
  //     옛 파생(자기 출처 행 없음)과 그 노드에만 기대던 자손을 영구 삭제한 id(WP-B1-20U 설계 17.7),
  //   assetCleanup = 지운 노드가 주인이던 문서 기록 id, 지운 첨부 파일·이미 없던 파일의 sha, 지우지 못한 파일의
  //     경로·원인(WP-B1-20U 설계 17.17 — 파일 단계는 store.deleteBySource 가 커밋 뒤 같은 잠금 안에서 한다).
  //
  // Query 파라미터:
  //   messageId  (required) — Discord/Telegram/Slack 메시지의 외부 id.
  //   platform   (optional) — "discord" 등. 주면 같은 플랫폼의 출처 행만 지운다 —
  //                            같은 messageId 라도 다른 플랫폼 메시지의 기억은 보존.
  //
  // 등록 순서 주의: `/memories/:id` 보다 먼저 와야 한다 — Hono 는 등록 순서대로
  // 시도하므로 뒤에 두면 `:id` 매처가 "by-source"를 id 로 받아 400 으로 떨어진다.
  app.delete("/memories/by-source", async (c) => {
    const messageId = c.req.query("messageId");
    const platform = c.req.query("platform");
    if (!messageId || messageId.trim().length === 0) {
      return err(c, 400, "messageId query parameter is required");
    }

    const sourcePlatform = platform && platform.trim().length > 0 ? platform.trim() : undefined;
    // 출처 키 구분자(설계 17.18 설계 7) — 키를 만드는 칸에 `:` 가 든 값은 400 으로 막는다(저장 경계와 같은 문구).
    const keyProblem = sourceKeyPartProblem("messageId", messageId.trim()) ?? sourceKeyPartProblem("platform", sourcePlatform);
    if (keyProblem !== null) return err(c, 400, keyProblem);

    const result = await store.deleteBySource({ messageId: messageId.trim(), platform: sourcePlatform });

    return c.json({
      messageId,
      platform: platform ?? null,
      deletedCount: result.deletedIds.length,
      deletedIds: result.deletedIds,
      derivedDeletedIds: result.derivedDeletedIds,
      keptIds: result.keptIds,
      archivePurgedIds: result.archivePurgedIds,
      revisionBodiesCleared: result.revisionBodiesCleared,
      retractedDerivedDeletedIds: result.retractedDerivedDeletedIds,
      assetCleanup: result.assetCleanup,
    });
  });

  // ── DELETE /memories/:id — 단건 영구 삭제(봇 /forget, 외부 REST) ──────────
  // WP-B1-20U 설계 17.3 — 메시지 삭제와 같은 생존 규칙: 고른 노드와, 자기 출처 행도 살아 남는 다른
  // 계보 부모도 없는 자손을 함께 영구 삭제하고, 그 노드들의 수정 이력과 그 노드들에만 기대던 휴지통
  // 노드도 지운다. 존재 확인·삭제가 store.deleteNode 의 쓰기 잠금 안 한 트랜잭션이라 그 사이 경쟁이 없다.
  // 'node-deleted' 신호도 store.deleteNode 가 보낸다(한 reason 의 단일 통로).
  //
  // 응답(필드 추가만): deleted = 고른 노드, derivedDeletedIds = 계보로 함께 영구 삭제된 노드,
  // archivePurgedIds = 휴지통에서 영구 삭제한 노드, assetCleanup = 지운 노드가 주인이던 문서 기록 id, 지운 첨부
  // 파일·이미 없던 파일의 sha, 지우지 못한 파일의 경로·원인(WP-B1-20U 설계 17.17 — 파일 단계는 store.deleteNode 가
  // 커밋 뒤 같은 잠금 안에서 한다). 없으면 404.
  app.delete("/memories/:id", async (c) => {
    const id = parseIntParam(c.req.param("id"));
    if (id === null) return err(c, 400, "id must be a positive integer");

    const result = await store.deleteNode(id);
    if (!result) return err(c, 404, `memory ${id} not found`);
    return c.json({
      deleted: result.deletedId,
      derivedDeletedIds: result.derivedDeletedIds,
      archivePurgedIds: result.archivePurgedIds,
      assetCleanup: result.assetCleanup,
    });
  });

  // ── POST /memories/:id/trash — 휴지통 이동(원문 + 파생 노드) ─────────────
  // UI 개별 삭제 통로 (spec 2026-08-06-memory-individual-delete). 영구 삭제가
  // 아니라 휴지통 이동 — /archive 에서 복원 가능, retentionDays 뒤 자동 영구 삭제.
  // cascade 는 출처 삭제와 같은 제거 계획(planSourceRemoval, explicit 방아쇠 cascade 정책, 설계 5.4·17.3)이다:
  // 고른 노드는 항상 옮기고, 계보 엣지로 이어진 자손(추출 자식, 재추출 뒤 extractedTo 에서 빠진
  // 옛 자식, 청크와 그 자식, regex 원자)은 자기 출처 행(같은 본문의 대시보드·AI·다른 메시지
  // 저장)이 있거나 살아 남는 다른 계보 부모가 있으면 남긴다 — 옮기는 노드로 가는 계보 엣지만
  // CASCADE 로 끊긴다. 계보 엣지가 없는 extractedTo 항목(계보 엣지 이전 모양)도 옮긴다.
  // 계획과 보관 이동은 store.trashNodes 의 쓰기 잠금 안 한 트랜잭션이다.
  app.post("/memories/:id/trash", async (c) => {
    const id = parseIntParam(c.req.param("id"));
    if (id === null) return err(c, 400, "id must be a positive integer");

    const result = await store.trashNodes([id], "cascade");
    if (result.rootIds.length === 0) return err(c, 404, `memory ${id} not found`);
    return c.json({ trashed: id, cascadeTrashedIds: result.cascadeMovedIds });
  });
}
