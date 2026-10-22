/**
 * v52 — MCP 도구 호출 횟수 표 (2026-10-21 mcp-usage-and-guidance spec 7.1).
 * 기준 스키마(db/schema/*.sql)는 동결이라 이 마이그레이션으로 더한다. 새 표라 기존 행을 바꾸지 않는다.
 *
 * mcp_tool_usage_daily — (날짜, 클라이언트, 종류, 이름, 결과) 별 호출 횟수만. 질문 글·인자·기억 내용을 담는 칸이 없다(사생활).
 *   day     설정 시간대 YYYY-MM-DD
 *   client  토큰에서 나온 adapterId
 *   kind    tool(도구 호출) | handshake(연결 시작)
 *   name    kind=tool 이면 도구 이름, kind=handshake 이면 'initialize'
 *   outcome ok | error
 * 기본 키 첫 칸이 day 라 날짜 범위 읽기에 따로 색인이 필요 없다.
 *
 * 동결된 마이그레이션이라 CHECK 목록은 글자 그대로 적는다(mcp/usage-categories.ts 의 USAGE_KINDS·USAGE_OUTCOMES 와 같은 값).
 */
import type { Migration } from "../migrations.ts";
import { BASELINE_VERSION } from "../baseline-schema.ts";
import { runSqlStatements } from "../sql-statements.ts";

const SQL = `
CREATE TABLE IF NOT EXISTS mcp_tool_usage_daily (
    day      TEXT NOT NULL,
    client   TEXT NOT NULL,
    kind     TEXT NOT NULL CHECK (kind IN ('tool', 'handshake')),
    name     TEXT NOT NULL,
    outcome  TEXT NOT NULL CHECK (outcome IN ('ok', 'error')),
    calls    INTEGER NOT NULL CHECK (calls > 0),
    PRIMARY KEY (day, client, kind, name, outcome)
);
`;

export const v52McpToolUsage: Migration = {
  version: BASELINE_VERSION + 5,
  name: "mcp-tool-usage",
  up: (db) => runSqlStatements(db, SQL, "v52-mcp-tool-usage"),
};
