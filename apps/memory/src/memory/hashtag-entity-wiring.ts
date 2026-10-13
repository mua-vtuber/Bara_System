/**
 * hashtag-entity-wiring.ts — 해시태그 엔티티 wiring (공통 인프라 1.2 T10).
 *
 * Task 9 파서(`parseHashtagEntities`)가 가른 네 갈래(사람 선언·프로젝트 선언·
 * 고유 사실 칸·라벨·별칭)를 실제 데이터로 잇는다 — persons/projects 행, 고유 사실
 * 칸, 라벨 엣지, 별칭. `hashtag-wiring.ts::wireHashtagConcepts` 의 양식을 그대로
 * 따른다(같은 store·origin·content·{trigger} 입력 + Safe 래퍼).
 *
 * 칸-vs-라벨 통일 원칙(spec 3.7.1·3.7.3, Q21/Q22) — 이 모듈의 핵심:
 *   - 고유 사실 칸(생일·주소·성별)·별칭은 *한 사람 고유* 라 정확히 1명일 때만 붙는다.
 *     `#사람:` 선언이 1개면 그 사람에게 칸·별칭을 채운다. 0·2+면 주 엔티티가 모호 —
 *     아무에게도 안 붙이고 경고만 남긴다(임의 귀속 금지, CLAUDE.md "실패 ≠ 빈 결과"
 *     정신: 모호는 거짓 채움이 아니라 정직한 경고).
 *   - 라벨(직업·회사 등)은 *공유 특성* 이라 선언된 *모든* 사람에게 붙는다(Q22). 칸의
 *     모호와 무관하게 독립으로 적용한다 — `#사람:철수 #사람:민수 #생일:.. #직업:..`
 *     이면 직업은 둘 다, 생일은 모호 경고로 아무에게도 안 붙는다. 칸 없이 라벨만 있어도
 *     선언된 사람에게 등록된다(Q21 — 라벨만으로 등록).
 *   - 등록 신호(고유 사실·별칭·라벨)가 하나도 없고 `#사람:` 이 1명 이상이면 사건 글 —
 *     각 사람을 origin 에 mentions 로만 잇는다.
 *   - 등록 글의 주 사람(`#사람:` 이 정확히 1명)은 검색 정합을 위해 origin 에 mentions
 *     엣지도 한 개 받는다 — 라벨 등록("철수는 개발자다")이든 고유 사실만 있는 등록
 *     (`#사람:이몽룡 #생일:..`)이든, 그 글이 사람에 매달리고 사람 이름 검색에도 떠야
 *     하기 때문이다(사용자 결정 2026-06-15·성춘향 케이스와 일관). `#사람:` 이 2명+ 라
 *     주 사람이 모호하면 mentions 도 안 단다(추정 귀속 금지). 한 사람당 mentions 엣지는
 *     정확히 하나(중복 없음).
 *
 * 프로젝트 선언(`#프로젝트:바라`) → findOrCreateProject + origin.project_id 설정 +
 * 라벨 엣지(classification·tag 두 role 겸용, Q4). 프로젝트가 선언됐으면 라벨은
 * 프로젝트로 가고(사람 라벨 경로와 갈린다), 프로젝트가 없으면 선언된 사람 전원으로 간다.
 *
 * 선언된 사람의 신원은 표시 이름 기준(findOrCreatePersonByName) — 작성자 userId 를
 * 찍지 않는다([[attribution-three-axes]]: 의미 채널 사람 ≠ 귀속 축 작성자).
 *
 * 정직한 파싱 실패(spec 3.7.4): Task 9 가 올린 `errors` 를 warnings 로 그대로
 * 흘린다. 깨진 태그가 있어도 정상 태그는 계속 처리한다.
 *
 * LLM 호출 0 — 순수 규칙 wiring. RRF 코어(검색 점수)는 한 줄도 건드리지 않는다
 * (입력 시점 데이터 채움이지 검색 점수 계산이 아니다).
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import type { AutoCleanupTriggerHandle } from "./auto-cleanup-trigger.ts";
import type { ClassificationTag } from "./parsers/classification-tag.ts";
import type { Person } from "./types.ts";
import { parseHashtagEntities } from "./parsers/hashtag-entity-parser.ts";
import { parseTags } from "./tag-extractor.ts";
import { reflowFlatParentTags, REFLOW_TRIGGER_LABEL } from "./tag-reflow.ts";
import { entityRowWouldBeCreated } from "./alias-attribution.ts";
import { isTypeIndicatorKey } from "./entity-type-classifier.ts";
import { lookupRelationTag } from "./entity-relation-vocabulary.ts";
import { extractEventDateTime } from "./event-date.ts";
import { splitDateRange } from "./date-range-split.ts";
import {
  getTypeAttributes,
  subcategoryToTypeMap,
} from "./concept-type-vocabulary.ts";
import {
  projectChainConsumedKeys,
} from "./entity-placement-loop.ts";
import type { Provenance } from "./provenance-vocabulary.ts";
import { resolveProjectDeclaration } from "./project-hashtag-resolver.ts";

/**
 * 콜론 키(rawCategory)가 person 위계 사슬을 *전담하는* 관계 어휘 키(가족·친구)인지 —
 * lookupRelationTag(entity-relation-vocabulary 단일 출처)가 family_of/friend_of 를 주는가.
 *
 * person-relation-chain(wirePersonHierarchy→wireRelationChains)이 `#가족:엄마` 의 "가족"을
 * 관계 사슬(가족→엄마→성춘향 + 소유자 family_of)로 이미 완전히 표현하므로, 같은 키를 person
 * 라벨로도 처리하면 성춘향↔엄마 has_attribute 가 잉여로 붙는다. 라벨 필터가 이 키를 빼
 * 잉여를 막는다(관계 정보는 사슬이 보존·중복 0). 키 하드코딩 0 — lookupRelationTag 가 어휘
 * 단일 출처라 가족·친구·친족 동의어가 한 곳에서 관리된다.
 */
