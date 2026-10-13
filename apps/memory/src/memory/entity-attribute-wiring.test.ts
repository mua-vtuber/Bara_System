/**
 * entity-attribute-wiring.test.ts — 1급 엔티티 칸/라벨/identity 채우기 검증
 * (개념 엔티티 타입 체계 3단계 Task 4, spec §3 3분법·§5·§6.6).
 *
 * 실제 SQLite(:memory:) + 실제 임베딩 store 로 검증한다 — Mock 클래스 0
 * (CLAUDE.md "DB/임베딩 의존 모듈은 실제 구현체와 통합 검증"). stage4 T4 가 8 타입 전용
 * 테이블을 범용 본체 entities 로 흡수해, 행은 store.entitiesRepo.findOrCreateEntity(typeName,
 * name) 로 만들고, 전용 칸은 entity_attributes(is_column=1·snake_case 키)에서 직접 읽어 확인한다.
 *
 * 가르기 단어(유통기한·주소=칸 / 장르·주의사항=라벨)는 registry columnLabels 와
 * concept_type_vocabulary.yaml attributes 단일 출처에 실제로 있는 값을 쓴다 — 그 값이
 * 바뀌면 단일 출처가 흔들린 것이라 테스트가 알려야 한다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import {
  applyEntityAttributes,
  linkEntityIdentity,
} from "./entity-attribute-wiring.ts";
import {
  setItemSynonymOverride,
  clearConceptVocabularyOverrides,
  type ItemSynonymMap,
  type PlacementTypeName,
} from "./concept-type-vocabulary.ts";

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;
const TEST_ORIGIN_NODE_ID = 1;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  db.close();
  // 항목 동의어 override 누출 차단(전역 모듈 캐시) — 다음 테스트는 yaml-only no-op 으로.
  clearConceptVocabularyOverrides();
});

/** 한 타입의 `동의어→대표키` 쌍으로 항목 동의어 override 맵을 만든다(단계2 T4 fixture). */
function itemSynonymOverrideOf(
  type: PlacementTypeName,
  pairs: Array<[alias: string, canonical: string]>,
): ItemSynonymMap {
  const perType = new Map<string, string>();
  for (const [alias, canonical] of pairs) perType.set(alias.toLowerCase(), canonical);
  const m: ItemSynonymMap = new Map();
  m.set(type, perType);
  return m;
}

/**
 * 전용 칸 값을 entity_attributes(is_column=1)에서 직접 읽는다 — stage4 T4 가 전용 테이블
 * 칼럼을 범용 본체 entity_attributes 로 옮긴 뒤, 옛 `.expiresAt`/`.address` 같은 UserEntity
 * 필드 대신 schema 칼럼 이름(snake_case·expires_at·address·usage_instructions·topic)을
 * attr_key 로 조회한다. 안 채운 칸은 행이 없어 null 을 돌려준다(옛 NULL 칸과 같은 의미).
 */
function readColumnAttr(entityId: string, schemaCol: string): string | null {
  const row = db
    .query<{ attr_value: string }, [string, string]>(
      "SELECT attr_value FROM entity_attributes WHERE entity_id = ? AND attr_key = ? AND is_column = 1",
    )
    .get(entityId, schemaCol);
  return row ? row.attr_value : null;
}

