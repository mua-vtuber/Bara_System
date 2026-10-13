/**
 * concept-type-vocabulary.ts — 개념 엔티티 타입 자동 배치 어휘 사전 로더 (spec §6.1).
 *
 * concept_type_vocabulary.yaml(사용자 직접 편집)을 process 안 한 번 읽어 cache.
 * 배치 가능 타입은 entity-type-registry(8) + person·project 를 단일 출처로 세운다 —
 * 타입 이름을 이 파일에 하드코딩하지 않는다.
 *
 * synonym-dictionary.ts·yaml-mapping.ts 양식 정합 — readFileSync + yaml.parse +
 * 구체 에러 throw(silent fallback 금지). 미등록 타입 키·형식 불일치는 가리지 않고 알린다.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ENTITY_TYPE_METAS, type EntityTypeName } from "../db/store-internal/entity-type-registry.ts";

/**
 * 컴파일타임 타입은 기존 10종 union 으로 둔다(단계3 T3 — 정적 10종 컴파일타임 안전 유지).
 * 사용자가 화면으로 더한 11번째 이후 새 종류는 union 멤버가 아니라 `string` 으로 흐르고,
 * *런타임 동적 명부*(placementTypeNames/isPlacementType)가 게이트한다. 그래서 타입
 * 시그니처는 그대로 PlacementTypeName 이지만, 동적 경로는 string 을 받아 동적 Set 검사가
 * 통과시킨다. 정적 8+2 만 union 으로 컴파일타임 검증되는 비대칭이 의도된 설계다.
 */
export type PlacementTypeName = EntityTypeName | "person" | "project";

/**
 * 코드 상수 10종 — 동적 명부의 정적 부분 단일 출처(ENTITY_TYPE_METAS 8 + 사람·프로젝트).
 *
 * stage4 T2: 이 정적 8타입은 옛 마이그레이션 v17/v18 동결 스냅샷과 같은 권위다 — 컴파일타임
 * 안전·동결 권위로 그대로 유지하고 빼지 않는다. DB 새 종류는 setEntityTypeOverride 로 주입돼
 * placementTypeNames·isPlacementType 가 정적 10종 ∪ DB 새 종류로 동적 합류시킨다(아래 함수).
 */
const STATIC_PLACEMENT_TYPE_NAMES: PlacementTypeName[] = [
  ...ENTITY_TYPE_METAS.map((m) => m.typeName), "person", "project",
];

/** setEntityTypeOverride 가 받는 새 종류 한 항목(EntityTypeRegistryDb.listUserEntityTypes 부분집합). */
export interface UserEntityTypeName {
  typeName: string;
  koName: string | null;
}

/**
 * DB 새 종류 명부 모듈 캐시. 주입 전(빈 배열)이면 정적 10종만 본다(byte 동일·회귀 0).
 * server 부팅·종류 CRUD 시점에 setEntityTypeOverride 가 DB 목록을 얹는다. 이 모듈은
 * DB 를 직접 안 부른다 — 단계1·2 의 setConceptVocabOverride 주입 양식 미러(DB 결합·순환
 * 의존 차단).
 */
let userEntityTypes: UserEntityTypeName[] = [];
/** placementTypeNames 산출 캐시(정적 ∪ 주입). 주입·reset 시 null 로 무효화. */
let placementNamesCache: PlacementTypeName[] | null = null;
/** isPlacementType 동적 검사용 Set 캐시. 주입·reset 시 null 로 무효화. */
let placementSetCache: Set<string> | null = null;

/**
 * 배치 가능 종류 명부 — 정적 10종 ∪ 주입된 DB 새 종류. 주입 0개면 정적 10종 그대로
 * (byte 동일). 새 종류는 union 밖이라 string 을 PlacementTypeName 으로 단언해 합류한다
 * (동적 명부 비대칭 — 런타임 Set 이 진짜 게이트). 캐시라 순회 호출처가 가볍다.
 */
export function placementTypeNames(): PlacementTypeName[] {
  if (placementNamesCache) return placementNamesCache;
  const names: PlacementTypeName[] = [...STATIC_PLACEMENT_TYPE_NAMES];
  for (const u of userEntityTypes) {
    names.push(u.typeName as PlacementTypeName);
  }
  placementNamesCache = names;
  return names;
}

