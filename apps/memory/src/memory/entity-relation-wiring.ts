/**
 * entity-relation-wiring.ts — 관계 태그를 엔티티 행 ↔ 엔티티 행 관계 엣지로 세우는 wiring
 * (개념 엔티티 타입 체계 4단계 Task 4, spec 2026-06-09 §3 3분법·§7.2·§7.3).
 *
 * Task 1·2·3 산출을 한 흐름으로 묶는다. 3단계가 만든 source 엔티티 행(작품 행 등)이 생겼을
 * 때, 같은 글에 손으로 적은 관계 태그(`#창작자:아쿠타미`)를 골라 target 엔티티 행(사람 행
 * "아쿠타미")으로 해석하고, 둘 사이를 entity_relation_edges 에 통합 관계 엣지(created_by)로
 * 잇는다. 흐름:
 *
 *   1. parseRelationTags(content) — 글의 콜론 태그 중 관계 키만 골라낸다(Task 3·순수 함수).
 *      0개면 빈 결과를 정직하게 돌려준다(실패가 아니라 진짜 관계 태그 없음).
 *   2. source 타입이 그 관계의 spec.sourceTypes 에 맞는지 본다 — 안 맞으면 엣지를 만들지
 *      않고 warn 을 누적한다(예: 작품에 located_at 은 없다·일정 전용). 거짓 엣지 0.
 *   3. resolveRelationTarget(...) — target 엔티티 행을 만들거나 찾는다(Task 3·DB 의존).
 *      skipped(빈 값·타입 모호)면 warn 을 누적하고 다음 태그로 넘어간다.
 *   4. store.addEntityRelationEdge(...) — source 행 → target 행 관계 엣지(멱등·INSERT OR
 *      IGNORE). 새로 만들었으면 created 에, 중복이면 already 에 분리해 정직하게 기록한다.
 *
 * 범위 경계(spec §7.3·사이드카 scopeBoundary):
 *  - 이 통로는 *신규 8 타입 source* 관계만 다룬다 — source 가 work·material·creature·
 *    schedule·usable·intake 인 관계만 엔티티 행 ↔ 행 엣지로 만든다.
 *  - participated_by(프로젝트 → 사람)는 store facade(project-entity-mixin)가 범용
 *    entity_relation_edges 에 직접 적으므로 이 통로에서 만들지 않는다(중복 0).
 *  - family_of·friend_of(사람 → 사람)는 이 통로 밖이다(5단계 또는 별 결정). source 가
 *    person 인 관계는 여기서 다루지 않는다.
 *  위 경계는 spec.sourceTypes 검사(2단계)가 자연스럽게 거른다 — wireEntityRelations 가
 *  받는 sourceType 은 항상 신규 8 타입이고(아래 assert), 그 8 타입이 source 가 아닌
 *  관계(participated_by·family_of·friend_of)는 sourceTypes 불일치로 skip 된다.
 *
 * silent fallback 금지 — source 타입 불일치·target 미해석·빈 값은 엣지를 만들지 않고
 * warn(식별자 포함)에 사유를 남긴다(0개를 정상으로 위장하지 않는다). 별 *Safe 래퍼는
 * 만들지 않는다 — 입력 통로의 wireEntityPlacementSafe try/catch 가 격리하고, 개별 태그
 * 실패는 이 함수 안에서 warn 누적으로 격리한다(한 태그 실패가 다음 태그를 멈추지 않는다).
 *
 * RRF 코어·새 스키마·새 테이블 0 — Task 1~3 산출(파서·target 해석·repository)만 재사용한다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import type { PlacementTypeName } from "./concept-type-vocabulary.ts";
import {
  parseRelationTags,
  resolveRelationTarget,
  isSkippedTarget,
  type SameDocTypeHint,
} from "./entity-relation-target.ts";
import { type EntityTypeName } from "../db/store-internal/entity-type-registry.ts";
import type { Provenance } from "./provenance-vocabulary.ts";

/** 신규 8 엔티티 타입 이름 집합 — source 가 이 8 타입일 때만 이 통로가 관계 엣지를 세운다. */
const ENTITY_TYPE_NAMES: readonly EntityTypeName[] = [
  "creature",
  "thing",
  "intake",
  "usable",
  "work",
  "material",
  "place",
  "schedule",
];

function isEntityType(t: string): t is EntityTypeName {
  return (ENTITY_TYPE_NAMES as readonly string[]).includes(t);
}

/** wireEntityRelations 입력 — source 행 식별자 + 글 본문 + 같은 글 명시 타입 힌트. */
export interface WireEntityRelationsArgs {
  /** 관계 태그가 나온 글 노드 id. entity_relation_edges.source_node_id 로 기록한다. */
  originNodeId: number | null;
  /** 관계 출처. 글에서 나온 해시태그는 hashtag, 엔티티 프로필 패치는 user_input. */
  provenance?: Provenance;
  /** source 엔티티 행 타입(신규 8 타입). person/project 면 loud throw(이 통로 밖). */
  sourceType: EntityTypeName;
  /** source 엔티티 행 id(3단계가 만든 id). */
  sourceId: string;
  /** 글 본문(태그 포함 원문). parseRelationTags 가 여기서 관계 태그를 골라낸다. */
  content: string;
  /**
   * 같은 글의 명시 타입 태그 힌트(`#작품:데못죽` → {value:'데못죽', type:'work'}).
   * target 타입이 여럿 가능한 사용자 관계에서 가르기에 쓴다.
   * 호출처(wireEntityPlacement)가 구성해 넘긴다. 기본 빈 배열(힌트 없으면 기본 타입으로).
   */
  sameDocTypeHints?: readonly SameDocTypeHint[];
}

