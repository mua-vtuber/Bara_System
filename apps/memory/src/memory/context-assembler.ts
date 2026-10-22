/**
 * ContextAssembler — converts retrieved memories into LLM prompt context.
 *
 * Takes a sorted list of `RetrievalResult` from HybridRetriever and emits
 * a memory block string that fits within a caller-supplied token budget.
 *
 * Scope (Phase 1):
 *   - Memory block formatting only. System prompt / user content are the
 *     caller's responsibility (API handler / extractor / bot adapter).
 *   - No entity profile block: entity_profiles table isn't in the v1
 *     schema yet. When that consumer arrives we can extend this assembler
 *     to take an `entity?: EntityProfile` and reintroduce the old
 *     multi-component budget redistribution logic.
 *
 * Format mirrors the old Python assembler so LLM prompt regressions are
 * minimal, plus a context marker (T11 — spec B) so the consuming LLM can
 * cite exactly which memory a claim came from:
 *   [관련 기억]
 *   - [#<id> <유형> <날짜>] {content} [중요]              ← importance >= 0.8
 *   - [#<id> <유형> <날짜>] {content} [미확인]            ← confidence < 0.6
 *   - [#<id> <유형> <날짜>] {content} [중요] [미확인]     ← both
 *   출처: #<id> #<id> ...
 *
 * The marker is always on — no legacy no-marker format (spec: 두 형식 병존
 * 금지). <유형> prefers the capture 분류 태그 (결정/아이디어/질문/선호, see
 * CAPTURE_TAG_SET below) over memoryType because the tag is more specific
 * when the node carries one. <날짜> is the date part of eventAt if present,
 * else createdAt (COALESCE semantics, matching the search-side date filter).
 *
 * Port of backend/app/services/memory/context_assembler.py limited to the
 * memory formatting branch.
 *
 * Injection fence (T12 — spec I): the whole assembled block (header +
 * lines + Source List) is wrapped in `<memory-context>`...`</memory-context>`
 * with a notice line telling the consuming LLM this is recalled memory, not
 * new instructions. The fence is applied here, at assembly/reply time only —
 * it is never persisted. Every included memory's content also passes through
 * the shared `sanitizeFenceBreakout` (context-fence.ts) right before
 * formatting, defending pre-existing rows that were stored before this guard
 * existed (a store-path guard alone can't cover that case). The fence
 * overhead (2 tags + notice) is counted in the token budget by re-measuring
 * the fenced prospective block on every candidate, same recompute-the-whole-
 * string approach as the Source List accounting below.
 */

import { estimateTokens } from "./token-counter.ts";
import { sanitizeFenceBreakout, wrapInFence } from "./context-fence.ts";
import type { RetrievalResult, RetrievalSource } from "./retriever.ts";
import { isCurrentMemory, matchesMemoryScope, readSharedMemory, type ResolvedMemoryScope } from "./shared-memory-contract.ts";

export type ContextMemory = Pick<RetrievalResult, "node" | "sources"> & {
  /**
   * WP-B1-10(SL-3 표시) — 아직 해소되지 않은 충돌 상대 기억의 id 목록(memory/open-conflicts.ts
   * listOpenConflicts). 호출자가 채워 넘기지 않으면(recall_context 미배선 경로 등) undefined로
   * 취급해 태그를 붙이지 않는다 — 정직한 생략이지 거짓 "충돌 없음"이 아니다.
   */
  conflicts?: readonly number[];
  /**
   * WP-B1-10R — 이 기억이 원문(auto_capture 등)일 때, 그 원문에서 추출된 자식의 열린 충돌·
   * 대체된 주장 표시(memory/open-conflicts.ts listOriginMarks). 호출자가 채워 넘기지 않으면
   * undefined로 취급해 태그를 붙이지 않는다(정직한 생략).
   */
  originMarks?: { openConflicts: readonly number[]; supersededClaims: readonly { childId: number; replacementId: number }[] };
};

/** Importance threshold above which a memory gets the [중요] marker. */
export const IMPORTANCE_HIGH = 0.8;

/** Confidence threshold below which a memory gets the [미확인] marker. */
export const CONFIDENCE_LOW = 0.6;

