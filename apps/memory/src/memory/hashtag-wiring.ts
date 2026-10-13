/**
 * hashtag-wiring.ts — 태그 개념 노드 wiring (입력 시점 단일 통로).
 *
 * 2026-06-02 태그 wiring 입력 시점 이동 spec §4.1(T1). 옛 `applyHashtagWiring`
 * (extractor.ts)이 한 함수에서 묶던 두 책임 중 *그래프 wiring* 만 떼어낸다:
 *   (a) 별 본문 노드 생성(source: tag_body) + cleanContent 산출  ← 안 가져온다
 *   (b) 태그 개념 노드 upsert + node_concept_edges(tag) + 위계 parent_of(hierarchy_edges · S0-T4 단일 출처)  ← 이 함수
 *
 * (a)는 입력 통로 통합(2026-06-02 main `2d95742`) 이후 불필요하다 — save-input 이
 * 이미 원본 한 노드(origin)를 만들고, 옛 tag_body 별 본문 노드는 origin 과 겹치는
 * 두 번째 본문이었다. 그래서 이 함수는 *주어진 origin 노드* 를 대상으로 태그 개념
 * 노드·엣지만 연결한다.
 *
 * save-input 이 import 하므로 이 파일은 extractor.ts 를 import 하지 않는다(역방향
 * 의존 회피). store 인터페이스(findOrCreateTagConcept / addNodeConceptEdge /
 * addConceptEdge)와 parseTags(tag-extractor.ts)만 의존한다 — 새 정규식·새
 * 라이브러리 0.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import type { AutoCleanupTriggerHandle } from "./auto-cleanup-trigger.ts";
import { parseTags } from "./tag-extractor.ts";
import {
  ENTITY_TYPE_METAS,
  type EntityTypeName,
} from "../db/store-internal/entity-type-registry.ts";

/** `wireHashtagConcepts` 의 추가 옵션. */
export interface WireHashtagConceptsOptions {
  /**
   * Phase 5.7.3 W3 — 태그 개념 노드 신규 작성 시 송출할 데이터 변동 trigger.
   * 미지정 시 no-op(옛 흐름 호환). 옛 `applyHashtagWiring` 의
   * 'hashtag-concept-added' 신호를 보존한다(auto-cleanup-trigger 정합).
   */
  trigger?: AutoCleanupTriggerHandle;
}

/** `wireHashtagConcepts` 의 반환값. */
export interface WireHashtagConceptsResult {
  /**
   * 개념으로 해석된 태그 conceptId 목록(잎·부모 모두 포함, 입력 순서 보존 / spec §10).
   * 글에 `tag` 엣지로 실제 붙는 것은 잎(leaf)뿐이다(§4.2 I2) — 부모 태그도 개념
   * 노드는 만들어지므로 "인식된 태그" 계약상 반환에 남긴다. 같은 이름 사람으로
   * 연결된 태그(personMentionIds)는 여기 들어가지 않는다. 태그 0개거나 전부 사람
   * 연결이면 빈 배열.
   */
  tagConceptIds: string[];
  /**
   * 콜론 없는 `#이름` 이 *이미 등록된 같은 이름 사람* 에 mentions 로 연결된 personId
   * 목록(1.2 후속 F4 / Q23, 입력 순서 보존). 사람으로 해석된 태그는 개념 노드를
   * 만들지 않는다. 사람 연결 0개면 빈 배열.
   */
  personMentionIds: string[];
  /**
   * 그래프 꼬임 해소 1단계 결정 2(spec §3.2·§3.4) — 콜론 없는 `#이름` 이 *이미
   * 등록된 같은 이름 엔티티 인스턴스*(프로젝트·작품·생물 등)로 흡수돼 그 엔티티에
   * 연결된 항목(입력 순서 보존). 엔티티로 해석된 태그는 새 키워드 개념(cpt_)을
   * 만들지 않는다 — 엔티티의 정체성 개념을 거쳐 origin 에 잇는다. 흡수 0개면 빈 배열.
   */
  entityMatches: ResolvedEntityMatch[];
}

/** 결정 2 — 단독 태그가 흡수된 엔티티 인스턴스 한 건. */
export interface ResolvedEntityMatch {
  /** 흡수 타입 — 신규 8 타입 이름 또는 "project". 사람은 personMentionIds 로 분리. */
  typeName: EntityTypeName | "project";
  /** 흡수된 엔티티 행 id. */
  entityId: string;
  /** 엔티티 정체성 개념 id(origin 에 tag 엣지로 붙은 그 개념). */
  conceptId: string;
}

