/**
 * mcp/usage-recorder.ts — MCP 도구 호출·연결 시작 횟수 기록기 (2026-10-21 mcp-usage-and-guidance spec 8.1).
 *
 * 한 호출당 한 줄 UPSERT 만 한다(동기). 질문 글·인자·기억 내용은 받지도 기록하지도 않는다(D2).
 *
 * 기록이 실패해도 도구 결과는 그대로 돌려준다(P3) — 이미 실행된 도구를 기록 실패 때문에 실패로 돌리면 AI 가 저장을
 * 다시 시도해 중복 기억이 생긴다. 대신 실패를 숨기지 않는다: console.error 로 크게 남기고, health() 가 실패 횟수·마지막 오류를
 * 돌려주며 숫자 읽기 라우트(GET /api/mcp-usage)가 그것을 같은 응답에 싣는다.
 */
import type { Database } from "bun:sqlite";
import { nowKst, zoneDay } from "../db/store-internal/helpers.ts";
import type { UsageKind, UsageOutcome } from "./usage-categories.ts";

export interface McpUsageHealth {
  /** 기록기 생성 시각(서버 시작 무렵). 아래 숫자는 이 시각 이후만 센다 — 재시작하면 0 으로 돌아간다. */
  since: string;
  writeFailures: number;
  lastFailureAt: string | null;
  /** 오류 문구만. 인자·내용은 담지 않는다. */
  lastError: string | null;
  /** 다른 비동기 단계가 연 트랜잭션 안에서 쓴 횟수 — 그 트랜잭션이 되돌려지면 이 기록도 함께 사라질 수 있다(spec 8.3). */
  recordedInsideOpenTransaction: number;
}

export interface McpUsageEntry {
  /** 토큰에서 나온 adapterId. undefined 면 이름을 지어내지 않고 실패로 센다. */
  client: string | undefined;
  kind: UsageKind;
  name: string;
  outcome: UsageOutcome;
}

const UPSERT_SQL =
  `INSERT INTO mcp_tool_usage_daily (day, client, kind, name, outcome, calls) VALUES (?, ?, ?, ?, ?, 1)
   ON CONFLICT(day, client, kind, name, outcome) DO UPDATE SET calls = calls + 1`;

export class McpUsageRecorder {
  private readonly since = nowKst();
  private writeFailures = 0;
  private lastFailureAt: string | null = null;
  private lastError: string | null = null;
  private insideOpenTransaction = 0;

  /** getDb 는 첫 기록 때 불린다 — 연결을 못 얻으면(저장소 미주입 등) 기록 실패로 드러난다. */
  constructor(private readonly getDb: () => Database) {}

  record(entry: McpUsageEntry): void {
    try {
      if (entry.client === undefined || entry.client === "") {
        throw new Error("adapterId 없음 — 클라이언트 이름을 정할 수 없어 기록하지 않았다");
      }
      const db = this.getDb();
      if (db.inTransaction) this.insideOpenTransaction += 1;
      db.query(UPSERT_SQL).run(zoneDay(), entry.client, entry.kind, entry.name, entry.outcome);
    } catch (error) {
      this.writeFailures += 1;
      this.lastFailureAt = nowKst();
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error(`[mcp-usage] 사용 횟수 기록 실패: ${this.lastError}`);
    }
  }

  health(): McpUsageHealth {
    return {
      since: this.since,
      writeFailures: this.writeFailures,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
      recordedInsideOpenTransaction: this.insideOpenTransaction,
    };
  }
}
