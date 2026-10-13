/**
 * store-internal/entity-type-registry.ts — 신규 8 엔티티 타입 메타 단일 출처.
 *
 * spec 2026-06-09-concept-entity-type-system §2·§4. 타입마다 전용 테이블·FTS·vec
 * 이름과 id prefix·고유 칸을 한 곳에 모은다. 이 레지스트리는 베이스 repository 와
 * 후속 단계(배치 파서·검색 합류·그래프 렌더)가 보는 단일 출처다 — 런타임 코드가
 * 타입 이름·테이블 이름·고유 칸을 알아야 할 때 여기서 읽는다.
 *
 * 단, 스키마는 이 레지스트리를 런타임으로 import 하지 않는다. 8 타입의 옛 전용 테이블(옛 마이그레이션
 * v17 이 만들고 v18 이 라벨·identity 엣지를 더한 것)은 단계4 전면 통일로 없어졌고(아래 stage4 T9' 단락),
 * 기준 스키마(db/schema/)에는 범용 entities·entity_attributes·entity_concept_edges 만 있다. 그래서 여기
 * 8 타입의 표 이름 값은 그 시절의 동결 스냅샷이고, 새 종류는 이 레지스트리가 아니라 종류 명부 DB
 * (entity_types)로 더한다.
 *
 * 여기 값은 코드 리터럴 상수다 — 테이블/칸 이름이 동적 SQL 에 들어가도 HTTP 입력이
 * 아니므로 SQL injection 가드를 넘지 않는다(entity-embedding.ts 주석 정합).
 *
 * 사람(persons)·프로젝트(projects)는 이 레지스트리에 넣지 않는다 — 이미 1급이고
 * 검색·엣지 구조가 달라(별칭 칸·status·external_refs) 별 repository 가 전담한다.
 *
 * stage4 T2: 이 ENTITY_TYPE_METAS 정적 8종은 옛 마이그레이션 v17/v18 동결 스냅샷과 같은 권위다. 런타임
 * 종류 판정은 concept-type-vocabulary.placementTypeNames(정적∪DB)·entity-type-registry-db
 * 가 동적 합류한다 — 여기 8종은 컴파일타임 안전·동결 스냅샷 권위로 남기고, DB 새 종류는
 * 그 동적 통로로만 흐른다.
 */

export type EntityTypeName =
  | "creature"
  | "thing"
  | "intake"
  | "usable"
  | "work"
  | "material"
  | "place"
  | "schedule";

export interface EntityOwnColumn {
  name: string;
  /**
   * 칸 선언 SQL 조각(예: "expires_at TEXT"). 후속 단계(베이스 repository 의 칸
   * 화이트리스트·문서·검증)가 쓸 선언적 메타다 — Task 2 에서 소비처가 붙는다.
   * 옛 마이그레이션(v17)은 동결을 위해 ddl 을 런타임 참조하지 않고 칸 SQL 을
   * 직접 적었다. 그래서 지금은 검증만 되고 소비처가 없어 보이지만 의도된 분리다.
   */
  ddl: string;
}

export type ColumnDataType = "text" | "number" | "date";

export interface EntityTypeMeta {
  typeName: EntityTypeName;
  koName: string;
  idPrefix: string;
  idColumn: string;
  table: string;
  ftsTable: string;
  vecTable: string;
  vecRowidColumn: string;
  /**
   * 라벨·identity 엣지 테이블 이름(예: "work_concept_edges"). 3단계 wiring 이
   * 엔티티 행 ↔ 라벨 개념(`role='has_attribute'`)·위계 잎(`role='identity'`)을
   * 잇는 엣지를 여기에 쓴다(spec §4.2·§6.6). 사람·프로젝트의 `*_concept_edges`
   * 양식을 복제한 이름이다 — entity-concept-edge-repository 가
   * 이 값을 단일 출처로 읽는다(테이블·칸 이름 하드코딩 금지).
   */
  conceptEdgeTable: string;
  ownColumns: EntityOwnColumn[];
  /**
   * 칸 vs 라벨 가르기 단일 출처(3단계 Task 4·spec §3 3분법). 한국어 속성 태그 키
   * (예 '유통기한'·'주소')를 그 타입의 전용 DB 칸으로 보내는 camelCase facade 인자
   * 이름(예 'expiresAt'·'address')에 잇는다. 매핑에 있는 키는 칸(전용 update<Type>
   * 의 own 칸 경로)으로, 없는 키는 라벨(<type>_concept_edges has_attribute)로 간다.
   *
   * camelCase 값은 1단계 facade update<Type>(id, fields) 의 own 칸 인자 이름과 정확히
   * 같다(intake.expiresAt·usable.usageInstructions·material.topic·place.address).
   * 칸이 없는 타입(작품·생물·사물·일정)은 빈 매핑이다 — 그 타입의 속성 태그는 전부
   * 라벨(또는 관계). 일정은 날짜를 글 event_at 으로 모아 전용 칸이 없다(spec 2026-06-28).
   *
   * 주의: 어떤 칸 키(사용법·유통기한·주제)는 concept_type_vocabulary.yaml 의
   * attributes 에도 들어 있다. 라벨 어휘 = attributes − columnLabels(차집합)이므로 칸으로
   * 빠지고 라벨로 중복되지 않는다. 반대로 '주소'처럼 attributes 에 없는 칸 키도 여기 있으면
   * 칸으로 인식한다 — 칸 권위는 columnLabels 이고 attributes 는 라벨 어휘다.
   */
  columnLabels: Record<string, string>;
  /**
   * 단계6b — 이 종류 칸 중 숫자형(datatype=number) 칸 키 집합. 합산 대상으로 쓸
   * 코드 칸이 생기면 여기 키를 넣는다. 새 종류 datatype 은 classify-vocab column_types
   * slot 이 별 통로로 책임진다(메타 권위는 코드 8종 한정).
   */
  numericColumns?: ReadonlySet<string>;
  /**
   * 날짜형(datatype=date) 코드 칸 키 집합. 값 저장은 기존 문자열 칸 그대로 두고, UI 입력
   * 방식과 일정 발생 계산만 이 메타를 본다.
   */
  dateColumns?: ReadonlySet<string>;
}