/**
 * WP-B1-10(SL-3 표시) — 아직 해소되지 않은 충돌 상대가 있을 때 붙는 태그. 기존
 * "[근거 미확인]"과 같은 방식의 상수(문구 고정, 단일 출처). 상대 본문은 싣지 않고 id만
 * 적는다 — disputed 기억이 기본 결과에 오르지 않는다는 계약은 그대로다.
 */
export function conflictTag(conflicts: readonly number[]): string {
  return conflicts.map((id) => `[충돌 후보 #${id} — 사용자 확인 필요]`).join(" ");
}

/**
 * WP-B1-10R(사용자 결정 2026-09-29, 1안) — 원문에서 추출된 자식이 supersede돼 대체됐을 때
 * 붙는 태그. "#child → #replacement" 형식으로 어느 자식이 어떤 기억으로 대체됐는지 밝힌다.
 * 대체 기억 본문은 싣지 않는다(id만 — conflictTag와 같은 방식).
 */
export function supersededClaimTag(claims: readonly { childId: number; replacementId: number }[]): string {
  return claims.map((c) => `[대체된 주장 #${c.childId} → #${c.replacementId}]`).join(" ");
}

/**
 * WP-B1-10R — 원문의 자식 계보 표시(originMarks)를 태그 문자열들로 만든다. 열린 충돌은
 * conflictTag 와 같은 문구를 재사용하고(상대가 자식이든 원문 자신이든 사용자에게는 같은
 * "충돌 후보" 개념), 대체된 주장은 supersededClaimTag 가 만든다. 둘 다 없으면 빈 배열.
 */
export function originMarkTags(
  marks: { openConflicts: readonly number[]; supersededClaims: readonly { childId: number; replacementId: number }[] } | undefined,
): string[] {
  if (!marks) return [];
  const tags: string[] = [];
  if (marks.openConflicts.length > 0) tags.push(conflictTag(marks.openConflicts));
  if (marks.supersededClaims.length > 0) tags.push(supersededClaimTag(marks.supersededClaims));
  return tags;
}

/** Header that opens the memory block. Stable so LLM prompt-engineers can match against it. */
export const MEMORY_BLOCK_HEADER = "[관련 기억]";

/**
 * Label that opens the Source List trailer line, e.g. "출처: #482 #517".
 * Stable so LLM prompt-engineers can match against it (mirrors
 * MEMORY_BLOCK_HEADER's exported-constant contract).
 */
export const SOURCE_LIST_LABEL = "출처:";

/**
 * The 4 capture 분류 태그 strings written to node.metadata.tags by the
 * save_decision/save_idea/save_question/save_preference MCP tools
 * (CAPTURE_TOOLS in mcp/tools-capture.ts). Duplicated here as a plain
 * string constant rather than imported — mcp/tools-capture.ts pulls in
 * the MCP SDK and server-internal save path, and context-assembler.ts
 * (memory layer) must not reach up into the mcp layer (역import 금지).
 * These 4 values are fixed capture-tool vocabulary, not user-editable
 * hashtags, so duplication risk is low. Exported so mcp/server.test.ts can
 * assert this set stays equal to CAPTURE_TOOLS' tags — the duplication is
 * deliberate, drifting apart is not.
 */
export const CAPTURE_TAG_SET = new Set(["결정", "아이디어", "질문", "선호"]);

/**
 * Resolve the <유형> marker segment: prefer the capture 분류 태그 when the
 * node's metadata.tags carries one of the 4 known capture tags (more
 * specific), otherwise fall back to memoryType.
 */
function resolveMarkerType(node: RetrievalResult["node"]): string {
  const tags = node.metadata?.tags;
  if (Array.isArray(tags)) {
    const hit = tags.find((t): t is string => typeof t === "string" && CAPTURE_TAG_SET.has(t));
    if (hit) return hit;
  }
  return node.memoryType;
}

/** Resolve the <날짜> marker segment: date part of eventAt, else createdAt. */
function resolveMarkerDate(node: RetrievalResult["node"]): string {
  const raw = node.eventAt ?? node.createdAt;
  return raw.slice(0, 10);
}

/** Build the "[#<id> <유형> <날짜>]" context marker prefix for a memory line. */
function formatContextMarker(node: RetrievalResult["node"]): string {
  return `[#${node.id} ${resolveMarkerType(node)} ${resolveMarkerDate(node)}]`;
}

