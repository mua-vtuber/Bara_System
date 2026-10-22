/**
 * mcp/instructions.ts — MCP 서버 수준 instructions 문안 단일 출처 (spec G).
 *
 * 도구 description(descriptions.ts)이 "이 도구 하나를 언제 왜 부르는가"를 말한다면,
 * 이 문안은 그 위층 — *도구들을 가로지르는 전략* 을 말한다. 어느 한 도구의 설명문에도
 * 들어갈 자리가 없는 것들이다: 색인 먼저 훑고 본문은 골라 받는 2단 검색 박자,
 * 검색을 아예 하지 말아야 할 질문, 못 찾았을 때 정직하게 없다고 말하는 기준,
 * 회신에 기억 id 를 인용해 사용자가 대시보드에서 감사할 수 있게 하는 규약.
 *
 * 소비자가 클라이언트 LLM 이라 영어로 작성한다(저장소 자산 규약 — description 한글,
 * body 영어). 클라이언트는 initialize 응답으로 이 문안을 받아 세션에 주입한다.
 *
 * 길이 예산 = 500 단어 미만. 이 문안은 *세션마다 전량* 지불되는 토큰이라 도구 설명문
 * (각 90단어 예산)보다 더 아껴 쓴다. server.test.ts 가 단어 수를 감시한다.
 *
 * 정직성 계약: 여기 적힌 모든 동작 주장은 실제 배포된 동작과 일치해야 한다. 서버가
 * 하지 않는 일을 약속하면 클라이언트 AI 가 그 약속에 기대어 잘못 행동한다 — 문안을
 * 고칠 때 반드시 해당 코드 경로를 확인할 것. 계약 문구는 server.test.ts 가 부분
 * 문자열로 고정(pinning)한다.
 *
 * WP-B1-16(SA-5): read-only 토큰은 쓰기 도구 자체가 tools/list 에서 빠진다(access.ts
 * ScopedMcpServer). WRITING·CORRECTING 절을 그대로 두면 정직성 계약을 어긴다 — 없는
 * 도구를 쓰라고 권하는 문안이 되기 때문이다. buildMcpInstructions(scope) 가 scope 별로
 * 다른 문안을 만든다: 쓰기 가능 scope(mcp-standard·full·undefined)는 기존
 * MCP_INSTRUCTIONS 그대로, read-only 는 WRITING·CORRECTING 두 절을 빼고 한 줄
 * 읽기 전용 안내로 바꾼다.
 *
 * 2026-10-21 개편(mcp-usage-and-guidance spec 11): "언제 찾는가"를 구체적인 순간 목록(WHEN TO RECALL)으로,
 * 분류 해시태그 사슬 양식을 항상 실리는 WRITING 절로 옮겼다. 길고 자세한 사용법(저장 도구 고르기·교훈
 * 양식·증거 칸·경고 코드·분쟁 해소)은 get_usage_guide 도구(usage-guide.ts)가 맡는다. 2026-10-22 에
 * 사슬 예시 두 줄(프로젝트 키 이름이 들어가는 줄)도 사용 안내로 옮겨, 여기는 사슬 규칙만 남는다.
 *
 * 범위 문장이 말하는 동작의 코드 근거: memory/project-scope-resolver.ts(이름·별칭·번호 해석, 모르는·
 * 애매한 값은 UNKNOWN_PROJECT·AMBIGUOUS_PROJECT 오류), recall_context·get_profile 의 범위 없을 때 기본값
 * "global"(mcp/tools-context.ts, server-internal/profile.ts). 경고 문장의 근거: mcp/hashtag-warning-fields.ts.
 *
 * 2026-10-22 보강(참고 프로젝트 비교 — openhuman 의 "다른 말로 다시·나눠 찾기", PageIndex 의 "안 맞는
 * 결과는 못 찾은 것"): 재검색 규칙을 넣었다. 시간 표현 → 날짜 범위 안내는 예산 밖인 search_memory
 * since 칸 설명(tools-memory.ts)에 뒀다. 날짜 범위는 자동 읽기분까지 appliedFilters.dateRange 로
 * 돌아오므로 "그 범위를 떼고 다시"가 참이다(server-internal/routes/search-retrieval.ts).
 *
 * 같은 날 검토 정리: get_profile·범위 기본값이 두 번 나오던 HOW THIS USER WORKS 절을 WHEN TO RECALL 에
 * 합쳤고, FORBIDDEN 문장은 새 ERRORS 절로 옮겼다. ERRORS 절은 바라가 꺼졌거나 실패할 때 AI 가 "저장된 것
 * 없음"으로 잘못 말하지 않게 한다. "시간 초과된 저장은 이미 들어갔을 수 있다"의 근거: 클라이언트가
 * 기다림을 끊어도 서버 쪽 저장 처리는 멈추지 않는다. 저장 전 사용자 동의는 넣지 않는다 — 사용자 개인
 * 선호라 앱 지침이 아니라 각 사용자 설정 몫이다(2026-10-22 사용자 결정).
 */