/** 종류 이름이 배치 가능 종류(정적 10종 ∪ 주입 새 종류)인지 — 동적 게이트(옛 PLACEMENT_SET.has). */
export function isPlacementType(name: string): boolean {
  if (!placementSetCache) {
    placementSetCache = new Set<string>(placementTypeNames());
  }
  return placementSetCache.has(name);
}

/**
 * DB 새 종류 명부를 모듈 캐시에 주입한다(setConceptVocabOverride 양식 미러).
 * server 부팅·종류 CRUD 후 EntityTypeRegistryDb.listUserEntityTypes() 산출을 얹고,
 * 종류 명부 캐시(placementNamesCache·placementSetCache)를 무효화한다(추가·삭제 즉시 반영).
 * 빈 배열 주입은 no-op 복귀(정적 10종만). 이 함수는 classifier 2차 캐시를 안 건드린다 —
 * 라우트가 resetClassifierCache 와 한 묶음으로 부른다(2-reset / 단계1·2 양식).
 */
export function setEntityTypeOverride(types: readonly UserEntityTypeName[]): void {
  userEntityTypes = types.map((t) => ({ typeName: t.typeName, koName: t.koName }));
  placementNamesCache = null;
  placementSetCache = null;
}

/**
 * 주입된 DB 새 종류의 한국어 표시명. 정적 10종은 user 명부에 없어 null(코드 상수 koName 은
 * 별 출처 — entity-type-classifier.koNameOf 가 레지스트리/상수에서 읽는다). 미등록도 null.
 */
export function userEntityKoNameOf(typeName: string): string | null {
  const u = userEntityTypes.find((t) => t.typeName === typeName);
  return u ? u.koName : null;
}

export interface TypeVocabulary {
  synonyms: string[];
  subcategories: string[];
  attributes: string[];
  /**
   * 칸 어휘(단계3 T8·D15) — 이 종류의 `#키:값` 입력이 칸(is_column=1·색인 속성)으로
   * 저장될 키 목록. 라벨(attributes)과 갈린다(칸=정렬·필터 1급, 라벨=꼬리표). yaml 본체엔
   * 없고 사용자 columns slot 으로만 채워진다 — 기존 10종·빈 DB 는 빈 배열(byte 동일). 옛
   * 4칸 literal 호환을 위해 optional 로 두되, 접근자(getTypeColumns)·merge 가 빈 배열로 채운다.
   */
  columns?: string[];
}
export type ConceptTypeVocabulary = Map<PlacementTypeName, TypeVocabulary>;

/**
 * 항목 동의어 정규화 맵 — 타입마다 `동의어(소문자) → 대표키`.
 * buildItemSynonymMap(merge-classify-vocab) 산출과 같은 모양. 라벨 어휘 매칭 직전에
 * getCanonicalItemKey 가 이 맵으로 동의어 키를 대표키로 바꾼다(kinship-synonyms 양식).
 */
export type ItemSynonymMap = Map<PlacementTypeName, Map<string, string>>;

/**
 * column_types datatype 맵 — `Map<타입, Map<칸키, "number" | "date">>` (단계6b).
 * buildColumnTypeMap(merge-classify-vocab) 산출과 같은 모양. 새 종류 한 칸이 숫자형인지
 * 날짜형인지 getColumnDataType 가 이 맵으로 판정한다(코드 8종 datatype 은 entity-type-registry
 * columnDataTypeOf 가 별 출처로 책임진다 — 이 맵은 새 종류 한정).
 */
export type ColumnStoredDataType = "number" | "date";
export type ColumnDataType = "text" | ColumnStoredDataType;
export type ColumnTypeMap = Map<string, Map<string, ColumnStoredDataType>>;

const YAML_FILENAME = "concept_type_vocabulary.yaml";
/**
 * 파생 캐시 vs 주입 데이터를 가른다(userEntityTypes ↔ placementNamesCache 와 같은 구도).
 *  - 파생 캐시(resetConceptTypeVocabularyCache 가 비운다): yamlVocabCache(운영 yaml 파싱본 —
 *    종류 명부로 칸이 정해지므로 명부가 바뀌면 다시 빌드), cachedSubcatMap(역방향 맵).
 *  - 주입 데이터(reset 이 건드리지 않는다): injectedVocab(setConceptVocabOverride 의 병합본 —
 *    yaml + 사용자 추가 + 가림표), itemSynonymMap·columnTypeMap(사용자 행에서 빌드한 맵).
 *    주입 데이터를 비우는 건 clearConceptVocabularyOverrides 의 몫이다.
 */