function isRelationKey(rawCategory: string): boolean {
  return lookupRelationTag((rawCategory ?? "").trim()) !== null;
}

function isPlacementDeclarationKey(rawCategory: string): boolean {
  const key = (rawCategory ?? "").trim();
  if (isTypeIndicatorKey(key)) return true;
  return subcategoryToTypeMap().has(key.toLowerCase());
}

/** `wireHashtagEntities` 의 추가 옵션 — wireHashtagConcepts 와 같은 모양. */
export interface WireHashtagEntitiesOptions {
  /**
   * 의미 채널 사람 선언은 작성자 신원과 분리돼(위 모듈 주석) 선언된 사람에게
   * userId 를 찍지 않는다. 이 옵션은 wireHashtagConcepts 와 양식을 맞추려 둔
   * 것이며, 위 설계상 선언 사람 신원 경로에서는 쓰지 않는다(귀속 축은
   * save-input 의 linkAuthorPerson 담당).
   */
  userId?: string;
  /**
   * 엔티티 신규 작성 시 송출할 데이터 변동 trigger. 미지정 시 no-op.
   * wireHashtagConcepts 의 'hashtag-concept-added' 양식을 그대로 받는다.
   */
  trigger?: AutoCleanupTriggerHandle;
  /**
   * 직접 입력 칸(#날짜·#일정시작·#일정종료) → event_at·event_until 풀이의 기준 시각.
   * 호출처가 입력 시점 new Date() 를 주입한다. 미주입이면 directFields wiring 만
   * graceful skip(경고 남김) — 엔티티 wiring 본체는 그대로 돈다.
   */
  now?: Date;
  /** 관계/라벨 출처. origin 노드가 없는 엔티티 프로필 패치는 user_input 을 쓴다. */
  provenance?: Provenance;
}

/** `wireHashtagEntities` 의 반환값. */
export interface WireEntityResult {
  /** findOrCreatePersonByName 으로 잇힌 사람 personId 목록(입력 순서). */
  personIds: string[];
  /** 선언·연결된 프로젝트 projectId(없으면 null). */
  projectId: string | null;
  /** 주 엔티티에 붙은 고유 사실 칸 개수(모호로 안 붙으면 0). */
  attributesApplied: number;
  /** 주 엔티티에 붙은 라벨 개수(주 엔티티 없으면 0). */
  labelsApplied: number;
  /** 정직한 경고(파싱 실패 + 주 엔티티 모호). 빈 배열이면 깨끗. */
  warnings: string[];
}

/**
 * 한 라벨(`#직업:개발자`)을 개념으로 만들어 value 개념 id 를 돌려준다.
 *
 * addClassificationTag 선례 그대로 — category 개념(isClassificationKey) + value
 * 개념(isClassificationValue) + 둘 사이 parent_of(weight 0.9 — 콜론 선언 확정 위계)
 * 엣지. 주 엔티티에 잇는 대상은 value 개념(예: '개발자')이다.
 *
 * S0-T4(위계 단일 출처) — category→value parent_of 위계는 옛 concept_edges 가
 * 아니라 새 단일 출처 hierarchy_edges 에 쓴다(양 끝 개념). reflow 는 글↔개념 tag
 * 엣지 위에서 도는 별 통로라 그대로 가동한다.
 */
async function ensureLabelValueConcept(
  store: SqliteMemoryStore,
  label: ClassificationTag,
  provenance: Provenance,
  sourceNodeId: number | null,
): Promise<string> {
  const categoryId = await store.findOrCreateConcept(label.category, {
    isClassificationKey: true,
  });
  const valueId = await store.findOrCreateConcept(label.value, {
    isClassificationValue: true,
  });
  const hierarchy = store.addReducedHierarchyEdge({
    sourceType: "concept",
    sourceId: categoryId,
    targetType: "concept",
    targetId: valueId,
    provenance,
    sourceNodeId,
    // 콜론 라벨은 사용자의 명시 선언이라 추측이 아닌 확정 강도 0.9 로 시작한다.
    weight: 0.9,
  });
  if (hierarchy.skippedAsShortcut) return valueId;
  // 위계 선언 직후 과거 평평 글 자동 재정리(spec §4.2.3 B3 — 검토 게이트 없음).
  // 상위 실패(findFlatParentTagNodes DB 오류 등) 격리 — 자동 정리가 깨져도 라벨 등록
  // 자체는 유지한다(글 단위 격리와 같은 정신, silent 아님 / §4.2.4).
  try {
    await reflowFlatParentTags(store, categoryId, valueId, REFLOW_TRIGGER_LABEL);
  } catch (err) {
    console.warn(
      `[hashtag label reflow] 자동 재정리 실패 — 라벨 등록은 유지 ` +
        `(parent ${categoryId}, label ${label.category}:${label.value}): ${String(err)}`,
    );
  }
  return valueId;
}

