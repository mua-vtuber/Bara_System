/**
 * mcp/usage-summary.ts — 사용 횟수 줄을 클라이언트별 지표로 요약하는 순수 함수 (2026-10-21 spec 9.1).
 *
 * DB·시계를 모르고 줄(fixture 가능)과 분류 맵만 받는다. 분모가 0 인 비율은 0 으로 채우지 않고 null 이다(없는 값을 있는 값처럼 보이지 않게).
 */
import { HANDSHAKE_NAME, TOOL_USAGE_CATEGORIES, type ToolUsageCategory, type UsageKind, type UsageOutcome } from "./usage-categories.ts";

export interface McpUsageRow {
  day: string;
  client: string;
  kind: UsageKind;
  name: string;
  outcome: UsageOutcome;
  calls: number;
}

export interface McpClientUsageSummary {
  client: string;
  /** 줄이 하나라도 있는 날 수(도구 호출 또는 연결 시작). */
  activeDays: number;
  handshakes: number;
  calls: Record<ToolUsageCategory, number>;
  /** 결과가 error 인 도구 호출 수. */
  errors: number;
  /** save 가 0 이면 null. */
  recallPerSave: number | null;
  /** 활동한 날 중 찾기 호출이 1회 이상 있던 날의 비율. activeDays 가 0 이면 null. */
  recallDayShare: number | null;
  /** 연결 시작이 0 이면 null. */
  recallPerHandshake: number | null;
  guidePerHandshake: number | null;
  /** 분류 맵에 없는 도구 이름(어느 분류에도 세지 않았다). */
  uncategorized: string[];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function emptyCalls(): Record<ToolUsageCategory, number> {
  return Object.fromEntries(TOOL_USAGE_CATEGORIES.map((c) => [c, 0])) as Record<ToolUsageCategory, number>;
}

interface Accumulator {
  days: Set<string>;
  recallDays: Set<string>;
  handshakes: number;
  calls: Record<ToolUsageCategory, number>;
  errors: number;
  uncategorized: Set<string>;
}

export function summarizeMcpUsage(
  rows: readonly McpUsageRow[],
  categories: Readonly<Record<string, ToolUsageCategory>>,
): McpClientUsageSummary[] {
  const byClient = new Map<string, Accumulator>();
  for (const row of rows) {
    let acc = byClient.get(row.client);
    if (acc === undefined) {
      acc = { days: new Set(), recallDays: new Set(), handshakes: 0, calls: emptyCalls(), errors: 0, uncategorized: new Set() };
      byClient.set(row.client, acc);
    }
    acc.days.add(row.day);
    if (row.kind === "handshake") {
      if (row.name === HANDSHAKE_NAME) acc.handshakes += row.calls;
      continue;
    }
    if (row.outcome === "error") acc.errors += row.calls;
    const category = categories[row.name];
    if (category === undefined) {
      acc.uncategorized.add(row.name);
      continue;
    }
    acc.calls[category] += row.calls;
    if (category === "recall") acc.recallDays.add(row.day);
  }
  return [...byClient.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([client, acc]) => ({
      client,
      activeDays: acc.days.size,
      handshakes: acc.handshakes,
      calls: acc.calls,
      errors: acc.errors,
      recallPerSave: ratio(acc.calls.recall, acc.calls.save),
      recallDayShare: ratio(acc.recallDays.size, acc.days.size),
      recallPerHandshake: ratio(acc.calls.recall, acc.handshakes),
      guidePerHandshake: ratio(acc.calls.guide, acc.handshakes),
      uncategorized: [...acc.uncategorized].sort(),
    }));
}