let yamlVocabCache: ConceptTypeVocabulary | null = null;
let injectedVocab: ConceptTypeVocabulary | null = null;
let cachedSubcatMap: Map<string, PlacementTypeName> | null = null;
/** 항목 동의어 맵(주입 데이터) — 주입 전(null)이면 빈 맵 취급(no-op). */
let itemSynonymMap: ItemSynonymMap | null = null;
/** column_types datatype 맵(주입 데이터·단계6b) — 주입 전(null)이면 전부 글자형(byte 동일). */
let columnTypeMap: ColumnTypeMap | null = null;

function operationalPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), YAML_FILENAME);
}
function parseVocabulary(path: string): ConceptTypeVocabulary {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (e) { throw new Error(`concept-type-vocabulary: 파일을 읽지 못함 (${path}): ${(e as Error).message}`); }
  let parsed: unknown;
  try { parsed = parse(raw); }
  catch (e) { throw new Error(`concept-type-vocabulary: yaml 파싱 실패 (${path}): ${(e as Error).message}`); }
  const types = (parsed as { types?: unknown } | null)?.types;
  if (!types || typeof types !== "object" || Array.isArray(types)) {
    throw new Error(`concept-type-vocabulary: 'types' 매핑이 없음 (${path})`);
  }
  const dict: ConceptTypeVocabulary = new Map();
  for (const t of placementTypeNames()) {
    dict.set(t, { synonyms: [], subcategories: [], attributes: [], columns: [] });
  }
  for (const [typeKey, body] of Object.entries(types as Record<string, unknown>)) {
    if (!isPlacementType(typeKey)) {
      throw new Error(`concept-type-vocabulary: '${typeKey}' 는 등록되지 않은 배치 타입 (${path})`);
    }
    const v = body as Record<string, unknown>;
    const synonyms = requireStringArray(v.synonyms, "synonyms", typeKey, path);
    const subcategories = requireStringArray(v.subcategories, "subcategories", typeKey, path);
    const synLower = new Set(synonyms.map((s) => s.toLowerCase()));
    for (const sc of subcategories) {
      if (synLower.has(sc.toLowerCase())) {
        throw new Error(`concept-type-vocabulary: '${typeKey}' 의 '${sc}' 가 synonyms 와 subcategories 양쪽에 있음 (타입 별칭 ≠ 하위 분류 — 섞으면 위계 판정 어긋남) (${path})`);
      }
    }
    dict.set(typeKey as PlacementTypeName, {
      synonyms, subcategories,
      attributes: requireStringArray(v.attributes, "attributes", typeKey, path),
      // 칸 어휘(단계3 T8·D15) — yaml 본체엔 없고 사용자 columns slot 으로만 채워지지만,
      // yaml 에 columns 키를 적어도 받는다(requireStringArray 가 빠진 키는 빈 배열로).
      columns: requireStringArray(v.columns, "columns", typeKey, path),
    });
  }
  const seen = new Map<string, PlacementTypeName>();
  for (const t of placementTypeNames()) {
    for (const sc of dict.get(t)!.subcategories) {
      const key = sc.toLowerCase();
      const prev = seen.get(key);
      if (prev && prev !== t) {
        throw new Error(`concept-type-vocabulary: subcategory '${sc}' 가 '${prev}' 와 '${t}' 양쪽에 — 전역 분류 키 충돌(위계 부모가 둘) (${path})`);
      }
      seen.set(key, t);
    }
  }
  return dict;
}
function requireStringArray(val: unknown, field: string, typeKey: string, path: string): string[] {
  // YAML 키 생략·명시적 null 모두 빈 배열로 — plan 의 "빠진 타입 키는 정상" 정합.
  if (val === undefined || val === null) return [];
  if (!Array.isArray(val) || !val.every((x) => typeof x === "string")) {
    throw new Error(`concept-type-vocabulary: '${typeKey}.${field}' 가 문자열 배열이 아님 (${path})`);
  }
  return val as string[];
}
export function loadConceptTypeVocabulary(path?: string): ConceptTypeVocabulary {
  if (path) return parseVocabulary(path);
  if (injectedVocab) return injectedVocab;
  if (!yamlVocabCache) yamlVocabCache = parseVocabulary(operationalPath());
  return yamlVocabCache;
}
function vocabOf(typeName: PlacementTypeName): TypeVocabulary {
  const v = loadConceptTypeVocabulary().get(typeName);
  if (v) return v;
  // 새 종류(단계3 T3)는 vocab Map 에 칸이 아직 없을 수 있다 — 화면으로 종류만 더하고
  // 그 종류 어휘는 아직 0개인 상태. 명부에 있으면 빈 어휘(매번 fresh 라 공유 오염 0)를
  // 돌려준다(어휘 0개는 정직한 사실 — 어휘가 들어오면 병합본(injectedVocab)에 그 종류 칸이 생겨
  // 그쪽을 본다). 명부에도 없는 진짜 미등록만 loud throw(거짓 빈 어휘로 가리지 않는다).
  if (isPlacementType(typeName)) return { synonyms: [], subcategories: [], attributes: [], columns: [] };
  throw new Error(`concept-type-vocabulary: 배치 타입 아님: ${typeName}`);
}
export function getTypeSynonyms(t: PlacementTypeName): string[] { return vocabOf(t).synonyms; }
export function getTypeSubcategories(t: PlacementTypeName): string[] { return vocabOf(t).subcategories; }
export function getTypeAttributes(t: PlacementTypeName): string[] { return vocabOf(t).attributes; }
/**
 * 이 종류의 칸 어휘(단계3 T8·D15) — `#키:값` 입력이 칸(is_column=1)으로 저장될 키 목록.
 * 병합본 injectedVocab(setConceptVocabOverride 주입분)를 vocabOf 로 경유하므로, columns slot 추가/
 * 삭제 후 2-reset 이 즉시 반영된다. columns 미주입(옛 4칸 literal·기존 10종·빈 DB)이면 빈
 * 배열 — 입력 가름이 칸 승격 0 으로 떨어져 전부 라벨(T4 byte 동일·회귀 0).
 */