async function findOrCreatePersonByNameOrAlias(
  store: SqliteMemoryStore,
  name: string,
  warnings: string[],
): Promise<Person | null> {
  const lookup = await store.findPersonByNameOrAlias(name);
  if (lookup.ambiguous) {
    warnings.push(`사람 별칭 '${name}' 이 2명+에 겹쳐 모호 — 사람 정보 미반영`);
    return null;
  }
  if (lookup.person) return lookup.person;
  return store.findOrCreatePersonByName(name);
}

async function addEntityKoAliases(
  store: SqliteMemoryStore,
  entityId: string,
  aliases: string[],
): Promise<number> {
  const trimmedAliases = aliases.map((a) => a.trim()).filter((a) => a.length > 0);
  if (trimmedAliases.length === 0) return 0;
  const entity = await store.entitiesRepo.get(entityId);
  if (!entity) return 0;
  const seen = new Set(entity.koAliases.map((a) => a.trim().toLowerCase()));
  const merged = [...entity.koAliases];
  let added = 0;
  for (const alias of trimmedAliases) {
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(alias);
    added += 1;
  }
  if (added > 0) store.entitiesRepo.setKoAliases(entityId, merged);
  return added;
}

/**
 * 라벨(공유 특성)을 선언된 모든 사람에게 붙인다(Q22).
 *
 * 각 라벨 value 개념을 한 번만 만들고(ensureLabelValueConcept), 선언된 사람마다
 * findOrCreatePersonByName → addPersonAttributeConcept 로 잇는다. 같은 이름이 두 번
 * 선언되면 한 사람으로 합쳐 라벨·mentions 를 한 번만 적용한다(seenNames 로 dedup).
 *
 * 붙인 라벨 수는 `onLabelApplied`(사람×라벨 1회마다), 잇힌 사람은 `onPersonLinked`
 * (사람당 1회, mentions 엣지 정합 담당)로 호출자에 알린다. 호출자가 result 누계와
 * mentions dedup 을 한 곳에서 쥐도록 콜백으로 가른다.
 */
async function applyLabelsToDeclaredPersons(
  store: SqliteMemoryStore,
  provenance: Provenance,
  sourceNodeId: number | null,
  personDeclarations: string[],
  labels: ClassificationTag[],
  warnings: string[],
  hooks: {
    onLabelApplied: () => void;
    onPersonLinked: (personId: string) => Promise<void>;
  },
): Promise<void> {
  // value 개념은 사람 수와 무관하게 라벨당 한 번만 만든다.
  const valueConceptIds: string[] = [];
  for (const label of labels) {
    valueConceptIds.push(
      await ensureLabelValueConcept(store, label, provenance, sourceNodeId),
    );
  }

  const seenPersonIds = new Set<string>();
  for (const name of personDeclarations) {
    const person = await findOrCreatePersonByNameOrAlias(store, name, warnings);
    if (!person || seenPersonIds.has(person.personId)) continue;
    seenPersonIds.add(person.personId);
    await hooks.onPersonLinked(person.personId);
    for (const valueConceptId of valueConceptIds) {
      await store.addPersonAttributeConcept(
        person.personId,
        valueConceptId,
        provenance,
        sourceNodeId,
      );
      hooks.onLabelApplied();
    }
  }
}

