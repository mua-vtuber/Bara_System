/**
 * 새 자산 글 저장 시 기존 개념(concept_nodes)과 자동 mention 엣지 부착.
 *
 * 1.0b — 본문에 등장하는 개념을 findMentionedConcepts 로 찾아
 * node_concept_edges role='mention' 추가. 해시태그(메타 입력)는 parseTags 로
 * 떼어낸 cleanContent 만 스캔한다(autoLinkMentions JSDoc 참고). 모든 자산 글
 * 저장 진입점에서 호출:
 *
 * - extractor.ts: 자식 노드 인서트 직후
 * - server-internal/routes/memories.ts POST /memories
 * - POST /memories/from-text preserveRaw
 *
 * 빈 본문은 no-op. 반환: 새로 추가된 mention 엣지 수(중복은 카운트 X).
 * 에러는 throw — 호출처에서 보호하고 싶으면 try/catch.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import { parseTags } from "./tag-extractor.ts";

export interface AutoMentionTarget {
  id: number;
  content: string;
}

/**
 * mention 은 글 *본문* 이 우연히 언급한 개념이라, 해시태그(메타 입력)를 제거한
 * cleanContent 만 스캔한다. 해시태그로 적은 값(친구·직업·라벨 값 등)은 이미
 * tag·classification·has_attribute role 로 연결되므로 mention 으로 또 잡을
 * 필요가 없고, 그렇게 잡으면 그래프에 군더더기 노드가 매달린다.
 *
 * 멱등: extractor.ts 의 bodyContent 는 이미 cleanContent 라 parseTags 를 다시
 * 돌려도 태그가 없어 cleanContent 가 그대로 — 무해하다. atomic 자식 글도 보통
 * 해시태그가 없어 무해.
 */
export async function autoLinkMentions(
  store: SqliteMemoryStore,
  memory: AutoMentionTarget,
): Promise<number> {
  if (!memory.content || memory.content.trim() === "") return 0;

  // 해시태그를 떼어낸 본문만 mention 스캔 대상으로 삼는다.
  const { cleanContent } = parseTags(memory.content);
  if (cleanContent.trim() === "") return 0;

  const concepts = await store.findMentionedConcepts(cleanContent);
  if (concepts.length === 0) return 0;

  let linked = 0;
  for (const concept of concepts) {
    const wasNew = await store.addNodeConceptEdge(
      memory.id,
      concept.conceptId,
      "mention",
      "system",
      memory.id,
    );
    if (wasNew) linked++;
  }
  return linked;
}