export function getTypeColumns(t: PlacementTypeName): string[] { return vocabOf(t).columns ?? []; }
/**
 * subcategory(소문자) → 배치 타입 역방향 맵. 운영 yaml 전용 —
 * loadConceptTypeVocabulary()(인자 없음)만 바라보고 cachedSubcatMap 에 캐시한다.
 * fixture path 로드와는 무관하며, 그 경로의 역방향 맵이 필요하면 별도로 만들어야 한다.
 */
export function subcategoryToTypeMap(): Map<string, PlacementTypeName> {
  if (cachedSubcatMap) return cachedSubcatMap;
  const vocab = loadConceptTypeVocabulary();
  const m = new Map<string, PlacementTypeName>();
  for (const t of placementTypeNames()) {
    // 새 종류는 vocab Map 에 칸이 아직 없을 수 있다(어휘 0개) — 빈 subcategories 로 건너뛴다.
    for (const sc of vocab.get(t)?.subcategories ?? []) m.set(sc.toLowerCase(), t);
  }
  cachedSubcatMap = m;
  return m;
}
/**
 * 파생 캐시만 비운다 — yaml 파싱본·subcategory 역방향 맵·종류 명부 캐시. 주입 데이터
 * (userEntityTypes, setConceptVocabOverride 병합본, setItemSynonymOverride·
 * setColumnTypeOverride 맵)는 남긴다. 종류 CRUD·관계명 CRUD 가 이 함수를 부르는데, 주입
 * 데이터까지 비우면 사용자 분류 어휘가 재시작 전까지 조용히 사라진다(병합본이 yaml 만으로
 * 되돌아감). 주입 데이터 비움은 clearConceptVocabularyOverrides / setEntityTypeOverride([]).
 * 명부가 바뀐 뒤 병합본의 종류 칸을 맞추려면 호출자가 병합본을 다시 주입한다.
 */
export function resetConceptTypeVocabularyCache(): void {
  yamlVocabCache = null;
  cachedSubcatMap = null;
  // 종류 명부 파생 캐시도 비운다(단계3 T3 — 종류 Set reset 합류). 주입 데이터
  // (userEntityTypes)는 남기고 파생 캐시만 비워, 다음 placementTypeNames()/isPlacementType()
  // 가 현재 명부로 재빌드한다. 명부 자체 비움은 setEntityTypeOverride([]) 의 몫이다.
  placementNamesCache = null;
  placementSetCache = null;
}

/**
 * 분류 어휘 주입 데이터(병합본·항목 동의어 맵·칸 datatype 맵)를 비워 yaml 기본으로 되돌린다.
 * 파생 캐시도 함께 비운다. 종류 명부(userEntityTypes)는 건드리지 않는다 — 그건
 * setEntityTypeOverride([]) 의 몫. 테스트 정리·데이터 초기화처럼 "주입분을 버린다"가
 * 의도인 곳 전용(resetConceptTypeVocabularyCache 는 주입분을 남긴다).
 */