/**
 * 주어진 origin 노드에 해시태그 규칙 입력의 엔티티(사람·프로젝트·사실·라벨)를 잇는다.
 *
 * 흐름:
 *   1. parseHashtagEntities(content) → 네 갈래 + 라벨 + errors.
 *   2. errors 를 warnings 로 흘린다(정직한 파싱 실패).
 *   3. 프로젝트 선언이 있으면 findOrCreateProject + origin.project_id 설정.
 *   4. 고유 사실 칸/별칭 — 프로젝트가 주 엔티티가 아니고 `#사람:` 이 정확히 1개면 그
 *      사람에 사실(updatePersonFacts)·별칭(addPersonAlias)을 붙이고 origin 에 mentions
 *      로 잇는다(등록 글이 그 사람에 매달리고 사람 검색에 합류 — 2026-06-15). 0·2+면
 *      모호 경고, 칸·별칭·mentions 미반영(고유 사실은 한 사람만·추정 귀속 금지).
 *   5. 라벨 — 프로젝트가 선언됐으면 프로젝트로 두 role 겸용(addProjectConceptEdge,
 *      Q4). 아니고 `#사람:` 이 1명 이상이면 선언된 사람 전원에 붙이고(Q22) 각 사람을
 *      origin 에 mentions 로 잇는다(검색 정합). 사람·프로젝트 둘 다 없으면 미반영 경고.
 *   6. 프로젝트 글에 선언된 사람 — 프로젝트가 주 엔티티면 라벨은 프로젝트로 가므로,
 *      같이 선언된 사람은 라벨 유무와 무관하게 origin 에 mentions 로 잇는다(글에 언급된
 *      사람이라 검색 정합을 지킨다). 중복 없이 사람당 mentions 하나.
 *   7. 사건 글 — 등록 신호(고유 사실·별칭·라벨)가 0이고 `#사람:` 1명 이상이면 각
 *      사람을 origin 에 mentions 로만 잇는다. mentions 엣지는 사람당 하나(중복 없음).
 *   8. 엔티티가 하나라도 생기면 trigger.emit('hashtag-concept-added').
 *
 * 즉석 `@귀속`(`#생일@철수`)은 Task 9 파서가 만들지 않으므로 자연히 처리 대상이 없다.
 */