/**
 * 단독 태그 → 엔티티 인스턴스 흡수 조회 단일 출처(spec §1.4·§3.2).
 *
 * 프로젝트 + 신규 8 타입(ENTITY_TYPE_METAS)을 한 배열로 묶어 차례로 findByName 한다.
 * 사람은 별도(findPersonByNameOrAlias) — 이 배열 밖이다. 타입 이름·목록을 손으로
 * 나열하지 않고 ENTITY_TYPE_METAS 의 typeName 을 순회하므로, 9번째 타입이 레지스트리에
 * 더해지면 이 조회도 자동으로 따라 늘어난다(단일 출처).
 */
interface EntityLookupChannel {
  typeName: EntityTypeName | "project";
  /** 이름으로 엔티티 행을 찾는다(조회만·행 생성 0). 없으면 null. */
  findByName(store: SqliteMemoryStore, name: string): Promise<{ id: string } | null>;
}

/**
 * 전 엔티티 타입 조회 통로(프로젝트 + 8 타입). ENTITY_TYPE_METAS 를 단일 출처로
 * 순회하고 프로젝트 1줄만 별도로 더한다 — 사람은 findPersonByNameOrAlias 로 따로 본다.
 *
 * 단계4 T4 — 전용 findXByName facade 8개가 사라져 8 타입은 범용 본체
 * entitiesRepo.findByName(typeName, name) 한 통로로 조회한다(타입별 메서드 맵 제거).
 * findByName 은 조회만(행 생성 0)·없으면 null 이라 옛 findXByName 계약을 그대로 지킨다.
 */
const ENTITY_LOOKUP_CHANNELS: EntityLookupChannel[] = [
  {
    typeName: "project",
    findByName: (store, name) =>
      store
        .findProjectByNameOrAlias(name)
        .then((lookup) => (lookup.project ? { id: lookup.project.projectId } : null)),
  },
  ...ENTITY_TYPE_METAS.map((meta): EntityLookupChannel => ({
    typeName: meta.typeName,
    findByName: (store, name) => {
      const lookup = meta.typeName === "work"
        ? store.entitiesRepo.findByNameOrAlias(meta.typeName, name)
        : store.entitiesRepo
            .findByName(meta.typeName, name)
            .then((r) => ({ entity: r, ambiguous: false }));
      return lookup.then((r) => (r.entity ? { id: r.entity.id } : null));
    },
  })),
];

/** 엔티티 인스턴스 한 건의 조회 결과(매칭 타입·행 id·표시 이름). */
interface EntityLookupHit {
  typeName: EntityTypeName | "project";
  entityId: string;
  name: string;
}

/**
 * 한 태그 이름을 전 엔티티 타입(프로젝트 + 8 타입)에서 조회한다(조회만·행 생성 0).
 * 매칭된 타입을 전부 모은다 — 둘 이상이면 호출처가 동명 모호로 보류한다(spec §3.2).
 */
async function lookupEntityInstances(
  store: SqliteMemoryStore,
  tag: string,
): Promise<EntityLookupHit[]> {
  const hits: EntityLookupHit[] = [];
  for (const channel of ENTITY_LOOKUP_CHANNELS) {
    const row = await channel.findByName(store, tag);
    if (row) hits.push({ typeName: channel.typeName, entityId: row.id, name: tag });
  }
  return hits;
}

/**
 * 흡수된 엔티티 한 건을 origin 글에 잇는다 — 사람 mentions 와 *동등한* 엔티티 엣지.
 *
 * 통일된 origin↔엔티티 직접 엣지가 없어(프로젝트는 project_id 칸·8 타입은 identity
 * 개념 경유) 그래프가 *이미 그리는* 개념 경유 역조회 통로를 그대로 탄다:
 *   1. 엔티티 이름과 같은 정체성 개념을 findOrCreateConcept 로 확보한다 — 새 키워드
 *      개념(cpt_ 폴백)이 아니라 그 엔티티의 정체성 개념이다(이미 stage3 가 만들었으면
 *      합류·중복 0). origin↔그 개념을 node_concept_edges role='tag' 로 잇는다.
 *   2. 엔티티 자신도 그 개념과 잇는다 — 8 타입은 <type>_concept_edges role='identity',
 *      프로젝트는 project_concept_edges role='tag'(ProjectConceptRole 은 identity 가
 *      없어 tag 사용). 그러면 graph augment 1.5(엔티티 identity 역조회)·1.6(프로젝트
 *      project_concept_edges 역조회)가 그 개념을 통해 엔티티 노드를 합류시킨다.
 *
 * 새 스키마·새 엣지 종류 0 — node_concept_edges·<type>_concept_edges·
 * project_concept_edges 는 전부 기존 테이블이다. 멱등(전부 INSERT OR IGNORE / 이름
 * UNIQUE)이라 같은 origin·같은 태그로 2회 호출해도 노드·엣지 중복 0.
 */
