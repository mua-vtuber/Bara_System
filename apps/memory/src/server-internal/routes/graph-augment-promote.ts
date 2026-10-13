/**
 * graph-augment-promote — augmentWithEntities 블록 1.5c 승격 판정 헬퍼(H7 분해).
 *
 * 글이 mention 한 잎 개념(cid)이 어느 한 엔티티 타입의 identity 로 *정확히 1개* 행과
 * 1:1 인지 판정한다. 한 타입·한 행이면 그 {type, id} 를, 여러 타입·여러 행(모호)이면
 * null 을 회신한다. 글→엔티티행 승격(블록 1.5c ①~④)이 이 판정으로 승격 후보를 가른다.
 *
 * store 읽기(getEntitiesByConcept)만 하고 nodeById·edgeSet 을 변형하지 않는다 — 부작용
 * 없는 조회 결정 함수다. augmentWithEntities 의 in-place 변형 루프에서 "어느 행으로
 * 승격할지" 결정 부분만 떼어내, 변형 로직과 판정 로직을 가른다(behavior-preserving).
 */

import type { MemoryApiDeps } from "../types.ts";
import { ENTITY_TYPE_METAS } from "../../db/store-internal/entity-type-registry.ts";

/**
 * cid 가 한 엔티티 타입의 identity 로 정확히 1개 행과 1:1 이면 그 {type, id}, 아니면 null.
 *
 * 판정 규칙(옛 블록 1.5c 안 루프와 동치):
 *   - 종류 순회(8 타입 + user 새 종류)로 각 종류의 identity 엣지를 본다.
 *   - 한 종류라도 edges.length > 1 이거나, 둘째 종류에서도 행이 나오면(promoteRef 이미
 *     있음) ambiguous = true → null(어느 행으로 승격할지 모호하면 개념 노드 유지).
 *   - 정확히 한 종류·한 행이면 그 행으로 승격 후보를 정한다.
 *
 * userTypeNames(plan 2026-06-28 G2·RC2) — 옛날엔 ENTITY_TYPE_METAS(8 타입)만 순회해 user
 * 종류 단일 배치 글이 자기 user 행으로 승격되지 못했다(잎 개념 노드 + 행 노드 이중·묶음
 * 미합류 연쇄). 호출처(augmentWithEntities)가 요청당 1회 캐싱한 user 종류 목록을 넘겨 8 타입
 * 과 같은 1:1 규칙을 user 종류에도 적용한다. 빈 배열(기본값)이면 옛 8 타입 전용 동작(회귀 0).
 *
 * 결정적·읽기 전용 — store 의 identity 엣지 조회만 한다(DB 쓰기 0·nodeById 변형 0).
 */
export function resolvePromotionRef(
  store: MemoryApiDeps["store"],
  cid: string,
  userTypeNames: readonly string[] = [],
): { type: string; id: string } | null {
  const typeNames = [
    ...ENTITY_TYPE_METAS.map((m) => m.typeName as string),
    ...userTypeNames,
  ];
  let promoteRef: { type: string; id: string } | null = null;
  for (const typeName of typeNames) {
    const edges = store.getEntitiesByConcept(typeName, cid, "identity");
    if (edges.length === 0) continue;
    if (edges.length > 1 || promoteRef) return null; // 여러 행·여러 타입 = 모호.
    promoteRef = { type: typeName, id: edges[0]!.entityId };
  }
  return promoteRef;
}
