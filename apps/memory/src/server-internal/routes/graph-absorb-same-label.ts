/**
 * server-internal/routes/graph-absorb-same-label.ts — ⑧ 같은 이름 노드 전면 흡수.
 *
 * buildGroupNodes(타입 묶음·④)가 못 합친 잔여 동명 노드(태그 "일정" + schedule 묶음
 * 등)를 마저 한 노드로 합치는 absorbSameLabelNodes 와, 그 대표 선정·그룹핑 키 헬퍼
 * (absorbRepresentativeRank·absorbGroupingKey·normalizeAbsorbLabel)를 담는다. graph.ts
 * 에서 책임 단위로 옮겨 왔다(CLAUDE.md "파일 작게").
 *
 * 위계 단일 출처(S2-T3·흡수 폐기) 정합 — 옛 ②(identity 역조회로 그림자 잎 개념을
 * 엔티티 행에 합치기)는 사라졌다. 그림자 잎 개념이 더는 안 생겨 ⑧ 이 합칠 동명 잔여가
 * 크게 줄었다(person·엔티티 그림자 동명 케이스 소멸). 남는 정당한 동명은 태그 개념과
 * 타입 루트가 같은 이름인 경우(예 태그 "일정" ↔ schedule 타입 루트 "일정")뿐이라,
 * ⑧ 은 그 좁아진 동명만 합친다(과합치기 0 — group.length<2 하한이 단일 노드를 막는다).
 *
 * 글 노드(node:)는 흡수 대상이 아니다(isMemoryListContentNode·그룹핑 단계에서 제외) —
 * 검색 hit 과 subgraph 정합을 위해 보호한다(우측 검색 결과 클릭 시 모달 안 뜨던 결함 근본).
 *
 * 합치기 실행 엔진(remap+rebuild)은 graph-augment.ts 의 absorbConceptsIntoEntities 를
 * 그대로 재사용한다(단일 출처 — 옛 ② 흡수가 쓰던 엔진을 ⑧ 이 보존). 공유 토대는
 * graph-nodes-shared.ts. 읽기 전용 — nodeById·edgeSet 만 in-place 변형. 쓰기 0 /
 * 스키마 변경 0 / RRF 코어 0.
 */

import {
  type GraphNode,
  type GraphEdge,
} from "./graph-nodes-shared.ts";
import { absorbConceptsIntoEntities } from "./graph-augment.ts";
import { displayKindName } from "../../memory/entity-type-classifier.ts";

/**
 * ⑧ 흡수 대표 우선순위 — 같은 label 노드 그룹에서 누가 대표로 남는지 정한다
 * (spec 2026-06-13 그래프 노드 흡수 §5.4 ⑧·결정 7).
 *
 * 사용자 "같은 이름이면 엔티티에 흡수" — 엔티티 행 > 타입 대표(entity_group) > 위계
 * 루트(classification_key) > 분류값/태그/멘션(concept) 순. 숫자가 클수록 대표 우선.
 *   · 엔티티 행: entity:/person:/project: namespace 키(전용 테이블 행).
 *   · 타입 대표: sourceType="entity_group"(⑥ 거대 허브).
 *   · 위계 루트: sourceType="classification_key"(콜론 위계 부모).
 *   · 그 외(concept): 분류 값·태그·멘션이 한 어휘로 합류(representativeConceptType).
 * 같은 등급 둘은 호출부가 id 사전순으로 가른다(결정적).
 *
 * P3-display(증상①) 후 — rank 4(엔티티 행)는 *대표 선정* 에선 그대로 최우선이라 동명 개념을
 * 빨아들이는 대표가 된다. 단 비대표 매핑 단계에서 entity: 행은 빠진다(isProtectedEntityRow
 * Node) — 동명 엔티티 행 둘이 서로 빨려가지 않게(P3 별개 작품 보존). person:/project: 는
 * 그 보호에서 빠져 기존처럼 한쪽이 대표로 합쳐진다(spec Q3-3 일반화 Deferred).
 */
function absorbRepresentativeRank(node: GraphNode): number {
  if (node.id.startsWith("entity:") || node.id.startsWith("person:") || node.id.startsWith("project:")) {
    return 4; // 엔티티 행 — 최우선 대표.
  }
  if (node.sourceType === "entity_group") return 3; // 타입 대표(거대 허브).
  if (node.sourceType === "classification_key") return 2; // 위계 루트.
  return 1; // 분류 값·태그·멘션(일반 개념).
}