async function linkEntityToOrigin(
  store: SqliteMemoryStore,
  originNodeId: number,
  hit: EntityLookupHit,
): Promise<string> {
  const conceptId = await store.findOrCreateConcept(hit.name);
  await store.addNodeConceptEdge(originNodeId, conceptId, "tag", "hashtag", originNodeId);
  if (hit.typeName === "project") {
    await store.addProjectConceptEdge(hit.entityId, conceptId, "tag", "hashtag", originNodeId);
  } else {
    store.addEntityConceptEdge(
      hit.typeName,
      hit.entityId,
      conceptId,
      "identity",
      "hashtag",
      originNodeId,
    );
  }
  return conceptId;
}

/**
 * 한 태그 이름을 *사람* / *엔티티* / *개념* / *모호 보류* 로 해석한다
 * (F4 / Q23 + 별명 spec §3.2 + 그래프 꼬임 해소 1단계 결정 2 spec §3.2·§3.4).
 *
 *   - store.findPersonByNameOrAlias(tag) 가 본명 정확 매칭 또는 별명 단일 매칭으로
 *     사람을 확정하면 → origin↔사람 mentions 엣지를 잇고 { kind: 'person', personId }
 *     반환. 개념 노드는 만들지 않는다.
 *   - lookup.ambiguous(별명이 2명+ 에 겹침)이면 → 사람으로도 엔티티로도 개념으로도
 *     굳히지 않고 { kind: 'ambiguous' } 반환 + 경고. "사람이긴 한데 누군지 모르는"
 *     태그를 다른 노드로 굳히면 의미가 어긋나기 때문(spec §3.2).
 *   - 사람이 아니면 전 엔티티 타입(프로젝트 + 8 타입)에서 이름을 조회한다(결정 2):
 *       · 정확히 한 타입에만 같은 이름 엔티티가 있으면 → 그 엔티티 노드에 origin 을
 *         이어(개념 경유·새 키워드 개념 0) { kind: 'entity', … } 반환. `#바라` 가
 *         프로젝트 "바라" 면 별도 cpt_바라 개념으로 갈리지 않고 그 프로젝트에 붙는다.
 *       · 여러 타입에 같은 이름(작품 "바라"·프로젝트 "바라")이면 → 굳히지 않고 보류·
 *         경고(사람 별명 모호 갈래와 같은 정신·silent fallback 금지·태그·origin id 포함).
 *         origin 노드는 이미 저장돼 글 유실 0.
 *   - 사람·엔티티 어느 것도 아니면(키워드·분류값) → findOrCreateTagConcept 로 개념 노드만
 *     확보하고 { kind: 'concept', conceptId } 반환(결정 4 폴백 보존·기존 동작 무변).
 *     origin↔개념 tag 엣지는 여기서 만들지 않는다 — 호출자가 잎 판정(§4.2) 뒤 잎에만 붙인다.
 *
 * findPersonByNameOrAlias·findXByName 은 전부 조회만 한다(행 생성 0) — 사람·엔티티로
 * 해석되지 않은 태그가 새 사람·새 엔티티 행을 만드는 일은 없다.
 */
async function resolveTagAsPersonOrConcept(
  store: SqliteMemoryStore,
  originNodeId: number,
  tag: string,
): Promise<
  | { kind: "person"; personId: string }
  | { kind: "entity"; match: ResolvedEntityMatch }
  | { kind: "concept"; conceptId: string }
  | { kind: "ambiguous" }
