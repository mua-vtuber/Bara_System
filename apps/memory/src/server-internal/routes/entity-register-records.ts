/**
 * routes/entity-register-records.ts — 홈 "최근 자동 등록" 목록과 되돌리기(spec 7.3).
 *
 *   GET  /api/entity-register/records?limit&offset → { records: RecentAutoRegisterItem[]; total }
 *        limit 을 빼면 ENTITY_REGISTER_LIMITS.recentListDefaultLimit, 넘치면 recentListMaxLimit 로 자른다.
 *        음수·0·정수가 아닌 값은 400.
 *   POST /api/entity-register/records/:id/revert   → 200 { reverted, result } | 400 | 404 | 409
 *
 * 등록은 registerCleanupRunsRoutes 가 맨 앞에서 한다(server.ts 줄 수 유지). 정리 스케줄러가 꺼져 있어도
 * 지난 자동 등록을 보고 되돌릴 수 있어야 해서, 스케줄러 유무로 갈리는 분기보다 먼저 등록한다.
 * 되돌리기 자체는 memory 층 revertEntityRegisterRecord 가 한다(쓰기 잠금·트랜잭션 포함).
 */
import type { Hono } from "hono";
import { ENTITY_REGISTER_LIMITS } from "../../memory/cleanup-deep-pass/entity-register/constants.ts";
import { EntityRegisterRecordsRepository } from "../../memory/cleanup-deep-pass/entity-register/records-repository.ts";
import { EntityRegisterRevertError, revertEntityRegisterRecord } from "../../memory/cleanup-deep-pass/entity-register/revert.ts";
import type { RecordItemKind } from "../../memory/cleanup-deep-pass/entity-register/types.ts";
import { EVENT_TYPES } from "../../memory/events/event-contract.ts";
import { err } from "../http-helpers.ts";
import type { MemoryApiDeps } from "../types.ts";

export interface RecentAutoRegisterItem {
  id: number;
  itemKind: RecordItemKind;
  targetType: string;
  targetId: string;
  name: string;
  sourceNodeId: number;
  /** 원본 메모 본문. null = 원본 메모 없음(휴지통으로 갔거나 영구 삭제됨) — 목록에서 숨기지 않고 이 상태로 보인다. */
  memoContent: string | null;
  date: string | null;
  runId: string | null;
  createdAt: string;
}

const INTEGER_PATTERN = /^-?[0-9]+$/;

/** 쿼리 정수 — 없으면 fallback, 정수 글자가 아니거나 min 보다 작으면 null(400). */
function intParam(raw: string | undefined, fallback: number, min: number): number | null {
  if (raw === undefined) return fallback;
  if (!INTEGER_PATTERN.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

export function registerEntityRegisterRecordsRoutes(app: Hono, deps: MemoryApiDeps): void {
  app.get("/api/entity-register/records", (c) => {
    const limit = intParam(c.req.query("limit"), ENTITY_REGISTER_LIMITS.recentListDefaultLimit, 1);
    const offset = intParam(c.req.query("offset"), 0, 0);
    if (limit === null || offset === null) return err(c, 400, "limit 은 1 이상, offset 은 0 이상 정수여야 함");
    const repo = new EntityRegisterRecordsRepository(deps.store.getRawDb());
    const page = repo.listActive({ decidedBy: "auto", limit: Math.min(limit, ENTITY_REGISTER_LIMITS.recentListMaxLimit), offset });
    const records: RecentAutoRegisterItem[] = page.records.map((r) => ({
      id: r.id, itemKind: r.itemKind, targetType: r.targetType, targetId: r.targetId, name: r.name,
      sourceNodeId: r.sourceNodeId, memoContent: r.memoContent, date: r.detail.date, runId: r.runId, createdAt: r.createdAt,
    }));
    return c.json({ records, total: page.total });
  });

  app.post("/api/entity-register/records/:id/revert", async (c) => {
    const raw = c.req.param("id");
    const id = intParam(raw, 0, 1);
    if (id === null) return err(c, 400, `id 는 1 이상 정수여야 함 (받은 값: ${raw})`);
    let result;
    try {
      result = await revertEntityRegisterRecord(deps.store, new EntityRegisterRecordsRepository(deps.store.getRawDb()), id);
    } catch (e) {
      if (e instanceof EntityRegisterRevertError) return err(c, e.status, e.message);
      throw e;
    }
    deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "entity-register-reverted", recordId: id });
    return c.json({ reverted: id, result });
  });
}