export interface AssembleOptions {
  /** Return the actual selected IDs; consumers must not infer them from untrusted text. */
  includeIds?: boolean;
  scope?: ResolvedMemoryScope;
  includeInactive?: boolean;
  /**
   * Maximum tokens the memory block may consume, *including* the header.
   * Callers that orchestrate a larger prompt should subtract their own
   * components (system, user, reserve) from the total context window first.
   */
  memoryBudget: number;
  /**
   * If true, each memory line is prefixed with its retrieval sources, e.g.
   *   - [vec+fts] {content}
   * Off by default — meant for debugging, not production prompts.
   */
  showSources?: boolean;
}

export interface AssembledContext {
  includedIds?: number[];
  /** Memory block text. Empty string when there's nothing to include. */
  memoryBlock: string;
  /** Total estimated tokens (header + included lines). */
  tokensUsed: number;
  /** How many memories made it into the output. */
  memoriesIncluded: number;
  /** How many were dropped because of the budget. */
  memoriesTrimmed: number;
}

/** Source order used when rendering sources as a compact tag. */
const SOURCE_ORDER: RetrievalSource[] = ["vector", "fts", "graph"];

/** Compact source tag, e.g. "vec+fts". `vector` shortens to `vec`. */
function formatSources(sources: readonly RetrievalSource[]): string {
  const set = new Set(sources);
  const parts: string[] = [];
  for (const s of SOURCE_ORDER) {
    if (!set.has(s)) continue;
    parts.push(s === "vector" ? "vec" : s);
  }
  return parts.join("+");
}

/**
 * Pure: format a single retrieval result into a memory line (no header,
 * no trailing newline). Exported for tests and for callers that want to
 * embed memories into a different surrounding structure.
 *
 * Marker order: the "[#id 유형 날짜]" context marker always comes first,
 * then (when showSources is on) the "[vec+fts]" source tag, then content,
 * then the [중요]/[미확인] tags. The context marker is the load-bearing
 * identifier an LLM cites back — source tags are debug-only metadata, so
 * they compose after the marker rather than before it.
 */
export function formatMemoryLine(
  result: ContextMemory,
  options: { showSources?: boolean } = {},
): string {
  const { node, sources, conflicts, originMarks } = result;
  const tags: string[] = [];
  if (node.importance >= IMPORTANCE_HIGH) tags.push("[중요]");
  if (node.confidence < CONFIDENCE_LOW) tags.push("[미확인]");
  const shared = readSharedMemory(node.metadata);
  if (shared.assertionKind === "ai_inference") tags.push("[AI 추론]");
  if (shared.assertionKind === "unknown" && node.metadata.sharedMemory !== undefined) tags.push("[근거 미확인]");
  if (shared.status !== "active") tags.push(`[${shared.status}]`);
  if (conflicts && conflicts.length > 0) tags.push(conflictTag(conflicts));
  tags.push(...originMarkTags(originMarks));

  const marker = formatContextMarker(node);
  const sourceTag =
    options.showSources && sources.length > 0 ? ` [${formatSources(sources)}]` : "";
  // sanitizeFenceBreakout defends pre-existing rows stored before the T12
  // fence guard existed (store-path sanitize covers new saves; this covers
  // legacy data). Zero-match pass for the overwhelming majority of content
  // that never contained a literal fence tag.
  // 줄바꿈 뒤 줄은 들여 쓴다(indentContinuationLines) — 본문 안 줄바꿈이 줄 맨 앞에서 시작하는
  // 가짜 "- [#id …]" 기억 줄이나 "출처:" 줄을 만들지 못하게 한다. 여러 줄 메모는 읽기 그대로 남는다.
  const safeContent = indentContinuationLines(sanitizeFenceBreakout(node.content));
  const prefix = `- ${marker}${sourceTag} ${safeContent}`;

  return tags.length === 0 ? prefix : `${prefix} ${tags.join(" ")}`;
}

/** 기억 본문의 둘째 줄부터 붙이는 들여쓰기 — 기억 줄("- [#")·출처 줄은 줄 맨 앞에서만 시작한다. */
export const MEMORY_CONTINUATION_INDENT = "  ";

/** 줄바꿈(\r\n·\r·\n·U+2028·U+2029)을 "\n + 들여쓰기"로 바꾼다. 본문은 데이터일 뿐 새 줄 구조를 못 만든다. */
const LINE_BREAK_PATTERN = /\r\n|[\r\n\u2028\u2029]/g;

