/**
 * person-link-prefilter.ts — 결정적 top-K 사전 필터 (spec 4.A-7).
 *
 * person_link 단계가 LLM 을 부르기 전에, 노드별로 "이 노드에 연결될 법한 기존 사람"을
 * 이름/별칭/라벨 문자열 매칭으로 소수(top-K)로 좁힌다. 강모델 프롬프트에 200명 전 명단을
 * 통째로 싣는 대신 노드별 소수 후보만 실어 입력 비용과 오연결 위험을 함께 줄인다.
 *
 * 결정성 요구:
 *   - 순수 함수 — DB·난수·시간 의존 0. 같은 입력이면 같은 결과·같은 순서.
 *   - 후보가 K 를 넘으면 personId 오름차순 상위 K 만 남긴다(안정적 tiebreak).
 *   - 매칭 규칙: 사람의 match-token(displayName + aliases + labels)이 노드의
 *     personCandidates 문자열 중 하나 또는 노드 content 의 부분 문자열이면 후보.
 *
 * 이 결과 top-K personId 목록은 fingerprint(stage-fingerprint.ts personLinkFingerprint 의
 * topKPersonIds)에도 실려, 사전 필터가 좁힌 대상이 바뀌면 지문이 달라져 자연 재평가된다.
 */

/** 사전 필터가 보는 사람 최소 형태 — 이름/별칭/라벨만. */
export interface PrefilterPerson {
  personId: string;
  displayName: string;
  aliases: string[];
  /** 속성 라벨 이름 목록(예: 직업·역할). 매칭 토큰에 함께 넣는다. */
  labels: string[];
}

/** 사전 필터가 보는 노드 최소 형태 — 본문 + 추출된 사람 후보 문자열. */
export interface PrefilterNode {
  id: number;
  content: string;
  personCandidates: string[];
}

/** 사람의 매칭 토큰 집합 — 이름·별칭·라벨을 trim 해 빈 토큰 제외. */
function matchTokens(person: PrefilterPerson): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [person.displayName, ...person.aliases, ...person.labels]) {
    if (typeof raw !== "string") continue;
    const token = raw.trim();
    if (token.length === 0 || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** 사람의 토큰 중 하나라도 노드 후보 문자열 또는 본문에 부분 매칭하면 true. */
function personMatchesNode(tokens: readonly string[], node: PrefilterNode): boolean {
  for (const token of tokens) {
    if (node.content.includes(token)) return true;
    for (const candidate of node.personCandidates) {
      if (typeof candidate !== "string") continue;
      if (candidate.includes(token) || token.includes(candidate.trim())) return true;
    }
  }
  return false;
}

/**
 * 노드별로 매칭되는 사람 personId 를 top-K 로 좁혀 회신한다.
 *
 * @param topK 노드당 후보 상한. 초과분은 personId 오름차순 상위 K 만 남긴다.
 * @returns nodeId → 후보 personId 목록(personId 오름차순, 최대 topK). 매칭 0 이면 빈 배열.
 */
export function prefilterPersonCandidates(
  nodes: readonly PrefilterNode[],
  people: readonly PrefilterPerson[],
  topK: number,
): Map<number, string[]> {
  const tokensByPerson = people.map((p) => ({
    personId: p.personId,
    tokens: matchTokens(p),
  }));

  const result = new Map<number, string[]>();
  for (const node of nodes) {
    const matched: string[] = [];
    for (const { personId, tokens } of tokensByPerson) {
      if (personMatchesNode(tokens, node)) matched.push(personId);
    }
    matched.sort();
    result.set(node.id, topK >= 0 ? matched.slice(0, topK) : matched);
  }
  return result;
}
