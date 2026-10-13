/**
 * routes/graph-augment-promote-apply.ts — 블록 1.5c: 글→엔티티행 승격 적용 + 분리 잎
 * identity 1:1 미출력·재지정 + 사슬 분류 직접 선 제거.
 *
 * routes/graph-augment.ts 를 책임 경계로 분할하며 옮겨 온 모듈이다(P3 G5-a —
 * docs/decisions/2026-07-03-structure-cleanup-spec.md). 승격 *판정*은 종전대로
 * graph-augment-promote.ts(resolvePromotionRef)가 지고, 이 모듈은 그 판정의 *적용*
 * (간선 추가·mention 제거·잎 개념 노드 제거)을 진다. 블록 순서·주석은 옛 파일
 * 그대로(동작 불변) — 배선은 graph-augment.ts 파사드의 augmentWithEntities 가 진다.
 */

import {
  MENTION_ENTITY_EDGE_TYPE,
  MENTION_ENTITY_SIDE_EDGE_TYPE,
  MENTION_ENTITY_EDGE_WEIGHT,
  conceptKey,
  entityKey,
} from "./graph-nodes-shared.ts";
import { resolvePromotionRef } from "./graph-augment-promote.ts";
import {
  addEntityEdge,
  climbHierarchyConceptIds,
  type AugmentContext,
} from "./graph-augment-shared.ts";

/**
 * 1.5c) 글→엔티티행 승격 + 분리 잎 identity 1:1 미출력·재지정 + 사슬 분류 직접 선 제거
 *   (P2-G2·H1·옵션 2-A′·Q2-2·Q2-5·"가장 깊은 선언 대상에만 붙음").
 *   E3(잎 개념을 work 정체성 키로 분리) 이후 작품 글은 works 행을 직접 mention 하지 않고
 *   분리 잎 개념('괴담 (소설/백덕수)')만 mention 한다. 생물 글도 잎 개념('까망이')만
 *   mention 한다. 그래서 글의 주 부모가 매체·상위 분류 허브('소설'·'동물') 쪽으로 쏠리고,
 *   잎이 분리 잎 개념 노드 + 엔티티 행 노드 둘로 중복돼 보인다.
 *
 *   해법(이름 흡수 0·DB 0 diff) — 글이 mention 한 잎 개념 cid 가 어느 한 타입의 identity 로
 *   *정확히 1개* 엔티티 행과 이어지고 그 행이 집합 안이면: ① 글→엔티티행 신설 type
 *   (MENTION_ENTITY_EDGE_TYPE·prio 70·G1) 간선을 add 해 글이 자기 행 아래 직접 매달리게
 *   하고, ② 글→cid mention 엣지를 제거하고, ③ cid 노드를 빼 잎을 행 한 노드로 남긴다.
 *   한 cid 가 여러 타입·여러 행에 identity 면(우연·비정상) 재지정하지 않는다(안전·정직 —
 *   어느 행으로 승격할지 모호하면 개념 노드 유지).
 *
 *   전 타입 일반화(H1·Q2-5) — 옛 work 한정(getEntitiesByConcept("work", …))을
 *   ENTITY_TYPE_METAS 순회(블록 1.5b 양식)로 넓혀 8 타입(creature·thing·item·usable·
 *   work·material·place·schedule) 전부에서 잎→행 승격을 적용한다. 생물 '#고양이:까망이' 의
 *   까망이 잎도 creature 행으로 승격된다. identity 1:1 좁은 규칙·행 in-set 게이트는
 *   타입 무관 유지. 이름 기준 흡수(absorbConceptsIntoEntities·absorbSameLabelNodes)는
 *   호출하지 않는다 — 과흡수 회귀의 뿌리를 피한다.
 *
 *   사슬 분류 직접 선 제거(H1·Q2-5) — 승격된 글에 대해, 그 행의 위계 사슬(getHierarchy
 *   DirectParents 를 재귀로 거슬러 모은 분류 개념: 소설·고양이·동물·생물 등)으로 가는
 *   글→그 분류 개념 mention 엣지를 edgeSet 에서 제거한다(매체선 포함). 분류 정보는 위계
 *   사슬(행→고양이→동물→생물)이 짊어지므로 글이 중간 분류를 직접 잇지 않는다. 제거 대상은
 *   글→분류 *mention 엣지*(from=글 노드)만 — parent_of 위계선(from=개념·행)은 climb 집합과
 *   같은 끝점을 써도 from 이 글 노드가 아니라 자동 제외돼 사슬이 끊기지 않는다. 사슬 밖
 *   무관 개념으로 가는 mention 은 남긴다(정밀 판정).
 *
 *   순수 분류 글(행 미승격) 무변 — 어느 타입에서도 identity 행이 0 이면 승격 안 함 →
 *   사슬 분류 직접 선 제거도 안 함(글→분류 mention 유지·회귀 0·가장 깊은 대상이 분류라
 *   거기 붙음).
 *
 *   사람 주체 글 가드(G4·Q2-4) — 글이 글→person mention 을 가지면(personSubjectNodes)
 *   글→엔티티행 간선을 부모 승격 type(MENTION_ENTITY_EDGE_TYPE·prio 70) 대신 비부모 곁다리
 *   type(MENTION_ENTITY_SIDE_EDGE_TYPE)으로 emit 한다(일반화 후에도 사람 아래·작품 곁다리).
 */