/** 만든 관계 엣지 한 건 — 로그·검증·디버깅용(어느 관계로 어느 행을 이었는지). */
export interface CreatedRelationEdge {
  /** 사용자가 적은 원본 키(예: '창작자'). */
  rawKey: string;
  /** 만든 관계명(예: 'created_by'). */
  relation: string;
  /** source 행 타입·id. */
  sourceType: PlacementTypeName;
  sourceId: string;
  /** target 행 타입·id·이름(해석된 엔티티 행). */
  targetType: PlacementTypeName;
  targetId: string;
  targetName: string;
}

/** wireEntityRelations 결과 — 만든 엣지·중복·건너뜀을 정직하게 분리해 돌려준다. */
export interface EntityRelationResult {
  /** 새로 만든 관계 엣지 목록(멱등이라 이미 있던 건 created 가 아니라 already 로 간다). */
  created: CreatedRelationEdge[];
  /** 이미 있어 중복으로 무시된 관계 엣지(멱등) — 만든 건 아니지만 정직하게 분리 기록. */
  already: CreatedRelationEdge[];
  /** 정직한 경고(source 타입 불일치·target 미해석·빈 값 — 식별자 포함). */
  warnings: string[];
}

/**
 * 한 source 엔티티 행에 걸린 관계 태그를 entity_relation_edges 관계 엣지로 세운다.
 *
 * 신규 8 타입 source 만 다룬다 — sourceType 이 person/project 면 식별자와 함께 loud throw
 * 한다(이 통로 밖·spec §7.3). 멱등 — 같은 글로 두 번 불러도 addEntityRelationEdge 가
 * INSERT OR IGNORE 라 중복 엣지가 안 생긴다(두 번째는 already 로 분리된다).
 *
 * @param store 실제 SqliteMemoryStore(실 DB·실 임베딩).
 * @param args  source 행 식별자·글 본문·같은 글 명시 타입 힌트.
 * @returns 만든 엣지·중복·건너뜀 경고를 분리한 결과(정직).
 */
export async function wireEntityRelations(
  store: SqliteMemoryStore,
  args: WireEntityRelationsArgs,
): Promise<EntityRelationResult> {
  const { originNodeId, sourceType, sourceId, content } = args;
  const provenance = args.provenance ?? (originNodeId === null ? "user_input" : "hashtag");
  const sameDocTypeHints = args.sameDocTypeHints ?? [];

  const result: EntityRelationResult = {
    created: [],
    already: [],
    warnings: [],
  };

  // 이 통로는 신규 8 타입 source 전용이다 — person/project 는 기존 통로(참여자 관계는
  // entity_relation_edges participated_by·5단계)가 전담한다. mixin 이 이 wiring 을 거치지
  // 않고 addEntityRelationEdge 를 직접 부르므로 이 차단은 그 경로와 무관하다(plan 정정2).
  // 잘못 들어오면 조용히 0개로 위장하지 않고 식별자와 함께 멈춘다.
  if (!isEntityType(sourceType)) {
    throw new Error(
      `entity-relation-wiring: source 타입 '${sourceType}' 은(는) 신규 8 타입 ` +
        `(${ENTITY_TYPE_NAMES.join(", ")}) 이 아니다 — 사람·프로젝트 source 관계는 이 통로 ` +
        `밖이다(participated_by=entity_relation_edges·family_of/friend_of=5단계, spec §7.3)`,
    );
  }

  // 1) 관계 태그를 골라낸다(순수 함수). 0개면 빈 결과(정직 — 실패가 아니라 관계 태그 없음).
  const relationTags = parseRelationTags(content);
  if (relationTags.length === 0) return result;

  for (const tag of relationTags) {
    // 2) source 타입이 이 관계의 허용 source 타입에 맞는지 — 안 맞으면 엣지 0 + warn.
    //    예: source 가 작품인데 located_at(일정 전용)이면 만들지 않는다(거짓 엣지 0).
    if (!tag.spec.sourceTypes.includes(sourceType)) {
      result.warnings.push(
        `관계 키 '${tag.rawKey}'(관계 '${tag.spec.relation}') 는 source 타입 ` +
          `'${sourceType}' 에 걸 수 없다 — 허용 source(${tag.spec.sourceTypes.join("/")}) ` +
          `밖이라 건너뛴다(값 '${tag.value}', source 행 '${sourceId}')`,
      );
      continue;
    }

    // 3) target 엔티티 행을 만들거나 찾는다. 빈 값·타입 모호면 skipped+사유 → warn 누적.
    const resolved = await resolveRelationTarget(
      store,
      tag.spec,
      tag.value,
      sameDocTypeHints,
    );
    if (isSkippedTarget(resolved)) {
      result.warnings.push(
        `관계 키 '${tag.rawKey}' 의 target 을 해석하지 못해 건너뛴다 — ${resolved.reason}`,
      );
      continue;
    }

    // 4) source 행 → target 행 관계 엣지(멱등). 새로 만들었으면 created, 중복이면 already.
    const edge: CreatedRelationEdge = {
      rawKey: tag.rawKey,
      relation: tag.spec.relation,
      sourceType,
      sourceId,
      targetType: resolved.type,
      targetId: resolved.id,
      targetName: resolved.name,
    };
    const isNew = store.addEntityRelationEdge(
      sourceType,
      sourceId,
      resolved.type,
      resolved.id,
      tag.spec.relation,
      provenance,
      originNodeId,
    );
    if (isNew) result.created.push(edge);
    else result.already.push(edge);
  }

  return result;
}
