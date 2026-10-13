/**
 * row-and-alias.ts — 1급 행 생성·별칭 등록·사람 글 작품 연결(entity-placement-loop 에서
 * 분리·G5-a).
 *
 * entity-placement-loop.ts 가 1409줄로 800줄 하드 상한을 넘겨 책임 경계로 하위 모듈에
 * 코드를 옮겼다(동작 0 변화 — 코드 이동만). 이 모듈은 store 에 행·별칭·mention 을 실제로
 * 쓰는 헬퍼를 모은다:
 *   - createRowForPlacement — work 만 매체·작가 정체성 키로 넓힌 행 생성(나머지 공통 게이트).
 *   - readEntityKoAliases·updateEntityKoAliases·registerAliasesFromAliasTags — 별칭 등록(멱등).
 *   - connectPersonDocWork — 사람 주체 글의 작품 선언을 행 생성 없이 기존 작품에 mention 연결.
 */

import type { SqliteMemoryStore } from "../../db/store.ts";
import type { EntityTypeClassification } from "../entity-type-classifier.ts";
import {
  createEntityRowIfNeeded,
  shouldCreateEntityRow,
  type CreatedEntityRow,
} from "../entity-row-gate.ts";
import { parseHashtagEntities } from "../parsers/hashtag-entity-parser.ts";
import type { EntityTypeName } from "../../db/store-internal/entity-type-registry.ts";
import { workLeafConceptName } from "../work-leaf-concept-key.ts";
import { extractFirstAuthorValue } from "./candidate-attributes.ts";
import type { EntityPlacementResult } from "./placement-result.ts";

/**
 * 신규 8 타입 행의 현재 ko_aliases 를 읽는다 — 별칭 등록 멱등(합집합)에 쓴다.
 * 타입→get facade 가르기를 한 곳에 모은다(createEntityRow switch 와 같은 양식·단일 출처).
 * person/project 는 이 통로 밖이라 다루지 않는다(신규 8 타입 전용). 행이 없으면 null.
 */
async function readEntityKoAliases(
  store: SqliteMemoryStore,
  _typeName: EntityTypeName,
  id: string,
): Promise<string[] | null> {
  // 단계4 T4 — 전용 테이블 흡수 뒤 별칭은 범용 본체 entitiesRepo.get(id).koAliases 단일
  // 출처다(타입별 getX switch 제거). 행이 없으면 null(거짓 별칭 0). _typeName 은 호출처
  // 의도 표시용으로 시그니처에 남긴다(엔티티 id 전역 UNIQUE 라 조회 키는 id 단독).
  return (await store.entitiesRepo.get(id))?.koAliases ?? null;
}

/**
 * 신규 8 타입 행의 ko_aliases 를 통째 저장한다 — 단계4 T4 가 타입별 update facade switch 를
 * 범용 entitiesRepo.setKoAliases 한 통로로 모았다(전용 테이블 흡수·결정 2). setKoAliases 가
 * 별칭을 entity_attributes(is_column=1)에 JSON 으로 넣어 합성 색인에 합류시킨다. 호출처가
 * 기존 배열과 합집합을 만들어 넘긴다(이 함수는 받은 배열을 그대로 저장). person/project 는 밖.
 */
async function updateEntityKoAliases(
  store: SqliteMemoryStore,
  _typeName: EntityTypeName,
  id: string,
  koAliases: string[],
): Promise<void> {
  store.entitiesRepo.setKoAliases(id, koAliases);
}