export function clearConceptVocabularyOverrides(): void {
  injectedVocab = null;
  itemSynonymMap = null;
  columnTypeMap = null;
  resetConceptTypeVocabularyCache();
}

/**
 * 항목 동의어 키를 대표키로 정규화한다(kinship-synonyms canonicalKinship 양식 — 단 타입별).
 * 주입 전(맵 null)·해당 타입 맵 없음·매칭 없음이면 rawKey 를 그대로 돌려준다(no-op).
 * 라벨 어휘 매칭 직전 통로(entity-attribute-wiring·entity-placement-loop)가 부른다.
 */
export function getCanonicalItemKey(type: PlacementTypeName, rawKey: string): string {
  if (!itemSynonymMap) return rawKey;
  const perType = itemSynonymMap.get(type);
  if (!perType) return rawKey;
  return perType.get(rawKey.toLowerCase()) ?? rawKey;
}

/**
 * 항목 동의어 맵을 모듈 캐시에 주입한다(setConceptVocabOverride 양식 미러).
 * 라우트가 CRUD 후 buildItemSynonymMap 산출을 얹고, 2-reset 으로 비운다. 빈 맵 주입도
 * 가능(전부 삭제 후 no-op 복귀).
 */
export function setItemSynonymOverride(map: ItemSynonymMap): void {
  itemSynonymMap = map;
}

/**
 * 한 타입의 항목 동의어 쌍(`동의어소문자 → 대표키`)을 돌려준다. 주입 전·해당 타입
 * 없음이면 빈 Map. buildTypeAttributeKeys 가 라벨 어휘에 동의어를 펼칠 때(대표키가
 * 라벨이면 그 동의어 키도 속성으로 인식) 쓴다. 반환 Map 은 캐시 원본이 아니라 복제라
 * 호출처가 바꿔도 캐시가 안 흔들린다.
 */
export function getItemSynonymAliasesForType(type: PlacementTypeName): Map<string, string> {
  if (!itemSynonymMap) return new Map();
  const perType = itemSynonymMap.get(type);
  return perType ? new Map(perType) : new Map();
}

/** 단계6b — column_types 병합 맵을 모듈 캐시에 주입(setItemSynonymOverride 양식). */
export function setColumnTypeOverride(map: ColumnTypeMap): void {
  columnTypeMap = map;
}

/**
 * 단계6b — 새 종류 한 칸의 datatype(text 기본 / number/date). column_types 주입 맵에 그
 * (타입,칸키)가 있으면 지정 타입, 아니면 "text"(글자형 default·정직).
 * 주입 전(맵 null)이면 전부 "text"(byte 동일). 코드 8종 datatype 은 별 출처
 * (entity-type-registry columnDataTypeOf)가 책임진다 — 이 함수는 새 종류 한정.
 */
export function getColumnDataType(type: string, key: string): ColumnDataType {
  if (!columnTypeMap) return "text";
  return columnTypeMap.get(type)?.get(key) ?? "text";
}

/**
 * 병합본(yaml + 사용자 추가 분류 어휘) 주입 통로 (분류 어휘 DB 단계1 Task 3).
 *
 * 순수 yaml-only 본체(parseVocabulary)를 건드리지 않고, server 부팅·CRUD 후 시점에
 * mergeConceptVocab 산출 병합 Map 을 주입 데이터(`injectedVocab`)에 얹는다. 인자 없는
 * loadConceptTypeVocabulary()·접근자(getTypeSynonyms 등)는 그대로 `injectedVocab`(없으면 yaml)을 보므로
 * 소비 호출처는 한 줄도 안 바뀐 채 병합본을 본다(검색 동의어 reloadSynonymDict 정신 —
 * 단 여기는 retriever 인스턴스가 아니라 전역 모듈 캐시 갱신).
 *
 * cachedSubcatMap 은 null 로 비워 다음 subcategoryToTypeMap() 호출이 병합본으로 재빌드
 * 한다(역방향 맵 stale 차단). 분류기 2차 캐시(entity-type-classifier resetClassifierCache)
 * 는 별 함수라, 라우트가 이 함수와 한 묶음으로 함께 부른다.
 */
export function setConceptVocabOverride(merged: ConceptTypeVocabulary): void {
  injectedVocab = merged;
  cachedSubcatMap = null;
}
