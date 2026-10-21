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
 * 14종의 90단어 예산보다 더 아껴 쓴다. server.test.ts 가 단어 수를 감시한다.
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
 */

import type { TokenScope } from "../federation/sse-tokens.ts";

/** 모든 scope 가 공유하는 앞부분 — SEARCHING·검색 금지·빈 결과 처리·인용 규약. */
const SHARED_PREFIX = `bara is this user's shared long-term memory across AI clients. Retrieve relevant evidence before substantive work. Use explicit scope for projects; project alone expands vocabulary, not isolation. Never treat AI inference as a confirmed user statement.

SEARCHING
At session start, call recall_context for current preferences and relevant memories within a budget; default is global, project scope includes global unless disabled. list_recent offers recent activity. Before answering past-decision questions, use search_memory with responseMode "index", then get_memory with the ids that matter. oneLine is a truncated preview, not the full text. Batch ids instead of fetching each separately.

DO NOT SEARCH for questions about the codebase or file structure, which your code tools answer; for information already in this conversation; or before you understand what is being asked.

WHEN NOTHING IS FOUND
Two reasonable searches with different wording and no hits is a successful answer: report nothing stored. Do not thrash. Unexpectedly empty or wrong results: call bara_doctor before concluding memories are missing. Related hits do not prove an answer; abstain when evidence is insufficient.

CITING
Cite recalled evidence inline as [#482]. Distinguish user statements, observations and AI inferences. Default recall excludes disputed, superseded, retracted and out-of-validity memories; get_memory can inspect their history state.`;

/** 쓰기 가능 scope(mcp-standard·full·undefined = 레거시 직결) 전용 — WRITING·CORRECTING 두 절. */
const WRITE_CAPABLE_SECTIONS = `WRITING
Use save_decision for settled choices, save_preference for stated preferences, save_idea for possibilities, save_question for open questions, store_memory for other durable facts. Ask: will this matter next month? Session-scratch details are not memories.
Record evidence.assertionKind, sourceEventId, claimKey, sessionRef and evidenceRefs when available. Reuse the same event/claim identity across clients; copying a memory is not independent confirmation. Different claims from one event need different claimKeys. Never invent a source or confirmation.
A near-duplicate save returns code DUPLICATE with existingId, similarity and an excerpt. Read it; use force true only when distinct. save_preference is exempt from similarity checking, but source-event replay still prevents repeated votes.
On SECRET_DETECTED, never retry with the credential included. Strip it and retry.

CORRECTING
Read get_memory first. update_memory corrects wording; supersede_memory names an already-saved replacement for a changed fact; retract_memory withdraws usage without erasing history or backups. Pass expectedRevision and a unique requestId. Reuse requestId only for identical retries. On CONFLICT, reread; never overwrite blindly. Derived memories may be invalidated.
Similar facts or preferences about the same subject are flagged, not replaced: the newer memory becomes disputed, a conflict candidate linked to the older one. Ask the user which holds, then either supersede_memory the older one with the disputed replacement, which also makes it active, or retract_memory the disputed one to keep the older.`;

/**
 * read-only scope 전용 — WRITE_CAPABLE_SECTIONS 자리를 대신한다. 이 scope 의
 * tools/list 에는 store_memory·save_*·update_memory·supersede_memory·retract_memory
 * 가 아예 없으므로(access.ts ScopedMcpServer), 있지도 않은 도구를 쓰라고 권하지
 * 않는다 — 정직성 계약(파일 상단 주석).
 */
const READ_ONLY_NOTICE = `This connection is read-only: no memory can be written, corrected, superseded or retracted from here. Report what recall finds; do not ask the user to dictate a save through this client.`;

/** 모든 scope 가 공유하는 뒷부분 — get_profile·FORBIDDEN 안내. */
const SHARED_SUFFIX = `HOW THIS USER WORKS
Use get_profile for working preferences, including directives and anti_preferences. Default is global; specify project scope for project exceptions. FORBIDDEN means this client's token lacks permission, not a reason to bypass it through REST.`;

/** 쓰기 가능 scope 의 기존 문안 — server.test.ts 가 이 상수를 그대로 참조한다(하위 호환). */
export const MCP_INSTRUCTIONS = [SHARED_PREFIX, WRITE_CAPABLE_SECTIONS, SHARED_SUFFIX].join("\n\n");

/**
 * scope 별 instructions 조립 (WP-B1-16 / SA-5). read-only 는 WRITING·CORRECTING 을
 * READ_ONLY_NOTICE 로 바꾼다. 그 외(undefined·mcp-standard·full)는 기존 MCP_INSTRUCTIONS
 * 와 정확히 같은 문자열을 돌려준다 — 쓰기 가능 scope 사이에 문안 차이를 두지 않는다.
 */
export function buildMcpInstructions(scope: TokenScope | undefined): string {
  if (scope === "read-only") {
    return [SHARED_PREFIX, READ_ONLY_NOTICE, SHARED_SUFFIX].join("\n\n");
  }
  return MCP_INSTRUCTIONS;
}