/**
 * 엔티티 별칭 등록 — `#별명:`/`#닉네임:` 콜론 태그에서 모은다
 * (2026-06-13 어휘 독립 다단계 위계 §13 재배선·V8).
 *
 * 옛 6/11 (가)는 *사슬 끝 본체 이름을 키로 한 콜론 태그*(`#데뷔못...:데못죽`)를 별칭으로
 * 봤다. §5.2 하이브리드가 같은 입력을 위계로 해석하므로(데못죽이 데뷔못...의 하위 개념),
 * 그 "본체 키 = 별칭" 표기는 폐기한다. 이제 별칭은 명시 예약 키 `#별명:`·`#닉네임:`
 * (hashtag-reserved-keys 의 kind:"alias")로만 적는다 — parseHashtagEntities 의 aliases
 * 갈래가 그 value 를 이미 모은다(단일 출처 재사용·키 비교 하드코딩 0).
 *
 * 행이 생겼을 때만 부른다(행이 없으면 별칭을 붙일 대상이 없다 — 거짓 별칭 0). 멱등(합집합)
 * — 행의 현재 ko_aliases 를 읽어 새 별칭을 합집합으로 더한다(덮어쓰기 아님). 같은 글을 두
 * 번 처리해도 별칭 중복 0. 별칭 후보가 0개면 update 를 건너뛴다(정직).
 *
 * 검색 측 합류는 안 한다 — 입력 시점 ko_aliases 저장까지만(Deferred 유지·설계·경고 아님).
 * §14.3 ③(사람·엔티티 양쪽 귀속 모호) 차단은 호출처(§5.5)가 personAliasWouldConsume 로
 * 게이트한다 — 이 함수는 그 게이트를 통과한 뒤 순수하게 별칭만 등록한다.
 *
 * @returns 등록한(합집합으로 새로 더해진) 별칭 수.
 */
export async function registerAliasesFromAliasTags(
  store: SqliteMemoryStore,
  typeName: EntityTypeName,
  entityId: string,
  content: string,
): Promise<number> {
  // 별칭 모으기 — `#별명:`/`#닉네임:` alias 예약 키 콜론 태그의 value(단일 출처 파서).
  const aliasCandidates: string[] = [];
  for (const alias of parseHashtagEntities(content ?? "").aliases) {
    const trimmed = alias.trim();
    if (trimmed) aliasCandidates.push(trimmed);
  }
  if (aliasCandidates.length === 0) return 0;

  // 기존 별칭과 합집합(멱등) — 소문자 키로 중복을 거르되 원본 표기는 보존한다.
  const existing = (await readEntityKoAliases(store, typeName, entityId)) ?? [];
  const seen = new Set(existing.map((a) => a.trim().toLowerCase()));
  const merged = [...existing];
  let added = 0;
  for (const alias of aliasCandidates) {
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(alias);
    added += 1;
  }
  if (added === 0) return 0; // 전부 이미 있던 별칭 — update 생략(멱등).

  await updateEntityKoAliases(store, typeName, entityId, merged);
  return added;
}

/**
 * 한 선언의 1급 엔티티 행을 만든다 — work 만 매체·작가 정체성 키로 넓힌다(P3-B3).
 *
 * 8 타입 공통은 기존 createEntityRowIfNeeded(게이트 + facade 위임) 그대로라 creature·thing
 * 등은 변동 0. work 일 때만:
 *  - shouldCreateEntityRow(entity-row-gate 의 export 된 순수 판정·결정 A·B)를 직접 호출해
 *    통과 여부를 받는다. entity-row-gate.ts 는 한 줄도 안 고친다(H8 0 diff·판정 재사용).
 *  - 통과면 공통 createEntityRow 대신 store.entitiesRepo.findOrCreateEntity("work", name,
 *    { medium, createdBy })를 직접 불러 work 정체성(4-tuple)을 넓힌다(단계4 T4 범용 통로).
 *    medium = classification.subcategory(= categoryChain[0]·첫 분류 단). 미입력이면 null.
 *    author = 같은 글의 작가 관계 태그(created_by 동의어) 첫 값(content 전체 시야 — 작가 태그는
 *    관계 wiring 과 같은 글 스코프라 subContent 가 아니라 content 에서 읽어 일관성을 맞춘다).
 *  - 불통과면 null(행 X·경고는 호출처가 남긴다) — 기존 게이트 불통과와 동일.
 *
 * @param hasAttributes 이 항목에 속성 태그가 함께 걸렸나 — 결정 A 게이트 입력.
 * @param content       글 원문 — work 작가 값을 관계 wiring 과 같은 시야에서 뽑는다.
 * @param isMidChain    구조 신호 — candidateName 이 사슬 중간 마디인가(§6-B·단계2 D1).
 *                      true 면 게이트가 어휘 무관하게 행 0(I2). 콜론 통로는 chainEntriesOf
 *                      가 중간 마디를 진입점에서 이미 걸러 candidateName 이 대개 leaf 라 이
 *                      신호는 방어적 이중 안전이다(회귀 0).
 */