> {
  const lookup = await store.findPersonByNameOrAlias(tag);
  if (lookup.ambiguous) {
    // 별명이 2명+ 에 겹쳐 누구인지 모름 — 사람으로도 엔티티로도 개념으로도 굳히지 않고
    // 정직하게 보류·경고한다(silent drop 금지, 별명·origin id 포함). origin 노드는
    // 이미 저장돼 글은 유실되지 않는다.
    console.warn(
      `[wireHashtagConcepts] 별칭 '${tag}' 가 2명+ 사람에 겹쳐 모호 — ` +
        `연결 보류 (origin ${originNodeId})`,
    );
    return { kind: "ambiguous" };
  }
  if (lookup.person) {
    await store.addNodePersonEdge(
      originNodeId,
      lookup.person.personId,
      "mentions",
      "hashtag",
      originNodeId,
    );
    return { kind: "person", personId: lookup.person.personId };
  }

  // ── 결정 2 — 전 엔티티 타입 인스턴스 흡수(사람 조회와 개념 폴백 사이) ──────────
  const entityHits = await lookupEntityInstances(store, tag);
  if (entityHits.length > 1) {
    // 여러 타입에 같은 이름 — 어느 엔티티인지 모호하다(작품 "바라"·프로젝트 "바라").
    // 사람 별명 모호 갈래와 같은 정신으로 굳히지 않고 보류·경고한다(silent fallback
    // 금지·태그·origin·후보 타입 포함). origin 노드는 이미 저장돼 글 유실 0.
    const typeList = entityHits.map((h) => h.typeName).join(", ");
    console.warn(
      `[wireHashtagConcepts] 태그 '${tag}' 가 여러 엔티티 타입에 같은 이름으로 ` +
        `겹쳐 모호(${typeList}) — 연결 보류 (origin ${originNodeId})`,
    );
    return { kind: "ambiguous" };
  }
  if (entityHits.length === 1) {
    const hit = entityHits[0]!;
    const conceptId = await linkEntityToOrigin(store, originNodeId, hit);
    return {
      kind: "entity",
      match: { typeName: hit.typeName, entityId: hit.entityId, conceptId },
    };
  }

  // 사람·엔티티 어느 것도 아님(키워드·분류값) → 개념 노드만 확보(결정 4 폴백 보존).
  // origin↔tag 엣지는 잎 판정 뒤 호출자가 붙인다.
  const conceptId = await store.findOrCreateTagConcept(tag);
  return { kind: "concept", conceptId };
}

/**
 * 주어진 origin 노드에 `#태그` 개념 노드·엣지를 연결한다.
 *
 * 흐름:
 *   1. parseTags(rawContent) → tags(cleanContent 는 안 쓴다 — LLM 입력 정제는 별 책임).
 *   2. tags 0개면 wiring 0 — 빈 결과를 정직하게 반환한다(real empty state — `#` 없는
 *      평범한 글은 태그 개념 노드를 만들지 않는다). 강제 빈 노드·빈 엣지 0.
 *   3. 각 태그를 resolveTagAsPersonOrConcept 로 사람/개념/모호 갈래 해석(F4 / Q23 +
 *      별명 spec §3.2):
 *      - 본명 정확 매칭 또는 별명 단일 매칭으로 사람 확정 → origin↔사람 mentions,
 *        개념 노드 0.
 *      - 별명이 2명+ 에 겹쳐 모호 → 사람·개념 둘 다 안 만들고 보류·경고(아래 어디에도
 *        안 모음). origin 노드는 보존돼 글은 유실되지 않는다.
 *      - 없으면 → findOrCreateTagConcept 로 개념 노드만 확보(tag 엣지는 4단계로 미룸).
 *   4. 잎(leaf) 판정(spec §4.2 I2) — 개념으로 해석된 conceptId 집합 S 에서
 *      getHierarchyEdgesWithin(S) 로 "입력 집합 안 다른 태그의 부모"를 가려내고,
 *      누구의 부모도 아닌 잎에만 origin↔개념 tag 엣지를 붙인다. 부모 태그는 노드만
 *      만들어지고 글에는 안 붙는다. 잎이 0개가 되는 cycle(양방향 위계)이면 글이
 *      검색에서 사라지지 않도록 S 전부를 평평하게 붙이되 console.warn 으로 신호한다
 *      (silent fallback 금지 — conceptId 목록 포함). 콜론 없는 나열은 위계(parent_of)
 *      자체를 만들지 않는다 — 위계는 콜론 선언(`#작품:만화`)에서만 생긴다(spec §4.1 I1).
 *   5. 사람 mentions 든 개념 노드·엣지든 하나라도 생기면
 *      trigger.emit('hashtag-concept-added').
 *
 * idempotent: findOrCreateTagConcept(이름 UNIQUE) / addNodeConceptEdge(INSERT OR
 * IGNORE) / addConceptEdge(INSERT OR IGNORE) / addNodePersonEdge(INSERT OR IGNORE)
 * 라 같은 origin·같은 태그로 2회 호출해도 노드·엣지 중복 0.
 *
 * 별 본문 노드(tag_body) 를 만들지 않는다 — origin 노드 하나에만 태그를 연결한다.
 */