export function applyMentionPromotions(
  ctx: AugmentContext,
  conceptIdList: string[],
): void {
  const { store, nodeById, edgeSet } = ctx;
  for (const cid of conceptIdList) {
    const mentioners = ctx.conceptMentioners.get(cid);
    if (!mentioners || mentioners.size === 0) continue; // 글이 mention 한 잎만 대상.

    // 전 타입 순회로 cid 가 한 타입에서 정확히 1개 identity 행과 1:1 인지 판정한다 —
    //   판정 로직은 resolvePromotionRef(graph-augment-promote.ts)로 떼어냈다(H7 분해).
    //   userTypeNames(plan G2)를 넘겨 8 타입 + user 종류 모두에서 identity 1:1 을 본다 —
    //   user 단일 배치 글도 자기 user 행 아래로 승격된다. 여러 타입·여러 행이면 null(모호).
    const promoteRef = resolvePromotionRef(store, cid, ctx.userTypeNames);
    if (!promoteRef) continue; // identity 1:1(한 타입·한 행)일 때만.
    const rowKey = entityKey(promoteRef.type, promoteRef.id);
    if (!nodeById.has(rowKey)) continue; // 엔티티 행이 집합 안일 때만(불변식).

    // 사슬 분류 개념 id 집합 — 행에서 getHierarchyDirectParents 를 재귀로 거슬러 모은다
    //   (블록 1.6b BFS 양식·visited Set·깊이 상한). 매체('소설')·상위 분류('고양이'·'동물'·
    //   '생물')가 들어온다. 행 끝점에서 시작하므로 잎 개념(cid) 자체는 보통 안 든다(잎은
    //   행과 identity 짝이지 위계 부모가 아님) — 잎 mention 제거는 ②가 따로 한다.
    const chainConceptIds = climbHierarchyConceptIds(store, promoteRef.id, ctx.userPrefixToType);

    const cKey = conceptKey(cid);
    for (const fromKey of mentioners) {
      // ① 글→엔티티행 간선(from=행·to=글). 사람 주체 글이면 곁다리 type(비부모),
      //    선언 글이면 승격 type(부모 prio 70 — PARENT_IS_FROM 컨벤션·G4 가드).
      const edgeType = ctx.personSubjectNodes.has(fromKey)
        ? MENTION_ENTITY_SIDE_EDGE_TYPE
        : MENTION_ENTITY_EDGE_TYPE;
      addEntityEdge(edgeSet, rowKey, fromKey, edgeType, MENTION_ENTITY_EDGE_WEIGHT);
      // ② 글→분리 잎 개념 mention 엣지 제거(role 무관 — 같은 from·to 엣지 전부).
      for (const [eid, e] of edgeSet) {
        if (e.from === fromKey && e.to === cKey) edgeSet.delete(eid);
      }
      // ③ 사슬 분류 직접 mention 선 제거 — 글(fromKey)에서 사슬 분류 개념으로 가는
      //    mention 엣지만 지운다. from 이 글 노드(fromKey)인 엣지만 대상이라 parent_of
      //    위계선(from=개념·행)은 자동 제외돼 사슬이 끊기지 않는다(매체선 잔존 해소·Q2-5).
      for (const chainCid of chainConceptIds) {
        const chainKey = conceptKey(chainCid);
        for (const [eid, e] of edgeSet) {
          if (e.from === fromKey && e.to === chainKey) edgeSet.delete(eid);
        }
      }
    }
    // ④ 분리 잎 개념 노드 제거 — 그 cid 를 mention 하는 글이 모두 이 승격에 든 경우만.
    //   (다른 글도 그 개념을 mention 하면 공유라 노드를 남긴다 — 위 루프가 그 글도 승격해
    //    mentioners 전부를 처리하므로, conceptMentioners 가 곧 그 cid 의 모든 mention 글이다.)
    nodeById.delete(cKey);
    ctx.conceptIds.delete(cid);
  }
}