export async function createRowForPlacement(
  store: SqliteMemoryStore,
  typeName: EntityTypeName,
  candidateName: string,
  classification: EntityTypeClassification,
  hasAttributes: boolean,
  content: string,
  isMidChain: boolean,
): Promise<CreatedEntityRow | null> {
  const gateArgs = {
    typeName,
    candidateName,
    source: classification.source,
    hasAttributes,
    subcategory: classification.subcategory,
    isMidChainNode: isMidChain,
  };

  if (typeName !== "work") {
    // 공통 8 타입 — 기존 게이트 + facade 위임 그대로(변동 0).
    return createEntityRowIfNeeded(store, gateArgs);
  }

  // work — 게이트 판정만 재사용하고(H8 0 diff) work facade 를 직접 불러 정체성 키를 넓힌다.
  const gate = shouldCreateEntityRow(gateArgs);
  if (!gate.create) return null;

  // medium 은 이 그룹 사슬의 분류 단이라 classification.subcategory 가 맞다. author 는 content
  // 전체에서 뽑는다 — 작가는 정체성 키지 라벨 속성이 아니라, subContent(이 타입 속성만 담긴
  // 조각)에서 읽으면 work 속성 어휘에 작가 키가 우연히 들어 있어야만 살아남는 우연 결합이 된다.
  // content 전체 스코프는 관계 wiring 과 같은 시야라 일관되고, 어휘 등록과 무관하게 안정적이다.
  // 정상 입력 = 한 글 작품 하나·작가 하나라 content 전체 첫 작가가 그 work 의 작가와 일치한다.
  // 한 글 작품 여럿·작가 여럿이면 첫 작가를 적용하는 한계는 입력 양식 차원의 별도 문제다(후속).
  const medium = classification.subcategory ?? undefined;
  const author = extractFirstAuthorValue(content);
  if (medium === undefined && author === undefined) {
    const lookup = await store.entitiesRepo.findByNameOrAlias("work", candidateName);
    if (lookup.ambiguous) return null;
    if (lookup.entity) {
      return { id: lookup.entity.id, name: lookup.entity.name, typeName };
    }
  }
  // 단계4 T4 — 전용 work facade 가 사라져 범용 본체로 work 정체성(medium·createdBy)을 넓힌다.
  // findOrCreateEntity 의 work 분기가 (name, medium, created_by) 4-tuple UNIQUE 로 가른다.
  const row = await store.entitiesRepo.findOrCreateEntity("work", candidateName, {
    medium,
    createdBy: author,
  });
  return { id: row.id, name: row.name, typeName };
}

