/**
 * server-internal/routes/archive.ts — 휴지통·evolver·trash 라우트 등록기
 *
 * GET /archive, POST /archive/:id/restore,
 * GET /evolver/activity, GET /admin/trash/soon-to-purge
 * 네 라우트를 한 함수로 묶는다.
 *
 * 절대 제약:
 *   trashManagement 는 createMemoryApi 가 나중에 채울 수 있는 속성이므로
 *   구조분해로 미리 꺼내지 않는다. 핸들러 안에서 호출 시점에
 *   deps.trashManagement 로 lookup — undefined 면 schema default(30) 사용.
 */

import type { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { parseLimit, err } from "../http-helpers.ts";
import { InvalidArchiveCursor } from "../../db/store-internal/archive-page.ts";
import { ArchivedNodeChangedError } from "../../db/store-internal/stats-repository.ts";
import { resolveRestWriter } from "./memories-shared.ts";

/**
 * 휴지통·evolver·trash 네 라우트를 app 에 등록한다.
 *
 * deps 객체 자체를 받는다 (trashManagement 구조분해 금지).
 * buildMemoryApi 직호출 테스트에서 deps.trashManagement 가 undefined 이면
 * retentionDays ?? 30 fallback 으로 동작한다.
 */
export function registerArchiveRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps;

  // ── GET /archive — 휴지통 노드 목록 ─────────────────────────────────
  app.get("/archive", async (c) => {
    const sinceParam = c.req.query("since");
    const limitParam = c.req.query("limit");
    const limit = parseLimit(limitParam, 50, 200);
    try {
      const page = await store.getArchivePage({
        since: sinceParam || undefined,
        limit,
        cursor: c.req.query("cursor"),
      });
      return c.json(page);
    } catch (error) {
      if (error instanceof InvalidArchiveCursor) return err(c, 400, error.message);
      throw error;
    }
  });

  // ── POST /archive/:id/restore — 복구 ─────────────────────────────────
  // WP-B1-20T 설계 5.4 — 보관된 출처 행을 되돌리고, 되돌릴 행이 없으면 되살린 행위자의
  // restore:<actor> 출처 행을 더한다. 행위자는 호출자 신고가 아니라 인증 토큰의 adapterId 다
  // (resolveRestWriter pinToToken — 제한 토큰도 같은 값). 인증 관문 없이 조립한 앱(테스트)은
  // 신원이 없어 빈 문자열이다.
  // WP-B1-20U 설계 17.4 — 복원은 임베딩을 잠금 밖에서 하고 잠금 안에서 보관 행을 다시 읽는다. 그 사이 메시지
  // 삭제 등으로 사라졌으면(같은 id 복원 두 건이 겹친 두 번째 포함) 404, 같은 번호의 다른 행으로 바뀌었으면 409.
  app.post("/archive/:id/restore", async (c) => {
    const raw = c.req.param("id");
    const id = parseInt(raw, 10);
    if (!Number.isFinite(id) || id < 1) {
      return err(c, 400, "invalid id");
    }
    const actor = resolveRestWriter(c, undefined, { pinToToken: true });
    if (actor instanceof Response) return actor;
    let restored;
    try {
      restored = await store.restoreArchived(id, actor.writer);
    } catch (error) {
      if (error instanceof ArchivedNodeChangedError) return err(c, 409, error.message);
      throw error;
    }
    if (!restored) {
      return err(c, 404, "archived node not found");
    }
    return c.json({ restored }, 200);
  });

  // ── GET /evolver/activity — 최근 활동 로그 ───────────────────────────
  app.get("/evolver/activity", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = parseLimit(limitParam, 7, 100);
    const activity = await store.getEvolverActivity(limit);
    return c.json({ activity });
  });

  // ── GET /admin/trash/soon-to-purge — 영구 삭제 임박 노드 목록 ─────────
  // Phase 5.7.3 W4. 어댑터(방울이/봇/외부 SDK) polling 통로. 메모리 코어
  // 능동 송출 X 정신 ([[module-core-vs-accessory-boundary]]) 정합 — 어댑터가
  // 정해진 주기로 이 라우트를 조회해 알림 한 줄 송출.
  //
  // Query: ?days=N (default 7). 0 ≤ days ≤ retentionDays 범위 입력만 수용.
  // 반환: { days, retentionDays, items: ArchivedNode[] }
  app.get("/admin/trash/soon-to-purge", async (c) => {
    const daysRaw = c.req.query("days");
    const days = daysRaw === undefined ? 7 : Number(daysRaw);
    if (!Number.isFinite(days) || days < 0) {
      return err(c, 400, "invalid days param — must be a non-negative number");
    }
    // schema default (Phase 5.7.3 W1 trashManagement 그룹) 정합 — deps
    // 미주입 시 retentionDays=30. createMemoryApi 가 settings 객체로부터 채움.
    const retentionDays = deps.trashManagement?.retentionDays ?? 30;
    if (days > retentionDays) {
      return err(
        c,
        400,
        `invalid days param — must be ≤ retentionDays (${retentionDays})`,
      );
    }
    const items = await store.getArchiveSoonToPurge(days, retentionDays);
    return c.json({ days, retentionDays, items });
  });
}