export async function wireHashtagEntities(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  content: string,
  options: WireHashtagEntitiesOptions = {},
): Promise<WireEntityResult> {
  const parsed = parseHashtagEntities(content);
  const provenance = options.provenance ?? (originNodeId === null ? "user_input" : "hashtag");
  const sourceNodeId = originNodeId;

  // 사람/프로젝트 라벨 경로가 전담하지 않는 콜론 키를 제외한다.
  // - 타입 지시 키와 분류 진입 키(`#작품:`·`#소설:` 등)는 wireEntityPlacement 가 전담한다.
  // - 관계 키(`#작가:`·`#가족:` 등)는 wireEntityRelations/wirePersonHierarchy 가 전담한다.
  // label.category 는 이미지 분류 동의어 정규화를 거칠 수 있으므로 rawCategory 로 판정한다.
  const projectDeclaredForLabels = parsed.projectDeclarations.length > 0;
  parsed.labels = parsed.labels.filter(
    (l) =>
      !isPlacementDeclarationKey(l.rawCategory) &&
      (projectDeclaredForLabels || !isRelationKey(l.rawCategory)),
  );

  const result: WireEntityResult = {
    personIds: [],
    projectId: null,
    attributesApplied: 0,
    labelsApplied: 0,
    warnings: [],
  };

  // 정직한 파싱 실패 — Task 9 errors 를 그대로 경고로 흘린다(spec 3.7.4).
  for (const err of parsed.errors) {
    result.warnings.push(`파싱 실패 ${err.tag} — ${err.reason}`);
  }

  // 등록 신호를 둘로 가른다(Q21/Q22):
  //   - hasFactsOrAlias = 고유 사실 칸(생일·주소·성별) 또는 별칭 — *한 사람 고유* 라
  //     주 엔티티가 정확히 1명일 때만 붙는다(여럿이면 모호 경고).
  //   - hasLabels = 공유 특성 라벨(직업·회사 등) — 선언된 *모든* 사람에게 붙는다.
  const aliasesBelongToEntity =
    parsed.attributes.length === 0 &&
    parsed.aliases.length > 0 &&
    parsed.personDeclarations.length === 0 &&
    parsed.projectDeclarations.length === 0 &&
    entityRowWouldBeCreated(content);
  const hasFactsOrAlias =
    parsed.attributes.length > 0 ||
    (parsed.aliases.length > 0 && !aliasesBelongToEntity);
  const hasLabels = parsed.labels.length > 0;

  // 콜론 없는 사람 태그(별명/본명)를 주 엔티티 후보로 끌어온다(별명 spec 2026-06-07 §3.3).
  // 등록 신호(고유 사실·별칭 또는 라벨)가 있을 때만 합친다 — 등록 신호 없는 순수 사건 글의
  // `#나` mentions 는 wireHashtagConcepts 가 이미 처리하므로, 여기서 또 personDeclarations
  // 에 넣어 사건 글 경로를 중복으로 타게 하지 않는다.
  // 합치는 값은 조회로 확정한 사람의 *표시 이름* — 그러면 아래 기존 로직(personCount·
  // factPersonId·라벨 경로)이 콜론 선언 사람과 같은 평면에서 displayName 기준으로 중복
  // 제거하며 그대로 작동한다. 모호한 별명(2명+)은 후보에서 빼고 경고한다.
  if (hasFactsOrAlias || hasLabels) {
    const { tags } = parseTags(content);
    for (const tag of tags) {
      const lookup = await store.findPersonByNameOrAlias(tag);
      if (lookup.ambiguous) {
        result.warnings.push(
          `별칭 '${tag}' 가 2명+ 사람에 겹쳐 모호 — 주 엔티티 후보 제외`,
        );
        continue;
      }
      if (
        lookup.person &&
        !parsed.personDeclarations.includes(lookup.person.displayName)
      ) {
        parsed.personDeclarations.push(lookup.person.displayName);
      }
    }
  }

  const hasProject = parsed.projectDeclarations.length > 0;
  const personCount = parsed.personDeclarations.length;

  let touchedSomething = false;

  // ── 프로젝트 선언 — findOrCreateProject + origin.project_id 설정 ─────────
  let mainProjectId: string | null = null;
  if (hasProject) {
    const projectResolution = await resolveProjectDeclaration(
      store,
      content,
      parsed.projectDeclarations,
      originNodeId,
    );
    mainProjectId = projectResolution.projectId;
    result.projectId = projectResolution.projectId;
    result.warnings.push(...projectResolution.warnings);
    if (projectResolution.touched) touchedSomething = true;
  }

  if (hasProject && parsed.aliases.length > 0) {
    if (!mainProjectId) {
      result.warnings.push("프로젝트 별칭 미반영 — 붙일 프로젝트 행 없음");
    } else if (personCount > 0) {
      result.warnings.push(
        "별칭 귀속 모호 — 한 글에 사람과 프로젝트가 함께 있어 #별칭: 을 어디에도 안 붙임" +
          " (#사람: 만 또는 #프로젝트: 만 있는 글에 적어 주세요)",
      );
    } else {
      const added = await addEntityKoAliases(store, mainProjectId, parsed.aliases);
      if (added > 0) touchedSomething = true;
    }
  }

  // ── 고유 사실 칸/별칭의 주 엔티티 결정(고유 사실은 한 사람만) ────────────
  // 프로젝트가 주 엔티티가 아니고 고유 사실/별칭이 있으면, 사람이 정확히 1명일 때만
  // 그 사람에게 붙인다. 0·2+면 주 엔티티가 모호 — 칸은 한 사람 고유 사실이라 여럿에
  // 못 나누므로 아무에게도 안 붙이고 정직하게 경고한다(추정 귀속 금지). 라벨은 이
  // 모호와 무관하게 아래에서 독립으로 전원에 붙는다.
  let factPersonId: string | null = null;
  if (!hasProject && hasFactsOrAlias) {
    if (personCount === 1) {
      const person = await findOrCreatePersonByNameOrAlias(
        store,
        parsed.personDeclarations[0]!,
        result.warnings,
      );
      if (person) factPersonId = person.personId;
    } else {
      result.warnings.push(
        `주 엔티티가 모호 — 속성 미반영 (#사람: 이 ${personCount}개)`,
      );
    }
  }

  // 이 글이 건드린 사람 id 를 result.personIds 에 한 번씩만 모은다(같은 사람이
  // 고유 사실·라벨·mentions 여러 경로로 닿아도 한 번). mentions 엣지는 등록 글의 주
  // 사람(factPersonId)·라벨 등록 사람·프로젝트 글 사람·사건 글 사람에 단다 — 등록 글
  // 주 사람도 받는다(사용자 결정 2026-06-15: 글이 그 사람에 매달리고 사람 검색 합류).
  // 주 사람이 모호한 글(personCount>1)은 factPersonId 가 없어 mentions 도 안 단다.
  const seenPersonIds = new Set<string>();
  const pushPersonId = (personId: string): void => {
    if (seenPersonIds.has(personId)) return;
    seenPersonIds.add(personId);
    result.personIds.push(personId);
  };
  // origin 에 mentions 엣지를 만든 사람 id 집합 — 라벨 경로와 사건 글 경로가 같은
  // 사람에 중복으로 엣지를 더하지 않도록 한 곳에서 모은다(addNodePersonEdge 가 DB
  // INSERT OR IGNORE 라 중복 행은 안 생기지만, 헛 호출을 막아 의도를 분명히 한다).
  const mentionedPersonIds = new Set<string>();
  const linkMention = async (personId: string): Promise<void> => {
    pushPersonId(personId);
    if (mentionedPersonIds.has(personId)) return;
    mentionedPersonIds.add(personId);
    if (originNodeId !== null) {
      await store.addNodePersonEdge(
        originNodeId,
        personId,
        "mentions",
        provenance,
        sourceNodeId,
      );
      touchedSomething = true;
    }
  };

  // ── 고유 사실·별칭을 주 엔티티 사람에 붙인다(등록 글) ───────────────────
  if (factPersonId) {
    // 등록 글의 주 사람(personCount===1 으로 모호 없이 확정)도 origin 에 mentions 로
    // 잇는다 — 그러면 그 글이 사람에 매달리고 사람 이름 검색에도 합류한다(사용자 결정
    // 2026-06-15). linkMention 의 중복 방지 Set 이 다른 경로(라벨·프로젝트·사건)와
    // 같은 사람에 겹쳐도 mentions 엣지를 한 개로 모은다(누락·중복 0). 추정 귀속 금지는
    // 그대로 — personCount>1 모호면 factPersonId 가 없어 이 갈래에 안 들어온다.
    await linkMention(factPersonId);
    if (parsed.attributes.length > 0) {
      const facts: {
        birthday?: string;
        address?: string;
        gender?: string;
      } = {};
      for (const attr of parsed.attributes) {
        facts[attr.column] = attr.value;
      }
      await store.updatePersonFacts(factPersonId, facts);
      result.attributesApplied = parsed.attributes.length;
    }
    // ③ 귀속 경계(2026-06-13 §14.3·방향 4) — 같은 글에 신규 8 타입 엔티티 행도 생기면
    // `#별명:` 이 사람 닉네임인지 엔티티 약칭인지 모호하다. 거짓 귀속 0 으로, 그 글의
    // 별칭은 사람에게도 안 붙이고 경고만 남긴다(엔티티 통로도 같은 규칙으로 막는다 —
    // entity-placement-wiring §5.5). 고유 사실 칸(생일·주소·성별)은 사람 고유라 모호와
    // 무관하게 그대로 붙는다 — ③ 모호는 `#별명:` 에만 적용한다.
    if (parsed.aliases.length > 0 && entityRowWouldBeCreated(content)) {
      result.warnings.push(
        "별칭 귀속 모호 — 한 글에 사람과 엔티티가 함께 있어 #별칭: 을 어디에도 안 붙임" +
          " (#사람: 만 또는 엔티티 사슬만 있는 글에 적어 주세요)",
      );
    } else {
      for (const alias of parsed.aliases) {
        await store.addPersonAlias(factPersonId, alias);
      }
    }
    touchedSomething = true;
  }

  // ── 라벨 라우팅 — 프로젝트가 주 엔티티면 프로젝트로, 아니면 선언된 모든 사람에게 ─
  // Q22: 라벨(직업·회사 등)은 공유 특성이라 선언된 사람 전원에게 붙는다. 사람이
  // 1명이면 그 한 사람에게만 가 변경 전과 같다(회귀 불변).
  if (hasLabels) {
    if (mainProjectId) {
      // 단계3(콜론 사슬 구조 배치 §3-2 ①(a)·§9 D5) — project 콜론 사슬의 *중간 마디 키* 로
      // 떨어진 라벨은 제외한다. `#프로젝트:라이브2D #라이브2D:동글이` 에서 `#라이브2D:동글이` 는
      // parseHashtagEntities 가 labels 갈래로 떨구지만, 키 "라이브2D" 는 project 사슬의 콜론
      // 키다 — 그 라벨의 value "동글이" 를 project 라벨로 이으면 사슬 끝-실체가 라벨로 새는
      // 누수(I2 위반). projectChainConsumedKeys 가 그 사슬 키 집합(프로젝트·라이브2D)을 주므로
      // 라벨 키가 그 집합에 들면 뺀다. 동시에 project.attributes 에 남은 키만 project 라벨로
      // 받는다 — 제거된 언어·엔진 같은 일반 라벨 키는 project 로 소비하지 않고 일반 분류
      // 위계로 흐르게 둔다. 사슬 끝-실체("동글이")는 새 통로 placement 가 entities 행·위계로
      // 만든다(역할 경계).
      const chainKeys = projectChainConsumedKeys(content);
      const projectLabelKeys = new Set(
        getTypeAttributes("project").map((k) => k.toLowerCase()),
      );
      const projectLabels = parsed.labels.filter(
        (l) => {
          const rawKey = l.rawCategory.trim().toLowerCase();
          return projectLabelKeys.has(rawKey) && !chainKeys.has(rawKey);
        },
      );
      // Q4 — 프로젝트 라벨은 분류·태그 두 role 겸용으로 잇는다.
      for (const label of projectLabels) {
        const valueConceptId = await ensureLabelValueConcept(
          store,
          label,
          provenance,
          sourceNodeId,
        );
        await store.addProjectConceptEdge(
          mainProjectId,
          valueConceptId,
          "classification",
          provenance,
          sourceNodeId,
        );
        await store.addProjectConceptEdge(
          mainProjectId,
          valueConceptId,
          "tag",
          provenance,
          sourceNodeId,
        );
        result.labelsApplied += 1;
      }
      touchedSomething = true;
    } else if (personCount > 0) {
      const labelsBefore = result.labelsApplied;
      await applyLabelsToDeclaredPersons(
        store,
        provenance,
        sourceNodeId,
        parsed.personDeclarations,
        parsed.labels,
        result.warnings,
        {
          onLabelApplied: () => {
            result.labelsApplied += 1;
          },
          onPersonLinked: linkMention,
        },
      );
      if (result.labelsApplied > labelsBefore) touchedSomething = true;
    } else {
      // 라벨은 있는데 붙일 주 엔티티가 없다(프로젝트도 사람도 0) — 조용히 버리지
      // 않고 정직하게 경고한다(silent drop 금지).
      const labelText = parsed.labels.map((l) => `#${l.category}:${l.value}`).join(" ");
      result.warnings.push(`라벨 미반영 — 붙일 주 엔티티 없음 (${labelText})`);
    }
  }

  // ── 프로젝트 글에 선언된 사람 — origin 에 mentions 로 잇는다(라벨 유무 무관) ──
  // 프로젝트가 주 엔티티일 때 라벨은 프로젝트로 가므로, 같이 선언된 사람은 위 라벨
  // 경로로는 안 잇힌다. 하지만 그 사람은 글에 언급된 것이므로("바라 프로젝트 철수랑
  // 같이") mentions 로 이어 검색 정합을 지킨다. linkMention 의 중복 방지 Set 으로
  // 다른 경로에서 이미 mentions 된 사람과는 겹치지 않는다.
  if (mainProjectId && personCount > 0) {
    for (const name of parsed.personDeclarations) {
      const person = await findOrCreatePersonByNameOrAlias(
        store,
        name,
        result.warnings,
      );
      if (!person) continue;
      await linkMention(person.personId);
    }
  }

  // ── 사건 글 — 등록 신호(고유 사실/별칭/라벨)가 하나도 없고 사람이 1명 이상이면
  //    각 사람을 origin 에 mentions 로만 잇는다(사실·라벨 안 붙임) ──────────
  //
  // hasFactsOrAlias 가 true 인데 라벨 경로로 사람이 안 잇혔다면 = 고유 사실 등록 글
  // 의도였으나 주 엔티티가 모호한 경우(위에서 경고됨). 그때는 mentions 도 만들지
  // 않는다 — 모호한 등록 입력을 절반만 처리해 사람 행을 슬며시 만들지 않는다(추정
  // 귀속 금지). 라벨 등록 글의 사람은 위 라벨 경로에서 이미 mentions 로 잇혔다.
  //
  // 프로젝트가 함께 선언돼도(예: `#프로젝트:바라 #사람:철수`) 사람은 글에 언급된
  // 것이므로 mentions 로 잇는다. 프로젝트↔사람 참여자 자동 연결은 1.2 밖(Task 12·
  // 데이터 정리 깊은 패스 주체)이라 여기서 만들지 않는다.
  if (!hasFactsOrAlias && !hasLabels && personCount > 0) {
    for (const name of parsed.personDeclarations) {
      const person = await findOrCreatePersonByNameOrAlias(
        store,
        name,
        result.warnings,
      );
      if (!person) continue;
      await linkMention(person.personId);
    }
  }

  // ── 직접 입력 칸(#날짜·#일정시작·#일정종료) → event_at·event_until (활용 단계2 ②) ─
  // 동의어 충돌(#날짜+#일정시작 다른 값)은 parser 가 directFields 에서 빼고 errors 로
  // 올려 위 parsed.errors→warnings 갈래가 "충돌" 경고를 흘린다 — 여기선 충돌 없는
  // 단일 값 칸만 다룬다. now 미주입이면 일정 칸만 graceful skip 하고 본체는 보존한다.
  if (parsed.directFields.length > 0) {
    if (originNodeId === null) {
      result.warnings.push(
        "직접 입력 칸(#날짜·#일정시작·#일정종료)은 글 노드가 없어 미반영",
      );
    } else if (options.now === undefined) {
      result.warnings.push(
        "직접 입력 칸(#날짜·#일정시작·#일정종료)이 있으나 now 미주입 — 일정 칸 미반영",
      );
    } else {
      // 같은 글에 명시 event_until 칸(#일정종료) 선언이 있는지 — 있으면 그 명시 값이
      // `#날짜:A~B` 의 끝 날짜보다 우선한다(명시 태그 우선·아래 ~ 분할이 안 덮는다).
      const hasExplicitUntil = parsed.directFields.some(
        (f) => f.column === "event_until",
      );
      for (const field of parsed.directFields) {
        // 결정 5 — `#날짜:6월 28일 ~ 6월 30일` 처럼 event_at 칸 값에 `~` 가 있으면 앞=시작·
        // 뒤=끝으로 갈라 event_at·event_until 둘을 채운다(splitDateRange 단일 출처). `~` 가
        // 없으면 end=null 이라 단일 날짜 거동 그대로(event_at 만). event_until 칸(#일정종료)은
        // 자기 칸 한 값이라 `~` 분할 대상이 아니다 — event_at 칸일 때만 둘로 가른다.
        const range =
          field.column === "event_at"
            ? splitDateRange(field.value)
            : { start: field.value, end: null };

        const startIso = extractEventDateTime(range.start, options.now);
        if (startIso === null) {
          // 값이 일시로 안 풀리면 거짓 일시를 만들지 않고 그 칸만 건너뛰고 경고한다.
          result.warnings.push(
            `직접 입력 칸 '${field.column}' 의 값 '${range.start}' 을 일시로 풀 수 없어 미반영`,
          );
        } else {
          const wrote =
            field.column === "event_at"
              ? await store.setEventAt(originNodeId, startIso, "direct")
              : await store.setEventUntil(originNodeId, startIso, "direct");
          if (wrote) {
            touchedSomething = true;
          } else {
            // 더 높은 출처가 이미 채운 칸은 안 덮는다(direct 끼리 충돌은 없으니 사실상
            // 미발생이나, 정직하게 드러낸다 — silent skip 금지).
            result.warnings.push(
              `직접 입력 칸 '${field.column}' 쓰기 거부(더 높은 출처가 이미 채움) — '${startIso}'`,
            );
          }
        }

        // `~` 끝 날짜 → event_until. 명시 #일정종료 선언이 같은 글에 있으면 그 명시 값이
        // 우선이라 ~ 의 끝은 양보한다(이중·덮어쓰기 0). 끝 날짜가 안 풀리면 거짓 일시를
        // 안 만들고 경고만(정직한 미반영).
        if (range.end !== null && !hasExplicitUntil) {
          const endIso = extractEventDateTime(range.end, options.now);
          if (endIso === null) {
            result.warnings.push(
              `직접 입력 칸 '날짜' 의 끝 날짜 '${range.end}' 을 일시로 풀 수 없어 event_until 미반영`,
            );
          } else {
            const wroteUntil = await store.setEventUntil(
              originNodeId,
              endIso,
              "direct",
            );
            if (wroteUntil) {
              touchedSomething = true;
            } else {
              result.warnings.push(
                `직접 입력 칸 'event_until' 쓰기 거부(더 높은 출처가 이미 채움) — '${endIso}'`,
              );
            }
          }
        }
      }
    }
  }

  // ── 직접 입력 장소(#장소) → place 엔티티 + 출처 direct (활용 단계2 ③) ─────────
  // place 는 *엔티티* 라 setPlace(direct)가 콜론 #장소 경로와 같은 행 게이트를 거쳐
  // 고유명사("강남 A마트")만 places 행 + 개념 identity 로 합류시키고, "직접 입력했다"는
  // 출처를 글 metadata 에 direct 로 기록한다(spec §5·C-1). 일정과 달리 시각 해석이 없어
  // now 무관 — placeFields 값을 그대로 보낸다. 한 글에 여러 장소가 자연스러워 parser 가
  // 다 담았고(충돌 아님), 여기서 각 장소를 한 번씩 처리한다. 게이트 거부(일반명사)·출처
  // 충돌은 서로 다른 사유로 정직하게 경고한다(silent skip 금지·한 메시지로 안 뭉침).
  for (const place of parsed.placeFields) {
    if (originNodeId === null) {
      result.warnings.push(
        `직접 입력 장소 '${place}' 은(는) 글 노드가 없어 미반영`,
      );
      continue;
    }
    const res = await store.setPlace(originNodeId, place, "direct");
    if (res.wrote) {
      touchedSomething = true;
    } else if (res.skipReason === "gate-rejected") {
      // seed·일반명사 장소("서울"·"집"·"회사")는 콜론 #장소:서울 과 같이 1급 엔티티를
      // 안 만든다(거짓 엔티티 방지·C-1). 직접 입력했어도 일반명사는 행으로 안 승격됨을
      // 정직하게 알린다(고유 장소명일 때만 카드).
      result.warnings.push(
        `직접 입력 장소 '${place}' — 일반명사·분류 단어라 1급 장소 엔티티로 만들지 않음(고유 장소명만 카드)`,
      );
    } else {
      // source-conflict — direct 끼리는 canWriteField 가 안 막아 사실상 미발생이나,
      // 더 높은 출처가 이미 있으면 정직하게 드러낸다(spec §5.1).
      result.warnings.push(
        `직접 입력 장소 '${place}' 쓰기 거부(더 높은 출처가 이미 채움)`,
      );
    }
  }

  if (touchedSomething) {
    options.trigger?.emit("hashtag-concept-added");
  }

  return result;
}