import type { TokenScope } from "../federation/sse-tokens.ts";

/** 모든 scope 가 공유하는 앞부분 — 찾는 순간·범위·검색 박자·검색 금지·빈 결과·오류 처리·인용 규약. */
const SHARED_PREFIX = `bara is this user's shared long-term memory across AI clients.

WHEN TO RECALL
Search at these moments, not on every turn:
- Starting work in a project: recall_context with scope.projectId set to the project name.
- Before proposing a design or choosing between options: search past decisions and rejected ideas.
- The user points to the past ("last time", "why did we"): search before answering. For a vague pointer ("that thing yesterday"), list_recent.
- Before asking the user something they may already have told you.
- Fixing an error: search lessons with the same symptom.
- Before choosing output style, format or tooling: get_profile (directives, anti_preferences).
scope.projectId accepts a project name, alias or id; an unknown or ambiguous name returns an error, not an empty result. Without a scope, recall_context and get_profile cover only memories outside any project. The search_memory project field alone expands vocabulary, not isolation.

SEARCHING
For past-decision questions, use search_memory with responseMode "index", then get_memory with the ids that matter. Batch ids in one call.

DO NOT SEARCH for questions about the codebase or file structure, which your code tools answer; for information already in this conversation; or before you understand what is being asked.

WHEN NOTHING IS FOUND
A hit not answering the question is no hit. Retry with other wording, split compound questions, drop any appliedFilters date range. Two such tries per part with no relevant hit is a successful answer: report nothing stored. Do not thrash. Unexpectedly empty or wrong results: call bara_doctor before concluding memories are missing. When evidence is insufficient, say so instead of guessing.

ERRORS
A tool error or timeout is not "nothing stored": tell the user once and continue without memory. A timed-out save may already be stored; search before saving it again. FORBIDDEN means this client's token lacks permission; do not bypass it via REST.

CITING
Cite recalled evidence inline as [#482]. Distinguish user statements, observations and AI inferences. Default recall excludes disputed, superseded, retracted and out-of-validity memories.`;

/** 쓰기 가능 scope(mcp-standard·full·undefined = 레거시 직결) 전용 — WRITING·CORRECTING 두 절. */
const WRITE_CAPABLE_SECTIONS = `WRITING
Before your first save in a session, call get_usage_guide once for save tool choice, chain examples and classification values in use.
Ask: will this matter next month? Session-scratch details are not memories.
Begin content with a classification chain so related memories group. Each tag is #key:value and must end with a comma or line break, or the value swallows the following text.
Reuse values already in use; do not coin synonyms.
Malformed tags are still saved; hashtagWarnings shows how they were read.
A near-duplicate save returns code DUPLICATE with existingId, similarity and an excerpt. Read it; use force true only when distinct. save_preference is exempt from similarity checking.
On SECRET_DETECTED, never retry with the credential; strip it first.

CORRECTING
Read get_memory first. update_memory corrects wording; supersede_memory names an already-saved replacement for a changed fact; retract_memory withdraws it, keeping history and backups. Pass expectedRevision and a unique requestId. Reuse requestId only for identical retries. On CONFLICT, reread; never overwrite blindly. A conflicting new memory becomes disputed beside the older one; get_usage_guide explains resolving it.`;

/**
 * read-only scope 전용 — WRITE_CAPABLE_SECTIONS 자리를 대신한다. 이 scope 의
 * tools/list 에는 store_memory·save_*·update_memory·supersede_memory·retract_memory
 * 가 아예 없으므로(access.ts ScopedMcpServer), 있지도 않은 도구를 쓰라고 권하지
 * 않는다 — 정직성 계약(파일 상단 주석).
 */
const READ_ONLY_NOTICE = `This connection is read-only: no memory can be written, corrected, superseded or retracted from here. Report what recall finds; do not ask the user to dictate a save through this client.`;

/**
 * scope 별 instructions 조립 (WP-B1-16 / SA-5). read-only 는 WRITING·CORRECTING 을
 * READ_ONLY_NOTICE 로 바꾼다. 그 외(undefined·mcp-standard·full)는 같은 문안이다 —
 * 쓰기 가능 scope 사이에 문안 차이를 두지 않는다.
 */
export function buildMcpInstructions(scope: TokenScope | undefined): string {
  if (scope === "read-only") return [SHARED_PREFIX, READ_ONLY_NOTICE].join("\n\n");
  return [SHARED_PREFIX, WRITE_CAPABLE_SECTIONS].join("\n\n");
}

/** 쓰기 가능 scope 의 문안 — server.test.ts 가 이 상수를 그대로 참조한다(하위 호환). */
export const MCP_INSTRUCTIONS = buildMcpInstructions(undefined);