export async function wireHashtagConcepts(
  store: SqliteMemoryStore,
  originNodeId: number,
  rawContent: string,
  options: WireHashtagConceptsOptions = {},
): Promise<WireHashtagConceptsResult> {
  const { tags } = parseTags(rawContent);
  if (tags.length === 0) {
    return { tagConceptIds: [], personMentionIds: [], entityMatches: [] };
  }

  const tagConceptIds: string[] = [];
  const personMentionIds: string[] = [];
  const entityMatches: ResolvedEntityMatch[] = [];
  for (const tag of tags) {
    const resolved = await resolveTagAsPersonOrConcept(store, originNodeId, tag);
    if (resolved.kind === "person") {
      personMentionIds.push(resolved.personId);
    } else if (resolved.kind === "entity") {
      // 엔티티 흡수 — 그 엔티티의 정체성 개념에 origin 이 이미 붙었다(linkEntityToOrigin).
      // 개념 폴백 잎 판정에 넣지 않는다(키워드 개념이 아니라 엔티티 정체성 노드라
      // 콜론 위계 잎 판정 대상이 아니다 — 엔티티는 origin 에 직접 tag 엣지로 붙는다).
      entityMatches.push(resolved.match);
    } else if (resolved.kind === "concept") {
      tagConceptIds.push(resolved.conceptId);
    }
    // kind === "ambiguous" → 사람·엔티티·개념 다 안 만든다(경고는 resolve 안에서 끝).
  }

  // ── 잎(leaf) 판정 (spec §4.2 I2) ──────────────────────────────────────
  // 입력 집합 S 안에서 다른 입력 태그의 부모(parent_of 의 source)로 등장한 태그는
  // 분류 축이지 글의 직접 주제가 아니므로 글↔tag 엣지를 안 만든다. 누구의 부모도
  // 아닌 잎만 origin 에 붙인다. 판정은 입력 집합 안에서만 본다(전역 트리 아님 / D3).
  if (tagConceptIds.length > 0) {
    // S0-T4(위계 단일 출처) — 옛 getParentOfEdgesWithin(concept_edges)에서
    // hierarchy_edges 짝 getHierarchyEdgesWithin 으로 옮긴다. 양 끝이 입력 집합 안인
    // parent_of 만 회신하는 계약은 같다 — 끝점 칸이 sourceId/targetId 로 바뀐다.
    const withinEdges = store.getHierarchyEdgesWithin(tagConceptIds);
    const parents = new Set(withinEdges.map((e) => e.sourceId));
    let leaves = tagConceptIds.filter((id) => !parents.has(id));

    // cycle 방어(§4.2.3 / D4): 양방향 위계로 잎이 0개가 되면 글이 검색에서
    // 사라진다. 전체를 평평하게 붙이되 silent 가 아니라 loud warn 으로 신호한다.
    if (leaves.length === 0) {
      console.warn(
        `[wireHashtagConcepts] cycle 로 잎이 0개 — 전체를 평평하게 붙임 ` +
          `(conceptIds: [${tagConceptIds.join(", ")}], origin ${originNodeId})`,
      );
      leaves = [...tagConceptIds];
    }

    for (const conceptId of leaves) {
      await store.addNodeConceptEdge(originNodeId, conceptId, "tag", "hashtag", originNodeId);
    }
  }

  options.trigger?.emit("hashtag-concept-added");

  return { tagConceptIds, personMentionIds, entityMatches };
}

/**
 * wireHashtagConcepts 를 실패 격리해 가동한다 — 입력 통로 여러 곳(save-input plain·
 * immediate / from-text 라우트)이 공유하는 단일 안전 래퍼.
 *
 * wiring 실패(findOrCreateTagConcept throw 등)는 삼키지 않고 구체 warn 후 진행한다 —
 * origin 노드 저장은 이미 끝났으므로 원본 유실 0(silent fallback 금지 정신: 실패를
 * "태그 0개"로 위장하지 않고 태그·노드 id 를 warn 에 남긴다 — CLAUDE.md "실패 ≠ 빈
 * 결과"). 태그 wiring 실패가 입력 저장을 통째 깨지 않게 격리한다.
 *
 * @param label warn 메시지 출처 라벨(호출 통로 식별 — 예: 'saveTextInput' / 'from-text').
 */
export async function wireHashtagConceptsSafe(
  store: SqliteMemoryStore,
  originNodeId: number,
  content: string,
  trigger: AutoCleanupTriggerHandle | undefined,
  label: string,
): Promise<void> {
  try {
    await wireHashtagConcepts(store, originNodeId, content, { trigger });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const { tags } = parseTags(content);
    console.warn(
      `[${label}] 태그 wiring 실패 (${errMsg}) — 원본 ${originNodeId} 는 보존, ` +
        `태그 [${tags.join(", ")}] 개념 연결 누락`,
    );
  }
}
