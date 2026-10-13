/**
 * inherited-type-lookup.ts — 분류 키(개념 이름) → 등록 타입 역조회 헬퍼
 * (entity-classify-display-rootfix Task C1·P1).
 *
 * 목표는 한 개념 이름("고양이")이 *어느 타입 위계 아래 등록돼 있는지*를 hierarchy_edges 를
 * 거슬러 올라가 그 타입(creature 등)을 돌려주는 것이다. 이것은 P1(얼룩이) 사례의 판정
 * 두뇌다 — 사용자가 `#고양이:얼룩이` 만 적었을 때, "고양이"가 이미 까망이 글이 세운 creature
 * 위계의 잎이라면 얼룩이도 그 위계(creature) 아래로 이어받게 한다.
 *
 * 알고리즘:
 *  1. conceptName 의 conceptId 를 read-only 로 조회(store.findConceptByName). 없으면 type null·
 *     모호 아님 — 한 번도 등록 안 된 이름이라 상속 대상이 아니다(없는 개념을 만들지 않는다).
 *  2. 그 conceptId 에서 getHierarchyDirectParents 를 재귀로 거슬러 올라간다(방문 Set·깊이 상한).
 *     부모 사슬에서 만난 개념들의 이름이 *어떤 타입의 koNameOf 와 같은가*(= 타입 루트)를 모은다.
 *  3. 타입 루트가 정확히 1개 → 그 타입을 돌려준다. 2개+ (우연 동명이 두 타입 아래 매달림) →
 *     ambiguous(거짓 타입 0·Q1-1). 0개 → type null(타입 위계에 안 매달린 일반 개념).
 *
 * 시작 개념 자신은 타입 판정에서 제외한다 — conceptName 자체가 타입 루트("생물")이면
 * 부모 사슬에 타입 루트가 또 있지 않은 한 type null 이다(타입 루트는 상속받는 잎이 아니라
 * 지붕이다). 잎("고양이")이 부모 사슬을 거슬러 타입 루트("생물")에 닿으면 그 타입을 얻는다.
 *
 * koName(예 "생물") → PlacementTypeName(예 'creature') 역매핑은 placementTypeNames() 를
 * 순회하며 koNameOf(t) 와 비교해 만든다 — 타입 이름·한국어 이름을 이 파일에 직접 적지 않는다
 * (하드코딩 0·koNameOf 단일 출처).
 *
 * silent fallback 금지 — SQL/조회 실패는 전파한다. 빈 결과(미등록·타입 루트 없음)는 데이터의
 * 정직한 부재라 type null 로 돌려주되 모호와 구분한다(ambiguous=false·reason 없음).
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import {
  placementTypeNames,
  type PlacementTypeName,
} from "./concept-type-vocabulary.ts";
import { koNameOf } from "./entity-type-classifier.ts";

/**
 * 부모 사슬을 거슬러 올라가는 최대 걸음 수. classifier 의 COLON_CHAIN_MAX_DEPTH(6) 정신과
 * 맞춘 화면/처리 안전 상한이다 — 데이터 부재가 아니라 순환·과길이 차단이라 silent drop 이
 * 아니다. 상한에 닿으면 그 자리까지 모은 타입 루트로 판정한다(거기까지가 정직한 사실).
 */
const PARENT_CHAIN_MAX_DEPTH = 6;

export interface InheritedTypeResult {
  /** 거슬러 올라간 부모 사슬에서 찾은 등록 타입(타입 루트 1개일 때). 없으면 null. */
  type: PlacementTypeName | null;
  /** 부모 사슬에서 서로 다른 타입 루트 둘 이상에 닿으면 true(우연 동명·거짓 타입 0). */
  ambiguous: boolean;
  /** type null·ambiguous 일 때 사유(디버깅·경고용). 정상 단일 타입이면 미설정. */
  reason?: string;
}

/**
 * koName 문자열 → PlacementTypeName 역매핑(koNameOf 의 역). PLACEMENT_TYPE_NAMES 순회로
 * 만들어 타입 이름·한국어 이름 하드코딩을 피한다. 매번 적은 순회라 캐시 없이도 가볍다
 * (placementTypeNames() 는 정적 10종 ∪ DB 새 종류 — 보통 한 자리 수).
 *
 * @returns 그 이름이 어떤 타입의 koNameOf 면 그 타입, 아니면 null(타입 루트가 아닌 개념).
 */
function typeForKoName(name: string): PlacementTypeName | null {
  const key = (name ?? "").trim();
  if (!key) return null;
  for (const t of placementTypeNames()) {
    if (koNameOf(t) === key) return t;
  }
  return null;
}

/**
 * 개념 이름이 어느 타입 위계 아래 등록됐는지 hierarchy_edges 를 거슬러 찾는다(P1).
 *
 * @param store       실제 SqliteMemoryStore(실 DB).
 * @param conceptName 역조회할 개념 이름(예 "고양이"). 콜론 태그 값(엔티티 이름)이다.
 * @returns 단일 타입 루트에 닿으면 그 타입, 미등록·타입 루트 없으면 null, 두 타입 루트면 ambiguous.
 */
export async function resolveInheritedType(
  store: SqliteMemoryStore,
  conceptName: string,
): Promise<InheritedTypeResult> {
  const name = (conceptName ?? "").trim();
  if (!name) {
    return { type: null, ambiguous: false, reason: "빈 개념 이름 — 상속 대상 아님" };
  }

  // 1. read-only 조회 — 없는 개념을 만들지 않는다(findOrCreateConcept 금지).
  const start = await store.findConceptByName(name);
  if (!start) {
    return {
      type: null,
      ambiguous: false,
      reason: `미등록 개념 '${name}' — 타입 위계에 매달린 적 없음(상속 대상 아님)`,
    };
  }

  // 2. 부모 사슬 BFS — 시작 개념은 제외하고 부모들만 타입 루트 후보로 검사한다.
  const found = new Set<PlacementTypeName>();
  const visited = new Set<string>([start.conceptId]);
  let frontier: string[] = store.getHierarchyDirectParents(start.conceptId);
  let depth = 0;

  while (frontier.length > 0 && depth < PARENT_CHAIN_MAX_DEPTH) {
    const nextFrontier: string[] = [];
    for (const parentId of frontier) {
      if (visited.has(parentId)) continue;
      visited.add(parentId);
      const parent = await store.getConcept(parentId);
      // 끝점이 개념이 아니거나(엔티티·사람 id) 사라진 노드면 타입 루트 후보가 아니다 —
      // 타입 루트는 ensureTypeRootConcept 가 만든 concept 라 getConcept 로 잡힌다.
      if (parent) {
        const t = typeForKoName(parent.name);
        if (t) found.add(t);
      }
      for (const grand of store.getHierarchyDirectParents(parentId)) {
        if (!visited.has(grand)) nextFrontier.push(grand);
      }
    }
    frontier = nextFrontier;
    depth += 1;
  }

  // 3. 판정 — 타입 루트 1개면 그 타입, 0개면 null, 2개+ 면 모호(거짓 타입 0).
  if (found.size === 1) {
    return { type: [...found][0]!, ambiguous: false };
  }
  if (found.size === 0) {
    return {
      type: null,
      ambiguous: false,
      reason: `'${name}' 부모 사슬에 타입 루트 없음 — 일반 개념(상속 대상 아님)`,
    };
  }
  return {
    type: null,
    ambiguous: true,
    reason: `'${name}' 가 서로 다른 타입 루트 ${found.size}개 아래 매달림(${[...found].join(", ")}) — 모호해 상속 안 함`,
  };
}
