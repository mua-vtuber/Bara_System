/**
 * mcp/descriptions.ts — MCP 도구 description 문안 단일 출처 (spec 단락 5 서두).
 * 소비자가 클라이언트 LLM 이라 영어로 작성한다. 도구 등록부(tools-*.ts)는 반드시
 * 이 맵을 참조한다 — 등록부 안 문자열 직접 기재 금지.
 *
 * 문안 양식(T9 spec A) — 각 문안은 산문으로 다음을 말한다:
 *   1) DEFICIT   호출자에게 없는 것 (세션 간 기억 부재 등)
 *   2) TRIGGER   언제 부르는가 (작업 시작 전 / 결정 직후 등)
 *   3) CONSEQUENCE 부르지 않으면(또는 부르면) 무슨 일이 생기는가
 *   4) ROUTING   혼동이 실재하는 곳에만 — 어느 도구로 가야 하는지 반대 안내
 *   5) 기존 사실 계약(선택 칸 규칙·echo verbatim 규칙 등)은 산문에 합류시켜 보존
 * 길이 예산 = 각 90 단어 미만. 문안 토큰은 세션 초기화마다 지불되므로 군더더기 금지.
 *
 * 문안의 계약 문구는 server.test.ts 가 부분 문자열로 고정(pinning)한다 — 다듬을 때
 * 고정 문구를 지우면 테스트가 먼저 실패한다(전체 일치 비교 아님, 표현 여지는 남긴다).
 */