test("#섭취:우유 #유통기한:2026-07-01 → intake expires_at 칸 채워짐", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("intake", "우유");
  const result = await applyEntityAttributes(store, "intake", row.id, [
    { key: "유통기한", value: "2026-07-01" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  expect(result.columnKeys).toEqual(["유통기한"]);
  expect(result.labelConceptIds).toEqual([]);
  expect(result.skipped).toEqual([]);

  // 옛 intakes.expires_at 칸 = 이제 entity_attributes(is_column=1·expires_at).
  expect(readColumnAttr(row.id, "expires_at")).toBe("2026-07-01");
});

test("#작품:데못죽 #장르:판타지 → work_concept_edges has_attribute(판타지) 엣지", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
  const result = await applyEntityAttributes(store, "work", row.id, [
    { key: "장르", value: "판타지" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  expect(result.columnKeys).toEqual([]);
  expect(result.labelConceptIds.length).toBe(1);
  expect(result.skipped).toEqual([]);

  const conceptId = result.labelConceptIds[0]!;
  const edges = store.getEntityConceptEdges("work", row.id, "has_attribute");
  expect(edges.map((e) => e.conceptId)).toEqual([conceptId]);

  // 라벨 개념이 진짜 '판타지' 이름의 개념인지 확인.
  const concept = await store.findConceptByName("판타지");
  expect(concept?.conceptId).toBe(conceptId);
});

test("#장소:서울역 #주소:... → place address 칸 (attributes 어휘 밖이어도 columnLabels 가 칸 권위)", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("place", "서울역");
  const result = await applyEntityAttributes(store, "place", row.id, [
    { key: "주소", value: "서울특별시 중구 한강대로 405" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  expect(result.columnKeys).toEqual(["주소"]);
  expect(result.labelConceptIds).toEqual([]);

  // 옛 places.address 칸 = 이제 entity_attributes(is_column=1·address).
  expect(readColumnAttr(row.id, "address")).toBe("서울특별시 중구 한강대로 405");
});

test("사용물 #사용법:... (칸) #주의사항:... (라벨) → 칸·라벨 각각", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("usable", "타이레놀");
  const result = await applyEntityAttributes(store, "usable", row.id, [
    { key: "사용법", value: "1정씩 복용" },
    { key: "주의사항", value: "공복 피하기" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  // 사용법 = 칸, 주의사항 = 라벨.
  expect(result.columnKeys).toEqual(["사용법"]);
  expect(result.labelConceptIds.length).toBe(1);

  // 옛 usables 전용 칸 = 이제 entity_attributes(is_column=1).
  expect(readColumnAttr(row.id, "usage_instructions")).toBe("1정씩 복용");

  const labelConcept = await store.findConceptByName("공복 피하기");
  expect(labelConcept).not.toBeNull();
  const edges = store.getEntityConceptEdges("usable", row.id, "has_attribute");
  expect(edges.map((e) => e.conceptId)).toEqual([labelConcept!.conceptId]);
});

test("자료 #주제:... → material topic 칸 채워짐", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("material", "메모");
  const result = await applyEntityAttributes(store, "material", row.id, [
    { key: "주제", value: "검색 설계" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  expect(result.columnKeys).toEqual(["주제"]);
  expect(result.labelConceptIds).toEqual([]);
  expect(result.skipped).toEqual([]);
  expect(readColumnAttr(row.id, "topic")).toBe("검색 설계");
});

test("자료 #출처:... → 출처는 관계·칸·라벨 모두 아니라 skipped(엣지 0)", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("material", "메모");
  const result = await applyEntityAttributes(store, "material", row.id, [
    { key: "출처", value: "웹" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  expect(result.columnKeys).toEqual([]);
  expect(result.labelConceptIds).toEqual([]);
  expect(result.skipped.map((s) => s.key)).toEqual(["출처"]);
  expect(result.skipped[0]!.reason).toContain("칸 어휘");
  expect(result.skipped[0]!.reason).toContain("라벨 어휘");
  expect(readColumnAttr(row.id, "source")).toBeNull();
  expect(await store.findConceptByName("웹")).toBeNull();
});

test("자료 주제만 입력하면 출처 attr 은 생기지 않는다(출처 완전 제거 회귀)", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("material", "논문");
  await applyEntityAttributes(store, "material", row.id, [
    { key: "주제", value: "메모리" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  expect(readColumnAttr(row.id, "topic")).toBe("메모리");
  // 출처는 더 이상 자료 칸도 관계도 아니므로 entity_attributes 에 행이 없다.
  expect(readColumnAttr(row.id, "source")).toBeNull();
});

test("identity 엣지가 위계 잎 개념과 행을 잇는다(role='identity')", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
  // 위계 잎(같은 이름 concept_node)은 호출 측이 해소 — 여기선 직접 만들어 id 를 넘긴다.
  const leafConceptId = await store.findOrCreateConcept("데못죽", { isTag: true });

  const created = linkEntityIdentity(store, "work", row.id, leafConceptId, "hashtag", TEST_ORIGIN_NODE_ID);
  expect(created).toBe(true);

  // 멱등 — 두 번째 호출은 false(중복 엣지 0).
  const again = linkEntityIdentity(store, "work", row.id, leafConceptId, "hashtag", TEST_ORIGIN_NODE_ID);
  expect(again).toBe(false);

  const identities = store.getEntityConceptEdges("work", row.id, "identity");
  expect(identities.map((e) => e.conceptId)).toEqual([leafConceptId]);
});

test("라벨 어휘에 있는 키만 라벨, 어휘 밖 키는 skipped(silent drop 0·라벨 엣지 0)", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
  const result = await applyEntityAttributes(store, "work", row.id, [
    { key: "장르", value: "판타지" }, // work attributes 어휘 → 라벨.
    { key: "주소", value: "어딘가" }, // work 에는 '주소' 칸·라벨 어휘 둘 다 없음 → skipped.
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  // '장르'만 라벨, '주소'는 어휘 밖이라 건너뜀 — 라벨 엣지는 '장르' 하나뿐.
  expect(result.columnKeys).toEqual([]);
  expect(result.labelConceptIds.length).toBe(1);
  expect(result.skipped.map((s) => s.key)).toEqual(["주소"]);

  const edges = store.getEntityConceptEdges("work", row.id, "has_attribute");
  expect(edges.length).toBe(1); // '주소' 라벨 엣지가 안 생겼다(핵심 회귀 가드).
});

test("#작품:데못죽 #생일:2020-03-01 → 생일은 어느 타입 attributes 에도 없어 skipped(라벨 엣지 0)", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
  const result = await applyEntityAttributes(store, "work", row.id, [
    { key: "생일", value: "2020-03-01" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  // 생일 = 전용 칸 없는 고유 사실. 라벨로 만들면 같은 날짜 무관 개체가 묶여 3분법 위반.
  expect(result.columnKeys).toEqual([]);
  expect(result.labelConceptIds).toEqual([]);
  expect(result.skipped.map((s) => s.key)).toEqual(["생일"]);
  expect(result.skipped[0]!.reason).toContain("3분법");

  const edges = store.getEntityConceptEdges("work", row.id, "has_attribute");
  expect(edges.length).toBe(0); // 라벨 엣지 0 — 고유 날짜가 라벨 개념이 되지 않았다.

  // 생일 값이 개념으로도 새로 안 생겼는지 확인(라벨 경로를 안 탔다).
  const concept = await store.findConceptByName("2020-03-01");
  expect(concept).toBeNull();
});

test("#생물:나비 #종류:고양이 #생일:... → '종류'·'생일' 둘 다 creature 어휘 밖이라 skipped(라벨 엣지 0)", async () => {
  // 커밋 645d43d 가 1층 분류(subcategories: 동물·식물)와 단어가 겹친다는 이유로
  // creature attributes 에서 '종류' 를 뺐다 → creature 의 라벨 어휘는 0개다('주인' 은 관계 키).
  // 그래서 '종류' 도 '생일' 처럼 칸 어휘·라벨 어휘 둘 다 아니라 정직한 skip 으로 떨어진다.
  const row = await store.entitiesRepo.findOrCreateEntity("creature", "나비");
  const result = await applyEntityAttributes(store, "creature", row.id, [
    { key: "종류", value: "고양이" }, // creature attributes 에서 제거됨 → 어휘 밖 skip.
    { key: "생일", value: "2020-03-01" }, // 어휘 밖 → skip.
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  // 핵심 회귀 가드: '생일' 같은 어휘 밖 단어가 라벨로 새지 않고 skipped 에 들어간다.
  // 함께 '종류' 도 더는 creature 라벨이 아니라 어휘 밖 skip 임을 명시한다(645d43d 동작 반영).
  expect(result.columnKeys).toEqual([]);
  expect(result.labelConceptIds).toEqual([]); // 라벨로 만든 개념 0개.
  expect(result.skipped.map((s) => s.key).sort()).toEqual(["생일", "종류"]);
  // 두 키 모두 칸 어휘·라벨 어휘 어느 쪽도 아니라는 사유(silent drop 금지).
  for (const s of result.skipped) {
    expect(s.reason).toContain("칸 어휘");
    expect(s.reason).toContain("라벨 어휘");
  }

  const edges = store.getEntityConceptEdges("creature", row.id, "has_attribute");
  expect(edges.length).toBe(0); // 라벨 엣지 0 — 어휘 밖 단어가 라벨 개념이 되지 않았다.

  // '고양이'·'2020-03-01' 둘 다 라벨 개념으로 새로 안 생겼는지 확인(라벨 경로를 안 탔다).
  expect(await store.findConceptByName("고양이")).toBeNull();
  expect(await store.findConceptByName("2020-03-01")).toBeNull();
});

test("임의 알 수 없는 키(#아무키:값)는 skipped — 라벨로 만들지 않는다", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("thing", "책상");
  const result = await applyEntityAttributes(store, "thing", row.id, [
    { key: "아무키", value: "아무값" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  expect(result.columnKeys).toEqual([]);
  expect(result.labelConceptIds).toEqual([]);
  expect(result.skipped.map((s) => s.key)).toEqual(["아무키"]);

  const edges = store.getEntityConceptEdges("thing", row.id, "has_attribute");
  expect(edges.length).toBe(0);
});

test("빈 값 칸·라벨은 채우지 않고 skipped 에 사유를 남긴다(NULL 유지)", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("usable", "타이레놀");
  const result = await applyEntityAttributes(store, "usable", row.id, [
    { key: "사용법", value: "   " }, // 빈 값 칸 → skip.
    { key: "주의사항", value: "" }, // 빈 값 라벨 → skip.
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  expect(result.columnKeys).toEqual([]);
  expect(result.labelConceptIds).toEqual([]);
  expect(result.skipped.length).toBe(2);
  expect(result.skipped.map((s) => s.key).sort()).toEqual(["사용법", "주의사항"]);

  // 빈 값은 정보가 아니라 entity_attributes 에 행을 안 만든다 → null 유지(옛 NULL 칸).
  expect(readColumnAttr(row.id, "usage_instructions")).toBeNull();
});

test("미존재 엔티티 id 로 칸 갱신을 부르면 식별자와 함께 loud throw(실패 ≠ 빈 결과)", async () => {
  await expect(
    applyEntityAttributes(store, "intake", "itk_nonexistent", [
      { key: "유통기한", value: "2026-07-01" },
    ],
    "hashtag",
    TEST_ORIGIN_NODE_ID),
  ).rejects.toThrow(/itk_nonexistent/);
});

test("사람·프로젝트 타입은 loud throw — 8 타입 전용", async () => {
  await expect(
    applyEntityAttributes(store, "person", "psn_x", [{ key: "직업", value: "개발자" }], "hashtag", TEST_ORIGIN_NODE_ID),
  ).rejects.toThrow(/person/);
  expect(() => linkEntityIdentity(store, "project", "prj_x", "cpt_x", "hashtag", TEST_ORIGIN_NODE_ID)).toThrow(/project/);
});

test("빈 잎 개념 id 로 identity 를 부르면 loud throw", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
  expect(() => linkEntityIdentity(store, "work", row.id, "   ", "hashtag", TEST_ORIGIN_NODE_ID)).toThrow(/잎 개념 id/);
});

// ── 4단계 부분 B 경계 수정 — 관계 키는 라벨이 아니라 관계(라벨 엣지 0·skip 사유 '관계') ──
//
// Task 2 가 yaml attributes 에 관계 키(창작자·주인·관련사람·관련장소)를 넣었다. 옛 labelVocab
// 계산(attributes − 칸)은 관계 키를 라벨 어휘로 빨아들여 `#창작자:아쿠타미` 를 작품→"아쿠타미"
// 라벨 엣지(has_attribute)로 잘못 만들었다(3분법 위반). 부분 B 가 labelVocab 에서 관계 키를
// 빼고 명시 skip 으로 바로잡았다 — 관계 엣지는 wireEntityRelations(Task 4)가 세운다.

test("#작품:데못죽 #창작자:아쿠타미 → 창작자는 관계 키라 라벨 엣지 0·skip 사유 '관계'", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
  const result = await applyEntityAttributes(store, "work", row.id, [
    { key: "창작자", value: "아쿠타미" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  // 창작자는 work attributes 에 있지만 *관계 키*라 라벨로 만들지 않는다(핵심 회귀 가드).
  expect(result.columnKeys).toEqual([]);
  expect(result.labelConceptIds).toEqual([]);
  expect(result.skipped.map((s) => s.key)).toEqual(["창작자"]);
  expect(result.skipped[0]!.reason).toContain("관계");

  // 라벨 엣지가 0 이다 — '아쿠타미' 가 작품 라벨 개념으로 새지 않았다.
  const edges = store.getEntityConceptEdges("work", row.id, "has_attribute");
  expect(edges.length).toBe(0);

  // '아쿠타미' 가 라벨 개념으로도 새로 안 생겼는지 확인(라벨 경로를 안 탔다).
  const concept = await store.findConceptByName("아쿠타미");
  expect(concept).toBeNull();
});

test("#생물:보리 #주인:엄마 #종류:강아지 → '주인' 은 관계 키라 skip(관계)·'종류' 는 어휘 밖 skip(라벨 엣지 0)", async () => {
  // 커밋 645d43d 가 creature attributes 에서 '종류' 를 빼, creature 의 라벨 어휘는 0개다
  // ('주인' 은 관계 키). 그래서 '주인' 은 관계로, '종류' 는 어휘 밖으로 각각 다른 사유로 skip 되고,
  // 라벨 엣지는 하나도 생기지 않는다.
  const row = await store.entitiesRepo.findOrCreateEntity("creature", "보리");
  const result = await applyEntityAttributes(store, "creature", row.id, [
    { key: "주인", value: "엄마" }, // creature 관계 키 → skip(관계).
    { key: "종류", value: "강아지" }, // creature attributes 에서 제거됨 → 어휘 밖 skip.
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  // 핵심 회귀 가드: '주인' 같은 관계 키가 라벨로 안 새고 skip 사유가 '관계' 다.
  const owner = result.skipped.find((s) => s.key === "주인");
  expect(owner).toBeDefined();
  expect(owner!.reason).toContain("관계");

  // '종류' 는 더는 creature 라벨이 아니라 칸 어휘·라벨 어휘 어느 쪽도 아닌 어휘 밖 skip 이다.
  const kind = result.skipped.find((s) => s.key === "종류");
  expect(kind).toBeDefined();
  expect(kind!.reason).toContain("칸 어휘");
  expect(kind!.reason).toContain("라벨 어휘");

  // 두 키 다 skip — 라벨로 만든 개념 0개.
  expect(result.columnKeys).toEqual([]);
  expect(result.labelConceptIds).toEqual([]);
  expect(result.skipped.map((s) => s.key).sort()).toEqual(["주인", "종류"].sort());

  // 라벨 엣지 0 — '엄마'·'강아지' 둘 다 생물 라벨로 안 샜다.
  const edges = store.getEntityConceptEdges("creature", row.id, "has_attribute");
  expect(edges.length).toBe(0);
  expect(await store.findConceptByName("엄마")).toBeNull();
  expect(await store.findConceptByName("강아지")).toBeNull();
});

test("#일정:미팅 #관련사람:민수 #관련장소:서울 → 관계 키 둘 다 skip(라벨 엣지 0)", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("schedule", "미팅");
  const result = await applyEntityAttributes(store, "schedule", row.id, [
    { key: "관련사람", value: "민수" }, // schedule 관계 키 → skip.
    { key: "관련장소", value: "서울" }, // schedule 관계 키 → skip.
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  expect(result.columnKeys).toEqual([]);
  expect(result.labelConceptIds).toEqual([]);
  expect(result.skipped.map((s) => s.key).sort()).toEqual(["관련사람", "관련장소"]);
  for (const s of result.skipped) expect(s.reason).toContain("관계");

  const edges = store.getEntityConceptEdges("schedule", row.id, "has_attribute");
  expect(edges.length).toBe(0);
});

// ── 일정 전용 날짜 칸 제거(spec 2026-06-28 옵션 B·S3) — "날짜" 는 칸도 라벨도 아니다 ──
//
// `#일정:치과 #날짜:2026-07-15` 본문 입력의 엔티티 배치 경로에서 "날짜" 가 어떻게 풀리는지
// 본다. 옛날엔 schedule columnLabels {날짜:eventAt} 라 entity_attributes(is_column=1·event_at)
// 에 갇혀 글 event_at 시간 검색에 안 잡히는 함정이었다. 칸·yaml 라벨에서 빼 0칸 종류가 된 뒤
// "날짜" 는 칸도 라벨도 아니라 정직한 skip(사유 기록)으로 떨어진다(silent drop 아님). 일정
// 날짜의 정상 통로는 글 event_at(달력 위젯·본문 #날짜: reserved key) 하나다.

test("#일정:치과 #날짜:2026-07-15 → '날짜' 는 칸도 라벨도 아니라 정직한 skip(글-칸 0)", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("schedule", "치과");
  const result = await applyEntityAttributes(store, "schedule", row.id, [
    { key: "날짜", value: "2026-07-15" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);

  // 칸도 라벨도 아니다 — own 칸 0·라벨 엣지 0·정직한 skip 한 건(사유 기록).
  expect(result.columnKeys).toEqual([]);
  expect(result.labelConceptIds).toEqual([]);
  expect(result.skipped.map((s) => s.key)).toEqual(["날짜"]);
  // 사유는 "칸 어휘도 라벨 어휘도 아니라" — 알 수 없는 키 갈래(silent drop 금지).
  expect(result.skipped[0]!.reason).toContain("칸 어휘");
  expect(result.skipped[0]!.reason).toContain("라벨 어휘");

  // entity_attributes 에 event_at 칸이 안 생겼다(옛 함정 경로가 닫힘).
  expect(readColumnAttr(row.id, "event_at")).toBeNull();

  // has_attribute 라벨 엣지도 0 — "2026-07-15" 가 라벨 개념으로 안 샜다.
  const edges = store.getEntityConceptEdges("schedule", row.id, "has_attribute");
  expect(edges.length).toBe(0);
  expect(await store.findConceptByName("2026-07-15")).toBeNull();
});

// 동의어 "약속"·"기한"(schedule synonyms)으로 분류돼도 같다 — "날짜" 는 어느 입력으로 와도
// schedule 의 칸·라벨이 아니다. 입력 키가 schedule 의 어휘를 못 통과함을 한 번 더 잠근다.
test("일정 동의어로 와도 '날짜' 칸·라벨 없음(getTypeAttributes 에 '날짜' 부재)", async () => {
  const row = await store.entitiesRepo.findOrCreateEntity("schedule", "회식");
  const result = await applyEntityAttributes(store, "schedule", row.id, [
    { key: "날짜", value: "2026-08-01" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);
  expect(result.columnKeys).toEqual([]);
  expect(result.labelConceptIds).toEqual([]);
  expect(result.skipped.map((s) => s.key)).toEqual(["날짜"]);
});

// ── 단계2 T4: 라벨 매칭 항목 동의어 합류 ──────────────────────────────────────

test("항목 동의어 미등록 시 byte 동일 — '갈래' 는 라벨 어휘 아니라 skip(회귀 0)", async () => {
  // 동의어 override 미주입 → getCanonicalItemKey 가 입력 그대로 → '갈래' 는 work 라벨 아님.
  const row = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
  const result = await applyEntityAttributes(store, "work", row.id, [
    { key: "갈래", value: "판타지" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);
  expect(result.labelConceptIds).toEqual([]);
  expect(result.skipped.map((s) => s.key)).toEqual(["갈래"]);
});

test("'갈래'='장르' 동의어 등록 후 #갈래:판타지 가 '장르' 라벨로 합류(같은 has_attribute 개념)", async () => {
  // '갈래' → 대표키 '장르'(work 라벨). 정규화로 라벨 어휘를 통과해 has_attribute(판타지).
  setItemSynonymOverride(itemSynonymOverrideOf("work", [["갈래", "장르"]]));
  const row = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
  const result = await applyEntityAttributes(store, "work", row.id, [
    { key: "갈래", value: "판타지" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);
  expect(result.skipped).toEqual([]);
  expect(result.labelConceptIds.length).toBe(1);

  // 대표키 '장르' 로 직접 넣은 글과 *같은* has_attribute 개념(판타지)으로 합류하는지 확인.
  const fantasy = await store.findConceptByName("판타지");
  expect(fantasy).not.toBeNull();
  const edges = store.getEntityConceptEdges("work", row.id, "has_attribute");
  expect(edges.length).toBe(1);
});

test("동의어 '갈래'·대표키 '장르' 두 키가 같은 개념값이면 같은 엣지(멱등 합류)", async () => {
  setItemSynonymOverride(itemSynonymOverrideOf("work", [["갈래", "장르"]]));
  const row = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
  const result = await applyEntityAttributes(store, "work", row.id, [
    { key: "장르", value: "판타지" }, // 대표키 직접.
    { key: "갈래", value: "판타지" }, // 동의어 → 같은 값.
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);
  // 둘 다 같은 has_attribute(판타지) 엣지 — 멱등이라 엣지 1개.
  const edges = store.getEntityConceptEdges("work", row.id, "has_attribute");
  expect(edges.length).toBe(1);
  expect(result.skipped).toEqual([]);
});

test("관계 키 대표값을 가리키는 동의어도 skip — 3분법 경계(정규화 전후 모두 막힘)", async () => {
  // '글쓴이' → 대표키 '작가'(work 관계 키). 정규화해도 관계 키라 라벨로 안 샌다.
  setItemSynonymOverride(itemSynonymOverrideOf("work", [["글쓴이", "작가"]]));
  const row = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");
  const result = await applyEntityAttributes(store, "work", row.id, [
    { key: "글쓴이", value: "아쿠타미" },
  ],
  "hashtag",
  TEST_ORIGIN_NODE_ID);
  expect(result.labelConceptIds).toEqual([]);
  expect(result.skipped.map((s) => s.key)).toEqual(["글쓴이"]);
  expect(result.skipped[0]!.reason).toContain("관계");
  // '아쿠타미' 가 라벨 개념으로 안 새로 생겼는지.
  expect(await store.findConceptByName("아쿠타미")).toBeNull();
});