const col = (name: string, sqlType = "TEXT"): EntityOwnColumn => ({
  name,
  ddl: `${name} ${sqlType}`,
});

// stage4 T9' — table·ftsTable·vecTable·conceptEdgeTable 4 필드는 동결 스냅샷 값이다.
// 단계4 전면 통일에서 정적 8 타입의 전용 본체·FTS·vec·전용 라벨 엣지 테이블이 죽었고
// (본체 → 범용 entities/entity_attributes·라벨 → entity_concept_edges 로 이관), 그
// 죽은 테이블은 옛 마이그레이션 v30 이 DROP 했고 기준 스키마(db/schema/)에는 없다.
// 그래서 이 4 필드가 가리키는 테이블 이름(creatures·works_fts·work_vec·work_concept_edges
// 등)은 더는 실재하는 런타임 테이블이 아니다 — 8 타입 union·idPrefix·idColumn·koName 과
// 함께 동결된 스냅샷 값으로만 남긴다(레지스트리 길이 8 동결 정합).
// 런타임 종류·라벨 권위는 범용 entities/entity_concept_edges + 종류 명부 DB
// (concept-type-vocabulary·entity-type-registry-db)이고, 이 4 필드를 읽어 테이블에
// 접근하던 호출처는 단계4 T4~T7'b 가 통합 통로로 옮겼다(필드 삭제 시 동결 깨짐 — 보존).
//
// 단 columnLabels 는 동결 스냅샷이 아니라 *런타임 동작* 이다 — applyEntityAttributes 가
// 매 입력마다 읽어 칸/라벨을 가른다(entity-attribute-wiring §1). 그래서 칸 매핑을 더하거나
// 빼는 일은 과거 마이그레이션 동결과 무관하게 지금 바꾼다. 일정(schedule)의 전용 날짜 칸은
// 이 규칙대로 columnLabels 에서 뺐다(글 event_at 일원화·spec 2026-06-28). 옛 v17 ownCols·v30
// DROP 은 기준 스키마로 접혀 코드에서 없어졌다(런타임 칸 매핑과 별개).
const PLURAL: Record<EntityTypeName, string> = {
  creature: "creatures",
  thing: "things",
  intake: "intakes",
  usable: "usables",
  work: "works",
  material: "materials",
  place: "places",
  schedule: "schedules",
};

function meta(
  typeName: EntityTypeName,
  koName: string,
  idPrefix: string,
  ownColumns: EntityOwnColumn[],
  columnLabels: Record<string, string> = {},
  numericColumns: ReadonlySet<string> = new Set(),
  dateColumns: ReadonlySet<string> = new Set(),
): EntityTypeMeta {
  const table = PLURAL[typeName];
  const stem = typeName;
  return {
    typeName,
    koName,
    idPrefix,
    idColumn: `${stem}_id`,
    table,
    ftsTable: `${table}_fts`,
    vecTable: `${stem}_vec`,
    vecRowidColumn: `${stem}_rowid`,
    conceptEdgeTable: `${stem}_concept_edges`,
    ownColumns,
    columnLabels,
    numericColumns,
    dateColumns,
  };
}

