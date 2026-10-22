/**
 * routes/mcp-usage.ts — MCP 도구 호출 횟수 읽기 API (2026-10-21 mcp-usage-and-guidance spec 9.1).
 *
 *   GET /api/mcp-usage?from=YYYY-MM-DD&to=YYYY-MM-DD → McpUsageResponse
 *
 * 권한: full 토큰만. token-scope.ts 의 SCOPED_HTTP_ROUTES 에 넣지 않는다(표에 없는 경로는 제한 토큰이 모두 거부된다).
 * from·to 는 필수이며 기본값으로 채우지 않는다. 형식이 틀리거나 from > to 이거나 366일을 넘으면 400 과 무엇이 틀렸는지.
 * 응답의 counterHealth 는 같은 서버 프로세스의 기록기 상태라, 기록 실패가 있으면 이 숫자가 불완전함을 이 응답에서 바로 알 수 있다.
 */
import type { Hono } from "hono";
import { TOOL_USAGE_CATEGORY, type ToolUsageCategory } from "../../mcp/usage-categories.ts";
import type { McpUsageHealth, McpUsageRecorder } from "../../mcp/usage-recorder.ts";
import { summarizeMcpUsage, type McpClientUsageSummary, type McpUsageRow } from "../../mcp/usage-summary.ts";
import { err } from "../http-helpers.ts";
import type { MemoryApiDeps } from "../types.ts";

export const MCP_USAGE_PATH = "/api/mcp-usage";
/** 한 번에 읽을 수 있는 최대 일수(양끝 포함). */
export const MCP_USAGE_MAX_RANGE_DAYS = 366;

/** 집계에 들어오지 않는 호출 — 응답에 그대로 싣는 고정 문구. */
export const MCP_USAGE_NOT_COUNTED: readonly string[] = [
  "SDK 가 인자 검사에서 먼저 거절한 도구 호출",
  "토큰 권한으로 꺼진 도구에 대한 호출",
  "인증에 실패한 요청",
  "서버 재시작 전의 counterHealth(기록 실패 횟수는 서버 시작 이후만 센다)",
];

export interface McpUsageResponse {
  range: { from: string; to: string };
  rows: McpUsageRow[];
  totalRowsInTable: number;
  categories: Record<string, ToolUsageCategory>;
  summary: McpClientUsageSummary[];
  counterHealth: McpUsageHealth;
  notCounted: string[];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** YYYY-MM-DD 를 UTC 자정 밀리초로. 형식·달력이 틀리면 null (2026-02-30 같은 날짜도 거절). */
function dayToMs(value: string | undefined): number | null {
  if (value === undefined || !DAY_RE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms;
}

const shown = (value: string | undefined): string => (value === undefined ? "없음" : JSON.stringify(value));

/** from·to 검증. 문자열이면 그것이 400 이유다. */
export function validateUsageRange(from: string | undefined, to: string | undefined): { from: string; to: string } | string {
  const fromMs = dayToMs(from);
  if (fromMs === null) return `from 값은 YYYY-MM-DD 형식의 실제 날짜여야 함 (받은 값: ${shown(from)})`;
  const toMs = dayToMs(to);
  if (toMs === null) return `to 값은 YYYY-MM-DD 형식의 실제 날짜여야 함 (받은 값: ${shown(to)})`;
  if (fromMs > toMs) return `from 은 to 보다 늦을 수 없음 (from: ${from}, to: ${to})`;
  const days = (toMs - fromMs) / MS_PER_DAY + 1;
  if (days > MCP_USAGE_MAX_RANGE_DAYS) return `기간은 최대 ${MCP_USAGE_MAX_RANGE_DAYS}일 (받은 기간: ${days}일)`;
  return { from: from!, to: to! };
}

export function registerMcpUsageRoutes(app: Hono, deps: MemoryApiDeps, recorder: McpUsageRecorder): void {
  app.get(MCP_USAGE_PATH, (c) => {
    if (!deps.store) return err(c, 503, "저장소가 주입되지 않아 MCP 사용 횟수를 읽을 수 없음");
    const range = validateUsageRange(c.req.query("from"), c.req.query("to"));
    if (typeof range === "string") return err(c, 400, range);
    const db = deps.store.getRawDb();
    const rows = db
      .query(
        `SELECT day, client, kind, name, outcome, calls FROM mcp_tool_usage_daily
         WHERE day BETWEEN ? AND ? ORDER BY day, client, kind, name, outcome`,
      )
      .all(range.from, range.to) as McpUsageRow[];
    const total = db.query("SELECT COUNT(*) AS n FROM mcp_tool_usage_daily").get() as { n: number };
    const body: McpUsageResponse = {
      range,
      rows,
      totalRowsInTable: total.n,
      categories: { ...TOOL_USAGE_CATEGORY },
      summary: summarizeMcpUsage(rows, TOOL_USAGE_CATEGORY),
      counterHealth: recorder.health(),
      notCounted: [...MCP_USAGE_NOT_COUNTED],
    };
    return c.json(body);
  });
}