/**
 * wireHashtagEntities 를 실패 격리해 가동한다 — wireHashtagConceptsSafe 양식.
 *
 * wiring 실패(findOrCreate* throw 등)는 삼키지 않고 구체 warn 후 진행한다 —
 * origin 노드 저장은 이미 끝났으므로 원본 유실 0(silent fallback 금지 정신:
 * 실패를 "엔티티 0개"로 위장하지 않고 origin id·까닭을 warn 에 남긴다). 엔티티
 * wiring 실패가 입력 저장을 통째 깨지 않게 격리한다.
 *
 * @param label warn 메시지 출처 라벨(호출 통로 식별 — 예: 'saveTextInput').
 * @param now   직접 입력 칸(#날짜·#일정시작·#일정종료) 풀이 기준 시각. 호출처가 입력
 *              시점 new Date() 를 주입한다. 미주입이면 일정 칸만 graceful skip(경고).
 */
export async function wireHashtagEntitiesSafe(
  store: SqliteMemoryStore,
  originNodeId: number | null,
  content: string,
  trigger: AutoCleanupTriggerHandle | undefined,
  label: string,
  now?: Date,
  provenance?: Provenance,
): Promise<void> {
  try {
    await wireHashtagEntities(store, originNodeId, content, {
      trigger,
      now,
      provenance,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const originLabel = originNodeId === null ? "origin 없음" : `원본 ${originNodeId}`;
    console.warn(
      `[${label}] 엔티티 wiring 실패 (${errMsg}) — ${originLabel}, ` +
        `해시태그 엔티티 연결 누락`,
    );
  }
}
