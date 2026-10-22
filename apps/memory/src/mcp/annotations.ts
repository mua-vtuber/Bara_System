/**
 * mcp/annotations.ts — MCP 도구 annotations 단일 출처 (T9 spec A).
 * descriptions.ts 와 같은 원칙 — 등록부(tools-*.ts)는 이 맵을 참조하고 등록부 안에
 * 힌트 리터럴을 직접 기재하지 않는다.
 *
 * SDK ToolAnnotations 의 칸: title / readOnlyHint / destructiveHint /
 * idempotentHint / openWorldHint (전부 선택). MCP 규약상 이 값들은 *힌트*일 뿐
 * 강제가 아니다 — 클라이언트가 확인 프롬프트 노출 여부 등을 정하는 데 쓴다.
 *
 * 세 갈래로 나뉜다:
 *   - 순수 열람(readOnlyHint true + idempotentHint true): 같은 인자로 다시 불러도
 *     저장소가 바뀌지 않는다. 검색은 캐시를 태울 뿐 상태를 바꾸지 않는다.
 *   - 저장 5종(readOnlyHint false + destructiveHint false + idempotentHint false):
 *     append 전용이라 기존 기억을 지우거나 덮어쓰지 않지만, 두 번 부르면 중복
 *     노드가 하나 더 생기므로 멱등이 아니다.
 *   - 정리 신고 2종: 검토 큐에 제안이 들어갈 뿐 무엇도 파괴하지 않는다. 재제출은
 *     지문·stageVersion 검증에서 stale 로 갈리므로 멱등 표시를 하지 않는다.
 *
 * title 은 클라이언트가 사람에게 보여주는 짧은 이름이다. 어느 클라이언트가 어떤
 * 언어 환경에서 읽을지 알 수 없어 영어로 둔다(대시보드 한글 표기는 별도 층 몫).
 */

/** SDK ToolAnnotations 중 우리가 쓰는 칸만 좁힌 형태 — 등록부·테스트 공용. */
export type BaraToolAnnotations = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint: boolean;
};

/** 순수 열람 — 저장소를 바꾸지 않고, 같은 인자면 몇 번 불러도 같은 성질이다. */
function readOnly(title: string): BaraToolAnnotations {
  return { title, readOnlyHint: true, idempotentHint: true };
}

/** 쓰기 — append 전용(destructive 아님)이되 재호출 시 중복이 생겨 멱등 아님. */
function appendOnly(title: string): BaraToolAnnotations {
  return { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false };
}

export const TOOL_ANNOTATIONS = {
  search_memory: readOnly("Search memory"),
  get_memory: readOnly("Get memory by id"),
  list_recent: readOnly("List recent memories"),
  store_memory: appendOnly("Store memory"),
  save_decision: appendOnly("Save decision"),
  save_idea: appendOnly("Save idea"),
  save_question: appendOnly("Save question"),
  save_preference: appendOnly("Save preference"),
  cleanup_list_candidates: readOnly("List cleanup candidates"),
  cleanup_submit_proposal: appendOnly("Submit cleanup proposal"),
  cleanup_report_no_finding: appendOnly("Report cleanup no-finding"),
  cleanup_run_status: readOnly("Get cleanup run status"),
  bara_doctor: readOnly("Run self-diagnosis"),
  get_usage_guide: readOnly("Usage guide"),
  get_profile: readOnly("Get preference profile"),
  recall_context: readOnly("Recall scoped context"),
  update_memory: { title: "Correct memory", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  supersede_memory: { title: "Replace memory", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  retract_memory: { title: "Retract memory", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
} as const satisfies Record<string, BaraToolAnnotations>;