function indentContinuationLines(content: string): string {
  return content.replace(LINE_BREAK_PATTERN, `\n${MEMORY_CONTINUATION_INDENT}`);
}

/** Format the Source List trailer line, e.g. "출처: #482 #517 #603". */
function formatSourceList(ids: readonly number[]): string {
  return `${SOURCE_LIST_LABEL} ${ids.map((id) => `#${id}`).join(" ")}`;
}

export class ContextAssembler {
  /**
   * Assemble the memory block from sorted retrieval results.
   *
   * Iterates in order (caller is expected to pre-sort by score, which is
   * what HybridRetriever already does), skipping oversized items so later
   * useful evidence can still fit. Excluded items count as trimmed.
   */
  assemble(
    memories: readonly ContextMemory[],
    options: AssembleOptions,
  ): AssembledContext {
    const budget = Math.max(0, options.memoryBudget);

    if (budget === 0 || memories.length === 0) {
      return {
        memoryBlock: "",
        tokensUsed: 0,
        memoriesIncluded: 0,
        memoriesTrimmed: memories.length,
        ...(options.includeIds ? { includedIds: [] } : {}),
      };
    }

    // Fence overhead (2 tags + notice, see context-fence.ts) is fixed
    // regardless of how many memories end up inside, so it's measured once
    // up front and re-checked against the header the same way the old
    // header-alone check worked — except now the *fenced* header-only block
    // is what has to fit, not the bare header.
    const headerOnlyFenced = estimateTokens(wrapInFence(MEMORY_BLOCK_HEADER));
    if (headerOnlyFenced > budget) {
      // Budget can't even hold the fenced header — skip the whole block to
      // avoid emitting a header (or fence) with zero items below it.
      return {
        memoryBlock: "",
        tokensUsed: 0,
        memoriesIncluded: 0,
        memoriesTrimmed: memories.length,
        ...(options.includeIds ? { includedIds: [] } : {}),
      };
    }

    // Budget accounting includes the Source List trailer line (grows by one
    // "#id" token group per included memory) AND the fence wrapper (fixed
    // overhead, but the emitted block must still never exceed budget once
    // wrapped). The simplest correct approach: re-measure the *whole
    // prospective fenced block* (fence + header + lines so far + candidate
    // line + Source List reflecting the candidate's inclusion) on every
    // candidate, rather than trying to incrementally approximate the
    // Source List's growth or the fence's fixed cost separately.
    // estimateTokens is a pure, cheap string-length-based function and
    // candidate counts here are retrieval-limit sized, so re-measuring is
    // not a hot-path concern — and it can't drift out of sync with
    // formatSourceList's / wrapInFence's actual output.
    const lines: string[] = [MEMORY_BLOCK_HEADER];
    const includedIds: number[] = [];
    let used = headerOnlyFenced;
    let included = 0;

    for (const memory of memories) {
      if (!matchesMemoryScope(memory.node.projectId, options.scope)) continue;
      if (!options.includeInactive && !isCurrentMemory(memory.node.metadata)) continue;
      const line = formatMemoryLine(memory, {
        showSources: options.showSources ?? false,
      });
      const prospectiveIds = [...includedIds, memory.node.id];
      const prospectiveBlock = [...lines, line, formatSourceList(prospectiveIds)].join("\n");
      const prospectiveTokens = estimateTokens(wrapInFence(prospectiveBlock));

      if (prospectiveTokens > budget) {
        continue;
      }

      lines.push(line);
      includedIds.push(memory.node.id);
      used = prospectiveTokens;
      included += 1;
    }

    if (included === 0) {
      // Header alone is not useful.
      return {
        memoryBlock: "",
        tokensUsed: 0,
        memoriesIncluded: 0,
        memoriesTrimmed: memories.length,
        ...(options.includeIds ? { includedIds: [] } : {}),
      };
    }

    lines.push(formatSourceList(includedIds));

    return {
      memoryBlock: wrapInFence(lines.join("\n")),
      tokensUsed: used,
      memoriesIncluded: included,
      memoriesTrimmed: memories.length - included,
      ...(options.includeIds ? { includedIds } : {}),
    };
  }
}
