/**
 * person-link-resolve.ts — 한 메모(노드)에 대한 사람 연결 결정들을 "사람마다 연결 하나" 로
 * 정리하고, 각 연결이 애매한지(자동 연결 금지 + 검토 제안 표시) 정한다.
 *
 * 한 메모에 서로 다른 사람이 여럿 나오는 것은 정상이다("민수와 지영을 만났다" → 두 사람 각각
 * 연결). 애매함은 다음 두 경우에만 붙는다:
 *   1. 같은 언급(candidateText)에 서로 다른 사람이 둘 이상 붙었다 — 한 이름이 누구인지 갈린다.
 *      candidateText 가 비어 있는 결정끼리는 같은 언급으로 본다(어느 언급인지 모르면 갈린 것으로
 *      보는 보수 판정).
 *   2. 모델이 그 연결에 uncertain=true 를 달았다.
 * 같은 사람에 대한 결정이 여러 개면 하나로 합친다: 애매하지 않은 결정이 하나라도 있으면 그것들
 * 중 가장 높은 확신을, 전부 애매하면 애매 결정 중 가장 높은 확신을 쓴다.
 *
 * 순수 함수 — DB·실행층 의존 없음(사이클이 결과로 자동 연결/제안을 쓴다).
 */

import type { PersonLinkDecision } from "./person-link-infer-cycle.ts";

export interface ResolvedPersonLink {
  /** 사람 하나로 합쳐진 결정. 사람 구분은 trim 한 personId 로 하지만 decision.personId 는 trim 하지 않은 원래 값 그대로다. */
  decision: PersonLinkDecision;
  /** true = 같은 언급이 여러 사람으로 갈렸거나 모델이 불확실 표시 — 자동 연결 금지. */
  ambiguous: boolean;
}

/**
 * 한 노드의 검증 통과 결정들 → 사람마다 연결 하나(첫 등장 순서 유지).
 * 모든 결정은 personId 가 비어 있지 않은 문자열이어야 한다(호출부가 검증 후 넘긴다).
 */
export function resolveNodePersonLinks(
  decisions: readonly PersonLinkDecision[],
): ResolvedPersonLink[] {
  const personsByMention = new Map<string, Set<string>>();
  for (const d of decisions) {
    const key = mentionKey(d);
    const persons = personsByMention.get(key) ?? new Set<string>();
    persons.add(personIdOf(d));
    personsByMention.set(key, persons);
  }

  const order: string[] = [];
  const clearBest = new Map<string, PersonLinkDecision>();
  const ambiguousBest = new Map<string, PersonLinkDecision>();
  for (const d of decisions) {
    const personId = personIdOf(d);
    if (!clearBest.has(personId) && !ambiguousBest.has(personId)) order.push(personId);
    const ambiguous =
      d.uncertain === true || personsByMention.get(mentionKey(d))!.size > 1;
    const target = ambiguous ? ambiguousBest : clearBest;
    const prev = target.get(personId);
    if (prev === undefined || d.confidence > prev.confidence) target.set(personId, d);
  }

  return order.map((personId) => {
    const clear = clearBest.get(personId);
    if (clear !== undefined) return { decision: clear, ambiguous: false };
    return { decision: ambiguousBest.get(personId)!, ambiguous: true };
  });
}

/** 언급 비교 키 — 앞뒤 공백·유니코드 정규형 차이로 같은 언급이 갈리지 않게 한다. */
function mentionKey(d: PersonLinkDecision): string {
  return (d.candidateText ?? "").trim().normalize("NFC");
}

function personIdOf(d: PersonLinkDecision): string {
  if (typeof d.personId !== "string" || d.personId.trim() === "") {
    throw new Error(
      `resolveNodePersonLinks: 검증 안 된 결정이 들어옴(nodeId=${d.nodeId}, personId 비어 있음)`,
    );
  }
  return d.personId.trim();
}