export const ENTITY_TYPE_METAS: EntityTypeMeta[] = [
  meta("creature", "생물", "cre_", []),
  meta("thing", "사물", "thg_", []),
  meta("intake", "섭취", "itk_", [col("expires_at")], { 유통기한: "expiresAt" }, new Set(), new Set(["유통기한"])),
  meta(
    "usable",
    "사용물",
    "usb_",
    [col("usage_instructions")],
    { 사용법: "usageInstructions" },
  ),
  meta("work", "작품", "wrk_", []),
  meta("material", "자료", "mat_", [col("topic")], { 주제: "topic" }),
  meta("place", "장소", "plc_", [col("address")], { 주소: "address" }),
  // 일정(schedule)은 전용 칸이 없는 0칸 종류다. 옛날엔 col("event_at)·{날짜:eventAt}
  // 으로 "날짜" 를 전용 칸으로 받았으나, 그 칸은 글 노드 event_at(knowledge_nodes.event_at)
  // 과 연동되지 않아 entity_attributes 에 갇힌 날짜가 시간 검색에 안 잡히는 함정이었다
  // (2026-06-28-schedule-date-column-removal-spec §2.3). 일정 날짜는 글 event_at 하나로
  // 모은다 — 입력 폼 달력 위젯(payload.eventAt → setEventAt)·본문 #날짜:(reserved key
  // node_field → setEventAt)가 글 event_at 을 채우고, 시간 검색·정렬·계산이 그 값을 본다.
  // 일정 종류는 분류·관계(관련사람·관련장소)·시간(글 event_at)으로 정상 종류로 남고,
  // 빠진 것은 전용 날짜 칸 하나뿐이다(creature·thing·work·material 과 동형 0칸).
  meta("schedule", "일정", "sch_", []),
];

const BY_NAME = new Map(ENTITY_TYPE_METAS.map((m) => [m.typeName, m]));

/**
 * 코드 8 타입 이름 배열 — ENTITY_TYPE_METAS 순서에서 파생한 단일 출처(손 재구현 금지).
 * ENTITY_TYPE_METAS 등록 순서를 그대로 보존한다(creature·thing·intake·usable·work·
 * material·place·schedule). 배치·관계 통로가 person·project 를 제외하는 멤버십 판정에
 * 이 배열을 쓸 때, 여기 한 곳에서 읽어 8 타입 이름을 각 파일에 손으로 다시 적지 않는다
 * (isEntityTypeName 가드와 같은 단일 출처 — 그쪽은 멤버십 boolean, 이쪽은 순서 있는 목록).
 */
export const ENTITY_TYPE_NAMES: readonly EntityTypeName[] =
  ENTITY_TYPE_METAS.map((m) => m.typeName);

export function getEntityTypeMeta(typeName: EntityTypeName): EntityTypeMeta {
  const m = BY_NAME.get(typeName);
  if (!m) throw new Error(`unknown entity type: ${typeName}`);
  return m;
}

/**
 * 코드 8 타입(EntityTypeName) 멤버십 가드 — 단일 출처. 임의 문자열(person·project·
 * 새 종류·미등록 koName 등)을 받아 ENTITY_TYPE_METAS 의 typeName 인지 판정한다.
 * getEntityTypeMeta 시그니처가 EntityTypeName 만 받으므로(person·project 는 union 밖이라
 * 컴파일 거부), 이 가드를 통과한 뒤에만 columnLabels·메타에 안전히 접근한다. 세 라우트
 * (entity-types·ingest·relation-vocab)가 인라인으로 재구현하던 `new Set(ENTITY_TYPE_METAS
 * .map(m => m.typeName))` 멤버십 검사를 이 한 곳으로 모은다.
 */
export function isEntityTypeName(name: string): name is EntityTypeName {
  return BY_NAME.has(name as EntityTypeName);
}

/**
 * 한 종류의 한국어 칸 키 목록을 돌려준다(intake=['유통기한']·place=['주소'] 등).
 * 일정(schedule)은 전용 칸이 없어 빈 배열이다(날짜는 글 event_at 으로 모음·spec 2026-06-28).
 * isEntityTypeName 가드를 통과한 코드 8 타입이면 그 타입 columnLabels 의 키들을, 아니면
 * 빈 배열을 돌려준다 — person·project·새 종류·미등록 koName 은 빈 배열(그 종류에 코드
 * 칸이 0개라는 정직한 사실). 칸 권위는 columnLabels 이고, 새 종류의 columns slot 칸은
 * 별 통로(concept-type-vocabulary getTypeColumns)가 따로 책임진다.
 */
export function columnLabelKeysOf(typeName: string): string[] {
  if (!isEntityTypeName(typeName)) return [];
  return Object.keys(getEntityTypeMeta(typeName).columnLabels);
}

/**
 * 단계6b — 코드 8종의 한 칸 키가 숫자형인지 글자형인지 돌려준다. numericColumns 에
 * 있으면 "number", 아니면 "text"(default 글자형·정직). 코드 종류 아님(person·project·
 * 새 종류)·미등록 칸은 "text"(그 칸이 코드 메타에 없다는 정직한 사실 — 새 종류 datatype 은
 * concept-type-vocabulary getColumnDataType 가 별 통로로 판정한다).
 */
export function columnDataTypeOf(typeName: string, key: string): ColumnDataType {
  if (!isEntityTypeName(typeName)) return "text";
  const meta = getEntityTypeMeta(typeName);
  const numeric = meta.numericColumns;
  if (meta.dateColumns?.has(key)) return "date";
  return numeric?.has(key) ? "number" : "text";
}
