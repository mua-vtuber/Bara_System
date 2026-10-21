import { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { err } from "../http-helpers.ts";
import { registerScheduleVisibilityRoutes } from "./schedule-visibility.ts";
import {
  buildDateOccurrences,
  type DateOccurrenceKind,
} from "../../memory/date-occurrences.ts";

const VALID_KINDS = new Set<DateOccurrenceKind>(["event", "birthday", "column_date"]);

function parseBoundedInt(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): { ok: true; value: number } | { ok: false; message: string } {
  if (raw === undefined || raw.trim() === "") return { ok: true, value: fallback };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return { ok: false, message: `${name} 은 ${min}~${max} 사이 정수여야 합니다` };
  }
  return { ok: true, value: n };
}

function parseKinds(raw: string | undefined): { ok: true; value: Set<DateOccurrenceKind> } | { ok: false; message: string } {
  if (raw === undefined || raw.trim() === "") {
    return { ok: true, value: new Set(VALID_KINDS) };
  }
  const kinds = new Set<DateOccurrenceKind>();
  for (const part of raw.split(",")) {
    const kind = part.trim();
    if (!kind) continue;
    if (!VALID_KINDS.has(kind as DateOccurrenceKind)) {
      return {
        ok: false,
        message: "kind 는 event,birthday,column_date 중 하나 이상을 comma 로 나열해야 합니다",
      };
    }
    kinds.add(kind as DateOccurrenceKind);
  }
  return { ok: true, value: kinds.size > 0 ? kinds : new Set(VALID_KINDS) };
}

export function registerDateOccurrencesRoutes(app: Hono, deps: MemoryApiDeps): void {
  // 일정 목록에서 글을 빼는 "일정 아님" 표시 — 같은 일정 목록의 짝이라 여기서 함께 등록한다(server.ts 줄 수 유지).
  registerScheduleVisibilityRoutes(app, deps);
  const api = new Hono({ strict: false });

  api.get("/date-occurrences", async (c) => {
    if (!deps.store?.entitiesRepo || !deps.store?.entityTypeRegistryDb) {
      return err(c, 503, "날짜 발생 항목 API 비활성 (store 미주입)");
    }

    const days = parseBoundedInt(c.req.query("days"), "days", 90, 1, 365);
    if (!days.ok) return err(c, 400, days.message);
    const pastDays = parseBoundedInt(c.req.query("pastDays"), "pastDays", 90, 0, 365);
    if (!pastDays.ok) return err(c, 400, pastDays.message);
    const limit = parseBoundedInt(c.req.query("limit"), "limit", 80, 1, 200);
    if (!limit.ok) return err(c, 400, limit.message);
    const kinds = parseKinds(c.req.query("kind"));
    if (!kinds.ok) return err(c, 400, kinds.message);

    const column = c.req.query("column")?.trim() || undefined;
    const q = c.req.query("q")?.trim() || undefined;

    const response = await buildDateOccurrences(
      {
        getAllNodes: (nodeLimit?: number) => deps.store.getAllNodes(nodeLimit),
        listPersons: (opts?: { limit?: number }) => deps.store.listPersons(opts),
        entitiesRepo: deps.store.entitiesRepo,
        entityTypeRegistryDb: deps.store.entityTypeRegistryDb,
      },
      {
        days: days.value,
        pastDays: pastDays.value,
        limit: limit.value,
        kinds: kinds.value,
        column,
        q,
      },
    );

    return c.json(response);
  });

  app.route("/api", api);
}