/** label 정규화 — 앞뒤 공백 제거 + 소문자(concept_nodes.name UNIQUE 규칙과 정합). */
function normalizeAbsorbLabel(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * ⑧ 흡수에서 *비대표(absorbee)로 빨려가면 안 되는* 엔티티 행 노드 판정(P3-display·증상①).
 *
 * `entity:<type>:<id>` 노드는 id 가 곧 정체성이다 — P3(작품 동명 구분)이 같은 이름·다른
 * 매체·다른 작가를 별개 work 행으로 가르면, 두 행은 표시 label 이 "괴담" 으로 같아도 서로
 * 다른 엔티티다. ⑧ 이 표시 label 만 보고 이 둘 중 하나를 다른 하나로 빨아들이면 P3 가 가른
 * 별개 작품이 도로 사라져, 사라진 쪽을 클릭하면 view-model 에서 못 찾는 유령이 된다(증상①).
 * 그래서 엔티티 행은 *대표로 남아 개념을 빨아들이는 것은 되지만*(아래 정합), 비대표로
 * *빨려가는 것은 막는다* — 동명 엔티티 행이 둘이면 둘 다 독립 노드로 살아남는다.
 *
 * 정합(엔티티 행이 *대표* 인 경우는 유지) — schedule "장터당번" 처럼 자기 identity 개념
 * (schedule_concept_edges role='identity'·같은 정체성)이 동명 concept 노드로 함께 떠 있으면,
 * 그 개념은 엔티티 행의 *그림자* 라 엔티티 행(대표)으로 흡수돼 한 노드가 되는 게 옳다(원래
 * ⑧ 정신). 막는 것은 *엔티티 행 ↔ 다른 엔티티 행* 의 라벨 일치 합치기뿐이다 — 엔티티 행을
 * 비대표 매핑에서만 빼면, 동명 엔티티 둘은 서로 비대표가 못 돼 둘 다 살고, 개념은 여전히
 * 엔티티 대표로 흡수된다.
 *
 * 적용 범위 — P3 가 가른 1급 8 타입 행(entity: namespace) 한정. person·project namespace 의
 * 동명 합치기는 P3 무관이라 기존 동작 그대로다(회귀 최소·spec Q3-3 일반화 Deferred).
 */
function isProtectedEntityRowNode(node: GraphNode): boolean {
  return node.id.startsWith("entity:");
}

/**
 * ⑧ 흡수에서 *비대표(absorbee)로도 대표로도 빨려가면 안 되는* 글 노드 판정(우측 클릭 모달 결함).
 *
 * `node:<N>` 노드(nodeKey 가 글 MemoryNode 에 붙이는 키)는 실제 글 한 편이다 — 검색 hit 은
 * 흡수 전 키(`node:46` 등)로 잡히는데, ⑧ 이 그 글을 동명 개념·묶음 노드에 빨아들이면 흡수
 * 후 subgraph 에서 `node:46` 이 사라진다. 그러면 우측 검색 결과를 클릭해도 buildNodeDetailEl
 * 이 그 글 노드를 못 찾아 상세 모달이 안 뜬다(검색 hit ↔ subgraph 불일치).
 *
 * 그래서 글 노드는 흡수에서 통째로 제외한다 — 비대표로 빨려가지도, 대표가 돼 개념을
 * 빨아들이지도 않는다. 글은 합치기 대상이 아니다(검색 hit 정합·실제 글 content 보존). 이
 * 보호의 근거는 isProtectedEntityRowNode(P3 별개 작품 보존)와 다르다 — 그쪽은 동명 엔티티
 * 행 둘이 서로 섞이는 것을 막고, 이쪽은 글이 검색 hit 과 어긋나는 것을 막는다.
 */
function isMemoryListContentNode(node: GraphNode): boolean {
  return node.id.startsWith("node:");
}

/**
 * ⑧ 같은-label 그룹핑 키 — 노드를 어느 이름으로 묶을지 정한다(spec §5.4 ⑧·line 322).
 *
 * 타입 묶음 노드(entity_group·groupType 보유)는 표시 label 에 접미사(" (전체)")가 붙어
 * 있으나, 그룹핑은 그 타입의 koName(displayKindName(groupType)·예 schedule→"일정")으로 한다 —
 * 태그 "일정" 개념(label "일정")과 schedule 묶음(koName "일정")이 같은 그룹에 묶여 한 노드로
 * 합쳐지게 한다(라이브 일정 2노드 해소·관찰 2). 그 외 노드는 표시 label 을 그대로 쓴다.
 * displayKindName 은 ④ findHierarchyRootNodeKey·groupLabel 과 같은 koName 단일 출처라
 * 하드코딩 0(plan 2026-06-28 G3·user 종류 koName 동적 합류). koName 출처가 없어 코드명이
 * 돌아오면(주입 전·미등록·groupType==='ledger' 인데 명부 없음) 그 코드명과 같은 개념 label
 * 은 보통 없어 그룹핑이 일어나지 않는다 — 표시 label 그대로 쓰는 것과 사실상 같다(안전).
 */
function absorbGroupingKey(node: GraphNode): string {
  if (node.sourceType === "entity_group" && node.groupType) {
    const koName = displayKindName(node.groupType);
    if (koName) return normalizeAbsorbLabel(koName);
  }
  return normalizeAbsorbLabel(node.label);
}

/**
 * ⑧ 같은 이름 노드 전면 흡수 — ④(buildGroupNodes 묶음)가 못 합친 잔여 동명 노드를
 * 마저 한 노드로 합친다(spec 2026-06-13 그래프 노드 흡수 §5.4 ⑧·라이브 결함 일정 2노드).
 *
 * ④(buildGroupNodes 의 label↔koName 일치 묶음)와 ⑧(순수 label 그룹핑)은 *어떤 노드를
 * 합칠지 찾는 키 빌더*가 서로 다르나, *합치기 실행 엔진*(대표 키로 노드 합치고 매달린
 * 엣지 재지정·자기 루프·중복 제거)은 같다 — `absorbConceptsIntoEntities` 의 remap+rebuild
 * 다. ⑧ 은 그 엔진을 그대로 재사용하고, *순수 label 그룹핑* 키 빌더만 둔다(nodeById 만
 * 훑음·DB 조회 0). 옛 ②(identity 역조회 흡수)도 같은 엔진을 썼으나 위계 단일 출처
 * (S2-T3)에서 폐기됐다 — 엔진은 ⑧ 단일 출처로 보존된다.
 *
 * 절차:
 *   1. nodeById 를 정규화 label(앞뒤 공백·대소문자) 로 그룹핑한다.
 *   2. 한 그룹에 노드가 2개 이상일 때만(과합치기 하한) 대표를 고른다 — absorbRepresentative
 *      Rank 가 큰 노드, 같으면 id 사전순 첫째(결정적).
 *   3. 비대표 노드 키 → 대표 키 매핑을 만들어 absorbConceptsIntoEntities 엔진에 한 번에
 *      넘긴다(비대표 노드 제거·매달린 엣지 대표로 재지정·자기 루프/중복 제거).
 *
 * 배치 — buildGroupNodes(④⑤⑥) 다음·pruneClassificationLeafLines(⑨) 앞. ④ 가 만든
 * 묶음 대표는 그 그룹 유일 노드라 합치기 대상이 안 돼 무변경(④ 결과를 덮어쓰지 않는다).
 *
 * 회귀 0 / 과합치기 0 — 같은 정규화 label 노드가 2개 이상 없으면 no-op(합치기 0).
 * 위계 단일 출처(흡수 폐기) 후 그림자 잎 개념이 안 생겨 동명 잔여가 크게 준다 —
 * 엔티티 행은 흡수 없이 entity:/person: 노드로 *직접* 합류하므로(graph-augment 블록
 * 1.55·1.5b·1.6b) 옛 그림자 개념-엔티티 동명 충돌이 소멸했다. 장소도 ④⑥ 으로 이미
 * 한 묶음 노드라 같은 label "장소" 노드가 1개뿐 → ⑧ 무변경.
 *
 * 글 노드(node:) 보호(우측 클릭 모달 결함) — 글 노드는 흡수에 안 낀다(isMemoryListContent
 * Node·그룹핑 단계에서 제외). 검색 hit 은 흡수 전 키(node:46)로 잡히는데 ⑧ 이 그 글을 동명
 * 개념·묶음에 빨아들이면 흡수 후 subgraph 에서 그 글이 사라져, 우측 검색 결과를 클릭해도
 * 상세 모달이 안 떴다(검색 hit ↔ subgraph 불일치). 글은 비대표로도 대표로도 합치기에 안
 * 끼는 게 의도에 맞다 — 글은 합치기 대상이 아니다(검색 hit 정합·실제 글 content 보존).
 *
 * P3-display(증상①) — entity: namespace 행은 *비대표로 빨려가지 않는다*(isProtectedEntity
 * RowNode). P3 가 같은 이름·다른 매체·다른 작가를 별개 work 행으로 가르면, 두 work 노드는
 * 표시 label 이 "괴담" 으로 같아도 id 가 다른 별개 엔티티라 어느 쪽도 다른 쪽으로 빨려가지
 * 않고 각자 독립 노드로 남는다. 옛 한계(§6 D4 "우연 동명 합치기")가 P3 로 실제 터진(사라진
 * work 노드 클릭 시 view-model 못 찾는 유령) 것을 막는다.
 *
 * 정합(엔티티 행이 *대표* 인 경우는 유지) — schedule "장터당번" 처럼 자기 identity 개념이
 * 동명 concept 노드로 함께 떠 있으면, 그 개념은 엔티티 행(대표)으로 흡수돼 한 노드가 된다
 * (원래 ⑧ 정신·같은 정체성의 그림자 개념 정리). 막는 것은 엔티티 행 ↔ 다른 엔티티 행 의
 * 라벨 일치 합치기뿐이다. concept·classification_key·태그 동명 합치기도 그대로 유지.
 *
 * 한계(§6 D4 잔여) — person "한별" 과 project "한별" 처럼 entity: 가 아닌 정체성 노드끼리
 * 우연 동명이면 여전히 한 노드로 합쳐진다(person/project 일반화는 spec Q3-3 후속 Deferred).
 * 이건 *표시 전용 합치기* 라 DB·검색은 안 섞인다 — 옛 collectPersonNameConceptAbsorptions 의
 * 라벨 일치 *데이터* 과흡수(회귀 원인)와 다르다.
 *
 * 표시 단계 한정 — nodeById·edgeSet 만 in-place 변형. DB·검색·RRF 0.
 */
export function absorbSameLabelNodes(
  nodeById: Map<string, GraphNode>,
  edgeSet: Map<string, GraphEdge>,
): void {
  // 1) 그룹핑 키(타입 묶음은 koName·그 외는 표시 label) → 그 키 노드 목록.
  const byLabel = new Map<string, GraphNode[]>();
  for (const node of nodeById.values()) {
    // 글 노드(node:)는 흡수에 안 낀다 — 검색 hit 과 subgraph 정합을 위해 보호(우측 클릭
    //   모달 결함 근본). 그룹핑에서 빼면 대표 후보로도 비대표로도 들지 않아, 글이 동명
    //   개념·묶음에 빨려가지도 동명 개념을 빨아들이지도 않는다. 글은 합치기 대상이 아니다.
    if (isMemoryListContentNode(node)) continue;
    const key = absorbGroupingKey(node);
    if (key.length === 0) continue; // 빈 키는 흡수 대상에서 제외(우연한 빈-라벨 충돌 방지).
    const arr = byLabel.get(key) ?? [];
    arr.push(node);
    byLabel.set(key, arr);
  }

  // 2~3) 그룹마다 대표를 고르고 비대표 → 대표 매핑을 모은다.
  const absorbeeToRep = new Map<string, string>();
  for (const group of byLabel.values()) {
    if (group.length < 2) continue; // 과합치기 하한 — 단일 노드는 안 건드린다.
    // 대표 = rank 최대, 같으면 id 사전순 첫째(결정적).
    const rep = group.reduce((best, n) => {
      const r = absorbRepresentativeRank(n);
      const br = absorbRepresentativeRank(best);
      if (r > br) return n;
      if (r === br && n.id < best.id) return n;
      return best;
    });
    for (const n of group) {
      if (n.id === rep.id) continue;
      // P3-display(증상①) — entity: 행은 비대표로 빨려가지 않는다. 동명 엔티티 행 둘이
      //   같은 그룹이면 대표가 아닌 쪽은 매핑에서 빠져 독립 노드로 남는다(별개 작품 보존).
      //   엔티티 행이 *대표* 일 때 동명 개념을 빨아들이는 것은 그대로다(그림자 개념 정리).
      if (isProtectedEntityRowNode(n)) continue;
      absorbeeToRep.set(n.id, rep.id);
    }
  }

  // 흡수 엔진 재사용(remap+rebuild 단일 출처). 빈 매핑이면 엔진이 early-return.
  absorbConceptsIntoEntities(nodeById, edgeSet, absorbeeToRep);
}
