/**
 * routes/schedule-visibility.ts — POST /memories/:id/schedule-visibility  body { hidden: boolean }
 *
 * 홈 상세의 "일정 아님" 버튼. 글과 날짜는 그대로 두고 일정 목록에서만 빼거나 다시 넣는다
 * (본체 = memory/schedule-visibility.ts, 쓰기 잠금 포함). 200 { nodeId, hidden, action, ... } | 400 | 404 | 409.
 */
import type { Hono } from "hono";
import { ScheduleVisibilityError, setScheduleVisibility } from "../../memory/schedule-visibility.ts";
import { EntityRegisterRevertError } from "../../memory/cleanup-deep-pass/entity-register/revert.ts";
import { EVENT_TYPES } from "../event-bus.ts";
import { err, parseIntParam } from "../http-helpers.ts";
import type { MemoryApiDeps } from "../types.ts";

export function registerScheduleVisibilityRoutes(app: Hono, deps: MemoryApiDeps): void {
  app.post("/memories/:id/schedule-visibility", async (c) => {
    const raw = c.req.param("id");
    const id = parseIntParam(raw);
    if (id === null) return err(c, 400, `id 는 1 이상 정수여야 함 (받은 값: ${raw})`);
    let body: { hidden?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }
    if (typeof body !== "object" || body === null || typeof body.hidden !== "boolean") {
      return err(c, 400, "hidden 은 true 또는 false 여야 함");
    }
    let result;
    try {
      result = await setScheduleVisibility(deps.store, id, body.hidden);
    } catch (e) {
      if (e instanceof ScheduleVisibilityError) return err(c, e.status, e.message);
      if (e instanceof EntityRegisterRevertError) return err(c, e.status, e.message);
      throw e;
    }
    deps.eventBus?.emit(EVENT_TYPES.GRAPH_CHANGED, { reason: "schedule-visibility", nodeId: id });
    return c.json(result);
  });
}