export const TOOL_DESCRIPTIONS = {
  update_memory:
    "Correct an existing text memory when the user changes its wording. Read it first: expectedRevision must match sharedMemory.revision. Supply a unique requestId (retry and conflict rules: see CORRECTING in the server instructions). Existing hashtags are preserved; pass body text without hashtags. CONFLICT returns the current revision. Derived memories are invalidated. Use supersede_memory for a changed fact and retract_memory to withdraw it.",
  supersede_memory:
    "Record an explicit change of fact, not mere similarity. Save the replacement first, then provide its replacementId and the old memory id, expectedRevision and requestId. Both must be in the same project. The old memory becomes superseded and is excluded from ordinary recall; its history remains available. A disputed replacement is accepted only as a conflict candidate of the old memory; after the user confirms it, this one call makes it active. Check the response's openConflicts for others still unresolved. Use update_memory for wording corrections.",
  retract_memory:
    "Withdraw a memory the user says is wrong or should no longer be used. Provide id, expectedRevision and a unique requestId. Retraction excludes the memory and invalidates dependent derived memories without permanently deleting history or backups. Do not retract merely because a search missed it.",
  recall_context:
    "At session start or before work on a project, retrieve current preferences plus relevant memories within an estimated token budget. Default scope is global; a project scope includes global preferences unless includeGlobal is false. query is optional. The returned context identifies sources and inference status. Missing information is not evidence; report uncertainty. Use get_memory to inspect individual sources, including their history state.",
  search_memory:
    "You have no memory of previous sessions with this user. Search before " +
    "starting substantive work, or " +
    "whenever a request resembles something already settled. Skip it and you will " +
    "contradict decisions the user already made. When not to search: see DO NOT " +
    "SEARCH in the server instructions. Only `query` is required. A filter that " +
    "cannot be applied is dropped without error: check `appliedFilters` in the " +
    "response.",
  get_memory:
    "Search results and context blocks cite memories by id but carry only an " +
    "excerpt, so the full stored content and its metadata are not in front of you. " +
    "Call this when a cited memory looks decisive and you need its exact wording " +
    "before acting or quoting it. Guessing at the omitted remainder is how you " +
    "misreport what the user actually recorded. Fails with not-found if the id " +
    "does not exist.",
  list_recent:
    "You cannot see what this user has been working on lately; each session starts " +
    "blank. Call this to orient yourself when the user opens with an unanchored " +
    "reference — \"the thing from yesterday\", \"that plan we made\" — and no search " +
    "query is obvious yet. Without it you will ask the user to re-explain context " +
    "they reasonably expect you to hold. Returns the most recently stored memories " +
    "(default 10, max 100).",
  store_memory:
    "Anything learned in this conversation is lost when it ends unless written " +
    "down here. Call this for durable general knowledge — facts, project context " +
    "worth recalling months later — the moment it becomes clear. Do NOT " +
    "use it for user preferences: call save_preference; for decisions, ideas, or " +
    "open questions the typed save_* tools route those. Exact repeats are " +
    "absorbed; a near-duplicate is refused with code DUPLICATE plus that " +
    "memory's id and excerpt (handling: see WRITING in the server instructions).",
  save_decision:
    "Decisions the user makes in conversation vanish with the session, and their " +
    "rationale vanishes first. Call this the moment a decision is settled, while " +
    "the reasoning is still in context, so a future session honors it instead of " +
    "relitigating it. A decision is a choice in force; an idea is a " +
    "possibility not chosen (save_idea); an open question is save_question; a " +
    "standing rule is save_preference. A near-duplicate is refused with code " +
    "DUPLICATE (see WRITING in the server instructions). If it is " +
    "ambiguous, ask the user first.",
  save_idea:
    "Ideas raised in passing are lost at session end and rarely resurface on their " +
    "own. Call this when the user floats a possibility worth revisiting — a " +
    "feature, an approach, a direction — though nothing is committed yet. Unlike " +
    "save_decision, this records something not chosen; unlike save_question, it " +
    "asserts rather than asks; unlike save_preference, it is about what to build. " +
    "A near-duplicate is refused with code DUPLICATE (see WRITING in the server " +
    "instructions). If it is ambiguous, ask the user first.",
  save_question:
    "Open questions raised mid-conversation are lost at session end. Call this " +
    "when something is asked but left unresolved and it should surface again for " +
    "review. Skip it and the question is silently dropped rather than answered " +
    "later, and nobody notices it went missing. It records " +
    "what is still unknown — save_decision records what was settled, save_idea a " +
    "proposal, save_preference a standing rule. A near-duplicate is refused with " +
    "code DUPLICATE (see WRITING in the server instructions). If it is " +
    "ambiguous, ask the user first.",
  save_preference:
    "You do not know how this user wants work done, and they should not have to " +
    "restate it every session. Call this the moment a standing preference is " +
    "stated — style, tone, tooling, things to avoid. Preferences persist across topics; save_decision settles one " +
    "matter, save_idea is an unchosen possibility, save_question is unresolved. " +
    "Miss it and you keep working in a way the user already asked you not to. " +
    "Call only for a clear preference. If it is ambiguous, ask the user first.",
  cleanup_list_candidates:
    "The memory store accumulates entries needing curation, and you cannot see " +
    "that backlog from the conversation. Call this to obtain work items for one " +
    "stage (regexStrengthen | personLink | lensDraft | entityRegister) before " +
    "proposing any cleanup — proposals invented without a candidate are rejected. " +
    "Each candidate carries targetKey, inputFingerprint and stageVersion; echo them " +
    "back verbatim, because altered values mark it stale. nodeIds narrows " +
    "personLink or entityRegister to those memos. For entityRegister and " +
    "regexStrengthen, answer each candidate exactly as shared.instruction says and " +
    "submit that object as the payload (kind entity_register or regex_pattern_add).",
  cleanup_submit_proposal:
    "Curation is lost unless it is filed against its candidate. " +
    "Call this with an improvement for a candidate obtained from " +
    "cleanup_list_candidates, echoing its targetKey, inputFingerprint and " +
    "stageVersion verbatim; the payload shape depends on candidate.stage. " +
    "The proposal enters the pending review queue; approval happens " +
    "only in the dashboard (entity_register is judged by the server; a failing " +
    "regex_pattern_add returns status rejected). If nothing is worth proposing, " +
    "call cleanup_report_no_finding instead.",
  cleanup_report_no_finding:
    "A candidate you examined and dismissed looks identical to one never examined, " +
    "so it is handed out again and again. Call this when a candidate was reviewed " +
    "and nothing should be proposed, echoing its targetKey, inputFingerprint and " +
    "stageVersion verbatim. Records completed_noop so the same candidate is not " +
    "served again. Use cleanup_submit_proposal instead whenever you do have a " +
    "concrete improvement.",
  cleanup_run_status:
    "A cleanup deep-pass run proceeds on the server where you cannot observe it. " +
    "Call this only when the user gives you a runId " +
    "to read that run's status and aggregates before reporting progress. Without it you " +
    "would be guessing at whether a run finished, stalled, or failed.",
  bara_doctor:
    "An empty search result looks identical whether nothing was stored on this " +
    "topic or the embedder, vector index, or FTS index is broken — you cannot " +
    "tell the difference from the response alone. Call this when a search " +
    "returns empty unexpectedly, or before concluding memories are missing. " +
    "Takes no arguments. Returns per-stage health plus exactly one " +
    "firstBlockingCause naming the first failing stage with a concrete fix, " +
    "or null if healthy. The embedder stage checks configuration coherence " +
    "only, not a live probe.",
  get_profile:
    "Preferences rarely resemble the wording of a later query, so " +
    "search_memory structurally misses them — you would keep working against " +
    "stale defaults without knowing a standing rule exists. Call this at " +
    "session start, or before a style, tone, tooling, or workflow choice the " +
    "user may already have settled. Optional facet narrows to one of " +
    "directives | anti_preferences | communication | workflow | stack; " +
    "omitted returns all. Unfaceted preferences are grouped under " +
    "unclassified, never guessed into a category. Zero preferences is a " +
    "normal empty state, not an error.",
} as const;

/**
 * cleanup_list_candidates 의 read-only 문안. read-only 토큰은 cleanup_submit_proposal 이
 * tools/list 에서 빠지므로(access.ts) 제출을 권하는 TOOL_DESCRIPTIONS 문안 대신 이것을 쓴다.
 * 등록부(tools-cleanup.ts)가 scope 로 고른다. TOOL_DESCRIPTIONS 키 집합(14종)에는 넣지 않는다.
 */
export const CLEANUP_LIST_CANDIDATES_READ_ONLY =
  "The memory store accumulates entries needing curation, and you cannot see " +
  "that backlog from the conversation. Call this to inspect work items for one " +
  "stage (regexStrengthen | personLink | lensDraft | entityRegister). This " +
  "connection is read-only, so you cannot submit proposals; report what you " +
  "find to the user. nodeIds narrows personLink or entityRegister to those memos.";
