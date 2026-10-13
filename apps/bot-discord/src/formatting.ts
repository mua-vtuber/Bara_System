/**
 * Plain-text formatting helpers for Discord replies.
 *
 * Phase 1 deliberately avoids Embeds — text replies are easier to debug,
 * not subject to the 10-embed-per-message ceiling, and cheap to upgrade
 * later if the user wants a prettier surface.
 */

import type {
  ExtractFromTextResult,
  ForgetResult,
  MemoryRow,
  SearchResult,
} from "../../memory/src/api-client.ts";

/** Discord max message length. We chunk longer outputs across multiple messages. */
export const DISCORD_MESSAGE_LIMIT = 2000;

function shortId(id: number): string {
  return `#${id}`;
}

function shortContent(text: string, maxChars = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  return oneLine.slice(0, maxChars - 1) + "…";
}

export function formatSearchResults(
  query: string,
  results: SearchResult[],
): string {
  if (results.length === 0) {
    return `🔍 "${query}" 결과 없음.`;
  }

  const header = `🔍 "${query}" 검색 — ${results.length}건`;
  const lines = results.map((r, i) => {
    const tags: string[] = [];
    if (r.importance >= 0.8) tags.push("[중요]");
    if (r.confidence < 0.6) tags.push("[미확인]");
    const tagStr = tags.length ? ` ${tags.join(" ")}` : "";
    const sources = r.sources.length ? ` (${r.sources.join("+")})` : "";
    return `[${i + 1}] ${shortId(r.id)} 점수 ${r.score.toFixed(2)}${sources}${tagStr}\n    ${shortContent(r.content)}`;
  });

  return [header, ...lines].join("\n");
}

export function formatRecent(memories: MemoryRow[]): string {
  if (memories.length === 0) {
    return "📭 저장된 메모리가 없습니다.";
  }
  const header = `📋 최근 ${memories.length}개`;
  const lines = memories.map((m) => {
    return `${shortId(m.id)} · ${m.createdAt} · ${shortContent(m.content, 150)}`;
  });
  return [header, ...lines].join("\n");
}

export function formatMemoryDetail(m: MemoryRow): string {
  const tags: string[] = [];
  if (m.importance >= 0.8) tags.push("중요");
  if (m.confidence < 0.6) tags.push("미확인");
  const tagStr = tags.length ? ` · ${tags.join(", ")}` : "";

  return [
    `📌 ${shortId(m.id)} ${tagStr}`,
    `타입: ${m.memoryType} · 중요도 ${m.importance.toFixed(2)} · 신뢰도 ${m.confidence.toFixed(2)}`,
    `생성: ${m.createdAt}`,
    `마지막 접근: ${m.lastAccessedAt}`,
    `반복 언급: ${m.mentionCount}회`,
    "",
    m.content,
  ].join("\n");
}

/**
 * /forget reply (WP-B1-20U design 17.3). The core deletes the chosen memory together with derived
 * memories that have no source of their own, so the reply names how many went with it. A count of
 * zero adds nothing; a missing memory keeps the old "not found" sentence.
 */
export function formatForgetReply(id: number, result: ForgetResult | null): string {
  if (result === null) return `메모리 #${id} 없음.`;
  const base = `🗑️ 메모리 ${shortId(result.deleted)} 삭제됨.`;
  const derived = result.derivedDeletedIds.length;
  return derived === 0 ? base : `${base} 이 메모리에서 나온 파생 메모리 ${derived}개도 함께 삭제됨.`;
}

export function formatStats(s: {
  totalMemories: number;
  memoriesLast7Days: number;
  totalEdges: number;
}): string {
  return [
    `📊 메모리 통계`,
    `총 메모리: ${s.totalMemories}개`,
    `최근 7일: ${s.memoriesLast7Days}개`,
    `연결(엣지): ${s.totalEdges}개`,
  ].join("\n");
}

/**
 * Render the LLM extraction result for the user. The shape is the same one
 * served by POST /memories/from-text — we lift each `item` to a single line
 * and prefix with the new node id when one exists.
 *
 * Format hints used elsewhere:
 *   ✨   — a new node was stored (this item became memory #N)
 *   🔁   — dedup detected; only a mention bump happened (no new id to show)
 *   ↳    — non-storage notes (filtered out, conflicts detected)
 */