/**
 * 사람 주체 글의 작품 선언을 *행 생성 없이* 기존 동명+작가 작품에 연결한다 — P4 재정의(글 주체).
 *
 * 글에 `#사람:` 선언이 있으면(사람 주체 글) 그 글의 `#작품:` 은 새 work 행을 만들지 않는다.
 * 대신 같은 글의 사람을 작가로 보고(직업 라벨 무관·같은 글 사람=작가), 기존에 등록된
 * 동명+작가 작품에 *글→작품 mention* 만 세운다. 이 mention 은 행 생성 경로(placeOneEntityType
 * 5-L1 단)가 쓰는 것과 *똑같은* 통로다 — 새 엣지 종류·새 테이블 0:
 *   1. 그 작품 이름의 잎 개념(findOrCreateConcept·isClassificationValue) — 행 생성 때 만든 것과
 *      같은 개념 노드(이름 UNIQUE 라 같은 노드). identity 엣지(행 ↔ 잎-개념)는 이미 그 작품
 *      행에 붙어 있다(작품 글이 등록할 때 linkEntityIdentity 가 세웠다).
 *   2. addNodeConceptEdge(originNodeId, 잎-개념, "classification") — 이 글이 그 작품을 언급한다는
 *      mention. graph-augment 가 글→1급엔티티(work)를 띄우는 데이터 출처(글↔잎개념 + identity
 *      역조회)를 그대로 탄다.
 *
 * 위계·created_by 칸·work 행은 손대지 않는다(기존 작품 것 유지). 동명+작가 작품이 여럿이면
 * (매체가 달라 괴담 소설·괴담 웹툰 둘 다 백덕수) 모두 연결한다. 없으면 무동작 + 정직한 경고
 * (거짓 행 0·silent 차단). author 가 비면(작가 미상 글) 연결 대상을 못 가려 경고만 남긴다.
 *
 * @param store        실제 SqliteMemoryStore.
 * @param originNodeId 사람 주체 글 노드 id.
 * @param workName     `#작품:` 선언 값(작품 이름).
 * @param author       같은 글의 `#사람:` 첫 사람 display_name(작가 후보).
 * @param result       누적 결과 — 연결은 행 생성이 아니라 entityId 를 채우지 않고, 무동작 사유만
 *                     warnings 에 남긴다(연결 수는 반환값으로 알린다).
 * @returns 연결한 작품 행 수(0이면 동명+작가 작품 없음·무동작).
 */
export async function connectPersonDocWork(
  store: SqliteMemoryStore,
  originNodeId: number,
  workName: string,
  author: string,
  result: EntityPlacementResult,
): Promise<number> {
  const name = workName.trim();
  if (!name) return 0;
  const trimmedAuthor = author.trim();
  if (!trimmedAuthor) {
    result.warnings.push(
      `사람 글의 작품 '${name}' — 작가를 못 가려(사람 선언 값이 빔) 연결 안 함`,
    );
    return 0;
  }

  // 단계4 T4 — 전용 work facade 가 사라져 범용 본체 findByNameAndAuthor(entities·type_name
  // ='work')로 동명+작가 행을 모두 조회한다. 회신 UserEntity 는 name·medium·createdBy 를
  // 그대로 노출하므로 아래 잎 개념 키 재현이 옛 Work view 와 동일하게 동작한다.
  const works = store.entitiesRepo.findByNameAndAuthor(name, trimmedAuthor);
  if (works.length === 0) {
    result.warnings.push(
      `사람 글의 작품 '${name}' — 등록된 동명+작가('${trimmedAuthor}') 작품 없어 연결 안 함`,
    );
    return 0;
  }

  // 각 동명+작가 작품에 글→작품 mention 을 세운다(행 생성 때와 같은 잎 개념·classification mention).
  // result.entityId 는 채우지 않는다 — 연결은 행 생성이 아니라(entityRowCreated=false), entityId 를
  // 채우면 두 필드를 함께 읽는 호출처가 "행 생성됨"으로 오인한다. 연결 수는 반환값으로만 알린다.
  let connected = 0;
  for (const work of works) {
    // 그 work 의 분리 잎 개념에 정확히 닿으려면 생성 측과 *같은* 키를 써야 한다(드리프트 0).
    // work 행이 가진 medium·createdBy 칸(B1 읽기 노출)으로 workLeafConceptName 단일 출처에
    // 같은 매체·작가를 넘긴다 — 생성 측이 만든 그 분리 개념 노드를 이름 UNIQUE 로 재조회한다.
    const leafName = workLeafConceptName(work.name, work.medium, work.createdBy);
    const leafConceptId = await store.findOrCreateConcept(leafName, {
      isClassificationValue: true,
    });
    // identity 엣지·원래 이름 별칭은 그 작품 행이 등록될 때 이미 붙어 있다(생성 단 책임) —
    // 여기선 글 mention 만 멱등하게 더한다.
    await store.addNodeConceptEdge(
      originNodeId,
      leafConceptId,
      "classification",
      "hashtag",
      originNodeId,
    );
    connected += 1;
  }
  return connected;
}
