/**
 * memory/project-vocab.ts — 다중 프로젝트 어휘 expansion(D8 / spec 12·5.4).
 *
 * 검색 query 의 어휘가 프로젝트별로 의미가 다를 때(둥지 cleanup vs bara cleanup)
 * project_vocabularies 테이블의 expanded_meaning 으로 query 를 확장한다. synonym
 * (BM25 한정)과 달리 project expansion 은 BM25 + 임베딩 둘 다 합류(spec 5.4).
 * 빈 결과 = 빈 Map(자연 degrade). 테이블 누락은 SQLite 구체 에러를 가리지 않음.
 */
import type { Database } from "bun:sqlite";

/** project_vocabularies 에서 (term → expanded_meaning) 매핑을 읽는다. */
export function loadProjectVocab(db: Database, projectId: string): Map<string, string> {
  const rows = db
    .prepare("SELECT term, expanded_meaning FROM project_vocabularies WHERE project_id = ?")
    .all(projectId) as Array<{ term: string; expanded_meaning: string }>;
  return new Map(rows.map((r) => [r.term, r.expanded_meaning]));
}

/** query 토큰 매치 시 expanded_meaning 을 더한다. 매치 0 이면 원본 그대로. */
export function expandQueryWithProjectVocab(query: string, vocab: Map<string, string>): string {
  if (vocab.size === 0) return query;
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);
  const extra: string[] = [];
  for (const t of tokens) {
    const meaning = vocab.get(t);
    if (meaning) extra.push(meaning);
  }
  return extra.length > 0 ? `${query} ${extra.join(" ")}` : query;
}
