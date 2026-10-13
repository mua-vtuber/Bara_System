/**
 * merge-synonym-dict.ts — yaml 동의어 사전 + 사용자 추가 행 병합 (웨이브3 항목12 B2).
 *
 * yaml 사전(loadSynonymDictionary 산출 `Map<string,string[]>`)에 대시보드에서 손으로
 * 추가한 동의어 행(synonym_user_entries → SynonymUserRepo.listEntries)을 합쳐, 검색
 * (HybridRetriever)이 한 사전으로 query 확장에 쓸 *새 Map* 을 만든다.
 *
 * 순수 함수 — 입력 yaml Map 을 *건드리지 않는다*. 키 배열까지 복제한 새 Map 을
 * 돌려준다(원본 불변). 같은 (term, synonym) 쌍이 yaml 과 user 양쪽에 있으면 한 번만
 * 들어간다(중복 제거). user 행의 lang 은 합류 키에 쓰지 않는다 — yaml 사전이 term →
 * synonym 목록 한 축이라, 검색 확장도 term 한 축으로만 합류한다(D9 / spec 13.3).
 */
import type { SynonymDictionary } from "../synonym-dictionary.ts";

/** mergeSynonymDict 가 받는 user 행의 최소 형태(SynonymUserEntryView 부분집합). */
export interface SynonymUserEntryLike {
  term: string;
  synonym: string;
  lang: string;
}

/**
 * yaml 사전 + user 행을 합친 새 사전을 만든다.
 *
 * - 원본 `yamlDict` 는 불변 — 키 배열까지 복제한 새 Map 을 돌려준다.
 * - user 행마다 `term` 키 배열에 `synonym` 을 push 하되, 이미 있으면 skip(중복 제거).
 * - 새 term(yaml 에 없던) 이면 새 키를 만든다.
 */
export function mergeSynonymDict(
  yamlDict: SynonymDictionary,
  userEntries: readonly SynonymUserEntryLike[],
): SynonymDictionary {
  // 키 배열까지 복제 — 새 Map 에 push 해도 yaml 원본 배열은 안 바뀐다.
  const merged: SynonymDictionary = new Map();
  for (const [term, syns] of yamlDict) {
    merged.set(term, [...syns]);
  }

  for (const entry of userEntries) {
    const existing = merged.get(entry.term);
    if (existing) {
      if (!existing.includes(entry.synonym)) existing.push(entry.synonym);
    } else {
      merged.set(entry.term, [entry.synonym]);
    }
  }

  return merged;
}
