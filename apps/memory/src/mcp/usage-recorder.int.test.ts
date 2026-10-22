/**
 * mcp/usage-recorder — 실제 SQLite + 실제 v52 표 (2026-10-21 mcp-usage-and-guidance spec 8.1, A-T2).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { getConfiguredTimeZone, setTimeZone } from "../db/store-internal/helpers.ts";
import { McpUsageRecorder } from "./usage-recorder.ts";

let db: Database;
let recorder: McpUsageRecorder;
const originalZone = getConfiguredTimeZone();

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 8 });
  recorder = new McpUsageRecorder(() => db);
});
afterEach(() => {
  setTimeZone(originalZone);
  db.close();
});

interface Row { day: string; client: string; kind: string; name: string; outcome: string; calls: number }
const rows = (): Row[] =>
  db.query("SELECT day, client, kind, name, outcome, calls FROM mcp_tool_usage_daily ORDER BY day, client, kind, name, outcome").all() as Row[];

/** 실패 로그가 테스트 출력에 섞이지 않게 막고, 실제로 남겼는지 확인할 수 있게 한다. */
function silenceErrorLog() {
  return spyOn(console, "error").mockImplementation(() => {});
}

describe("McpUsageRecorder", () => {
  test("같은 열쇠를 두 번 기록하면 한 줄의 횟수가 2 가 된다", () => {
    recorder.record({ client: "claude-code", kind: "tool", name: "search_memory", outcome: "ok" });
    recorder.record({ client: "claude-code", kind: "tool", name: "search_memory", outcome: "ok" });
    const [only, ...rest] = rows();
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ client: "claude-code", kind: "tool", name: "search_memory", outcome: "ok", calls: 2 });
    expect(recorder.health().writeFailures).toBe(0);
  });

  test("결과·클라이언트·종류가 다르면 다른 줄이다", () => {
    recorder.record({ client: "claude-code", kind: "tool", name: "get_memory", outcome: "ok" });
    recorder.record({ client: "claude-code", kind: "tool", name: "get_memory", outcome: "error" });
    recorder.record({ client: "pet", kind: "tool", name: "get_memory", outcome: "ok" });
    recorder.record({ client: "pet", kind: "handshake", name: "initialize", outcome: "ok" });
    expect(rows()).toHaveLength(4);
    expect(rows().every((r) => r.calls === 1)).toBe(true);
  });

  test("날짜는 설정 시간대 기준이다", () => {
    setTimeZone("Pacific/Kiritimati"); // UTC+14
    recorder.record({ client: "a", kind: "tool", name: "t", outcome: "ok" });
    setTimeZone("Etc/GMT+12"); // UTC-12 — 위와 항상 하루 다르다
    recorder.record({ client: "a", kind: "tool", name: "t", outcome: "ok" });
    const days = rows().map((r) => r.day);
    expect(days).toHaveLength(2);
    expect(days[0]).not.toBe(days[1]);
    for (const day of days) expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("client 가 없으면 이름을 지어내지 않고 기록 0 + 실패 1 로 드러난다", () => {
    const log = silenceErrorLog();
    recorder.record({ client: undefined, kind: "tool", name: "t", outcome: "ok" });
    expect(rows()).toEqual([]);
    const health = recorder.health();
    expect(health.writeFailures).toBe(1);
    expect(health.lastError).toContain("adapterId");
    expect(health.lastFailureAt).not.toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("[mcp-usage]");
    log.mockRestore();
  });

  test("표가 없는 DB 여도 던지지 않고 실패로 센다", () => {
    const log = silenceErrorLog();
    db.run("DROP TABLE mcp_tool_usage_daily");
    expect(() => recorder.record({ client: "a", kind: "tool", name: "t", outcome: "ok" })).not.toThrow();
    expect(recorder.health().writeFailures).toBe(1);
    expect(recorder.health().lastError).toContain("mcp_tool_usage_daily");
    log.mockRestore();
  });

  test("연결을 못 얻어도(저장소 미주입) 던지지 않고 원인 문구를 남긴다", () => {
    const log = silenceErrorLog();
    const broken = new McpUsageRecorder(() => { throw new Error("store 미주입"); });
    expect(() => broken.record({ client: "a", kind: "tool", name: "t", outcome: "ok" })).not.toThrow();
    expect(broken.health()).toMatchObject({ writeFailures: 1, lastError: "store 미주입" });
    log.mockRestore();
  });

  test("열린 트랜잭션 안에서 쓰면 recordedInsideOpenTransaction 이 오른다", () => {
    db.run("BEGIN IMMEDIATE");
    recorder.record({ client: "a", kind: "tool", name: "t", outcome: "ok" });
    db.run("ROLLBACK");
    expect(recorder.health().recordedInsideOpenTransaction).toBe(1);
    expect(rows()).toEqual([]); // 되돌려지면 기록도 사라진다 — 그래서 센다.
    recorder.record({ client: "a", kind: "tool", name: "t", outcome: "ok" });
    expect(recorder.health().recordedInsideOpenTransaction).toBe(1);
    expect(rows()).toHaveLength(1);
  });

  test("health().since 는 생성 시각 문자열이다", () => {
    expect(recorder.health().since).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
