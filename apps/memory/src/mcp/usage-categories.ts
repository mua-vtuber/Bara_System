/**
 * mcp/usage-categories.ts — MCP 도구 사용 횟수 기록의 종류·결과·도구 분류 단일 출처
 * (2026-10-21 mcp-usage-and-guidance spec 7.2).
 *
 * 표 mcp_tool_usage_daily 의 CHECK 목록(v52 는 동결 마이그레이션이라 글자 그대로 적는다)과 같은 값이어야 하며,
 * 같은지는 v52 테스트가 대조한다. 도구 분류 맵의 키는 실제 tools/list 이름과 같아야 하며 usage-categories.test.ts 가 대조한다.
 */

export const USAGE_KINDS = ["tool", "handshake"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const USAGE_OUTCOMES = ["ok", "error"] as const;
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];

/** 연결 시작(initialize) 줄의 name 칸 값. */
export const HANDSHAKE_NAME = "initialize";

export const TOOL_USAGE_CATEGORIES = [
  "recall", "save", "correct", "cleanup", "diagnose", "guide",
] as const;
export type ToolUsageCategory = (typeof TOOL_USAGE_CATEGORIES)[number];

export const TOOL_USAGE_CATEGORY: Readonly<Record<string, ToolUsageCategory>> = {
  recall_context: "recall", search_memory: "recall", get_memory: "recall",
  list_recent: "recall", get_profile: "recall",
  store_memory: "save", save_decision: "save", save_idea: "save",
  save_question: "save", save_preference: "save",
  update_memory: "correct", supersede_memory: "correct", retract_memory: "correct",
  cleanup_list_candidates: "cleanup", cleanup_submit_proposal: "cleanup",
  cleanup_report_no_finding: "cleanup", cleanup_run_status: "cleanup",
  bara_doctor: "diagnose",
  get_usage_guide: "guide",
};