export function formatExtractionResult(
  result: ExtractFromTextResult,
  options: { source: "manual" | "auto" } = { source: "manual" },
): string {
  const itemCount = result.items.length;
  const storedCount = result.stored.length;
  const bumpedCount = result.bumped.length;

  if (itemCount === 0 && bumpedCount === 0) {
    return options.source === "auto"
      ? "🤔 추출할 만한 새 메모리를 못 찾았음."
      : "🤔 LLM이 추출할 만한 메모리를 못 찾았음.";
  }

  const header = options.source === "auto"
    ? `🪄 자동 추출 — 새 ${storedCount}개${bumpedCount ? ` · 재언급 ${bumpedCount}개` : ""}`
    : `🧠 ${result.extractor.provider} → ${itemCount}개 추출 (저장 ${storedCount} · 재언급 ${bumpedCount})`;

  // 새로 저장된 항목들: items 배열의 앞에서부터 stored ids와 짝지어 표시.
  // (extractor는 stored/bumped를 같은 순회에서 분기하므로 items[i]에 정확히
  //  매칭되는 id를 추적하진 않지만 사용자에게는 "어떤 내용이 어떤 #id가
  //  됐는지" 대략 파악할 수 있도록 stored 갯수만큼 ✨ 마커를 앞쪽에 둔다.)
  const storedIds = [...result.stored];
  const itemLines: string[] = [];
  for (let i = 0; i < itemCount; i++) {
    const item = result.items[i]!;
    const id = storedIds.shift();
    const marker = id ? `✨ #${id}` : "🔁 (재언급)";
    const tags: string[] = [];
    if (item.importance >= 0.8) tags.push("[중요]");
    tags.push(`중요도 ${item.importance.toFixed(2)}`);
    tags.push(item.memoryType);
    itemLines.push(
      `${marker} ${shortContent(item.content, 180)}  · ${tags.join(" · ")}`,
    );
  }

  const notes: string[] = [];
  if (result.raw) {
    notes.push(`↳ 원문 보존: #${result.raw.id} (LLM 결과 망가져도 검색으로 회수 가능)`);
  }
  if (result.filteredOut > 0) {
    notes.push(`↳ importance 하한 미달로 버린 항목: ${result.filteredOut}개`);
  }
  if (result.conflicts > 0) {
    notes.push(`↳ 충돌(supersedes) 감지: ${result.conflicts}건`);
  }

  return [header, ...itemLines, ...notes].join("\n");
}

/**
 * Compact one-line summary used in MessageCreate reactions/replies. Just
 * the count, suitable for a quick at-a-glance signal in the memo channel.
 *
 * Includes raw preservation when present so the user understands why the
 * recent list has more nodes than the `+N` count — `+1` extracted + `원문 #N`
 * = 2 total rows.
 */
export function summarizeExtractionInline(
  result: ExtractFromTextResult,
): string {
  const stored = result.stored.length;
  const bumped = result.bumped.length;
  const parts: string[] = [];
  if (stored > 0) parts.push(`+${stored}`);
  if (bumped > 0) parts.push(`재언급 ${bumped}`);
  if (result.raw) parts.push(`원문 #${result.raw.id}`);

  if (parts.length === 0) {
    return "🤔 추출 0";
  }
  return `🧠 ${parts.join(" · ")}`;
}

/**
 * Split a long reply into Discord-sized chunks. Tries to break on
 * newlines so we don't slice mid-line; falls back to a hard char split
 * if a single line itself is too long.
 */
export function chunkForDiscord(text: string): string[] {
  if (text.length <= DISCORD_MESSAGE_LIMIT) return [text];
  const chunks: string[] = [];
  const lines = text.split("\n");
  let buf = "";
  for (const line of lines) {
    if (line.length > DISCORD_MESSAGE_LIMIT) {
      // Flush buffer then split this single line by character.
      if (buf) {
        chunks.push(buf);
        buf = "";
      }
      for (let i = 0; i < line.length; i += DISCORD_MESSAGE_LIMIT) {
        chunks.push(line.slice(i, i + DISCORD_MESSAGE_LIMIT));
      }
      continue;
    }
    if (buf.length + line.length + 1 > DISCORD_MESSAGE_LIMIT) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}
