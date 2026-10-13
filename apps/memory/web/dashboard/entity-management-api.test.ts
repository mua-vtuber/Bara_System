/**
 * entity-management-api.test.ts — 엔티티 관리 조인 순수 함수 검증 (엔티티 관리 통합 S6).
 *
 * 검증 정신 — fetch mock 0·Mock 객체 0:
 *   buildEntityManagementRows 는 *순수 함수*다. 세 라우트가 준 데이터(데이터 fixture)만
 *   입력해 표 행 배열을 만든다. 네트워크·인터페이스 가짜 구현을 일절 안 건드린다.
 *
 * 검증 갈래:
 *   1) 종류별 동의어·하위분류·칸·라벨이 올바르게 모인다.
 *   2) 끈 값(overrides 매칭) 제외 — 소문자 비교 포함.
 *   3) 관계 키(relationKey) 라벨에서 제외(표시 안 함).
 *   4) user/yaml 출처 칩 id 보존(삭제 게이트 자료).
 */

import { describe, test, expect } from "bun:test";
import {
  buildEntityManagementRows,
  buildDisabledChips,
  buildTypeRelations,
  buildColumnChips,
  type EntityManagementData,
} from "./entity-management-api";
import type { ClassifyVocabRow } from "./classify-vocab-panel-api";
import type { EntityTypeRow } from "./entity-types-panel-api";
import type { RelationVocabRow } from "./relation-vocab-panel-api";

const aliasColumn = {
  key: "별칭",
  dataType: "text" as const,
  semantic: "alias" as const,
  helpText: "이름 대신 사용 할 수 있음",
  id: null,
};

function typeRow(overrides: Partial<EntityTypeRow> = {}): EntityTypeRow {
  return {
    typeName: "work",
    koName: "작품",
    idPrefix: null,
    source: "code",
    columns: [],
    ...overrides,
  };
}

function vocabRow(overrides: Partial<ClassifyVocabRow> = {}): ClassifyVocabRow {
  return {
    id: null,
    typeName: "work",
    slot: "synonyms",
    value: "소설",
    source: "yaml",
    ...overrides,
  };
}

function makeData(overrides: Partial<EntityManagementData> = {}): EntityManagementData {
  return {
    entityTypes: [typeRow()],
    vocab: { entries: [], overrides: [] },
    relationKeys: [],
    relationVocab: [],
    ...overrides,
  };
}

function relRow(overrides: Partial<RelationVocabRow> = {}): RelationVocabRow {
  return {
    relationKey: "창작자",
    relationName: "created_by",
    sourceTypes: ["work"],
    targetTypes: ["person"],
    defaultTargetType: "person",
    source: "code",
    ...overrides,
  };
}

describe("buildEntityManagementRows — 조인 순수 함수", () => {
  test("종류별 동의어·하위분류·라벨이 올바르게 모인다", () => {
    const data = makeData({
      entityTypes: [typeRow({ typeName: "work", koName: "작품" })],
      vocab: {
        entries: [
          vocabRow({ typeName: "work", slot: "synonyms", value: "소설" }),
          vocabRow({ typeName: "work", slot: "synonyms", value: "만화" }),
          vocabRow({ typeName: "work", slot: "subcategories", value: "장편" }),
          vocabRow({ typeName: "work", slot: "attributes", value: "연재중" }),
        ],
        overrides: [],
      },
    });
    const rows = buildEntityManagementRows(data);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.synonyms.map((c) => c.value)).toEqual(["소설", "만화"]);
    expect(row.subcategories.map((c) => c.value)).toEqual(["장편"]);
    expect(row.columns).toEqual([aliasColumn]);
    expect(row.labels.map((c) => c.value)).toEqual(["연재중"]);
  });

  test("종류별 칸도 표 행에 싣는다(글자형/숫자형 dataType 포함)", () => {
    const data = makeData({
      entityTypes: [
        typeRow({
          typeName: "ledger",
          koName: "가계부",
          source: "user",
          columns: [
            { key: "금액", label: "금액", dataType: "number" },
            { key: "메모", label: "메모", dataType: "text" },
          ],
        }),
      ],
      vocab: {
        entries: [
          vocabRow({ id: "c1", typeName: "ledger", slot: "columns", value: "금액", source: "user" }),
        ],
        overrides: [],
      },
    });
    const rows = buildEntityManagementRows(data);
    expect(rows[0]!.columns).toEqual([
      { key: "금액", dataType: "number", id: "c1" },
      { key: "메모", dataType: "text", id: null },
    ]);
  });

  test("다른 종류의 어휘는 그 종류 행에만 묶인다(교차 누수 0)", () => {
    const data = makeData({
      entityTypes: [
        typeRow({ typeName: "work", koName: "작품" }),
        typeRow({ typeName: "person", koName: "사람" }),
      ],
      vocab: {
        entries: [
          vocabRow({ typeName: "work", slot: "synonyms", value: "소설" }),
          vocabRow({ typeName: "person", slot: "synonyms", value: "작가" }),
        ],
        overrides: [],
      },
    });
    const rows = buildEntityManagementRows(data);
    const work = rows.find((r) => r.typeName === "work")!;
    const person = rows.find((r) => r.typeName === "person")!;
    expect(work.synonyms.map((c) => c.value)).toEqual(["소설"]);
    expect(person.synonyms.map((c) => c.value)).toEqual(["작가"]);
  });

  test("끈 값(overrides 매칭)은 칩에서 제외", () => {
    const data = makeData({
      entityTypes: [typeRow({ typeName: "work" })],
      vocab: {
        entries: [
          vocabRow({ typeName: "work", slot: "synonyms", value: "소설" }),
          vocabRow({ typeName: "work", slot: "synonyms", value: "만화" }),
        ],
        overrides: [
          { id: "ov1", typeName: "work", slot: "synonyms", value: "만화", kind: "tombstone" },
        ],
      },
    });
    const rows = buildEntityManagementRows(data);
    // '만화'는 꺼졌으니 빠지고 '소설'만 남는다(방법2 — 흐리게도 안 보임).
    expect(rows[0]!.synonyms.map((c) => c.value)).toEqual(["소설"]);
  });

  test("끈 값 매칭은 소문자 비교 — 대소문자 다른 override 도 제외", () => {
    const data = makeData({
      entityTypes: [typeRow({ typeName: "work" })],
      vocab: {
        entries: [vocabRow({ typeName: "work", slot: "attributes", value: "Manga" })],
        // override value 는 소문자 'manga' — 가림표 UNIQUE 소문자 정합. 소문자 비교라 매칭돼야.
        overrides: [
          { id: "ov1", typeName: "work", slot: "attributes", value: "manga", kind: "tombstone" },
        ],
      },
    });
    const rows = buildEntityManagementRows(data);
    expect(rows[0]!.labels.length).toBe(0);
  });

  test("끈 값은 같은 (종류, slot, 값) 만 매칭 — slot 다르면 안 빠진다", () => {
    const data = makeData({
      entityTypes: [typeRow({ typeName: "work" })],
      vocab: {
        entries: [
          vocabRow({ typeName: "work", slot: "synonyms", value: "소설" }),
          vocabRow({ typeName: "work", slot: "subcategories", value: "소설" }),
        ],
        // synonyms 의 '소설'만 끈다 — subcategories 의 '소설'은 그대로.
        overrides: [
          { id: "ov1", typeName: "work", slot: "synonyms", value: "소설", kind: "tombstone" },
        ],
      },
    });
    const rows = buildEntityManagementRows(data);
    expect(rows[0]!.synonyms.length).toBe(0);
    expect(rows[0]!.subcategories.map((c) => c.value)).toEqual(["소설"]);
  });

  test("관계 키(relationKey)는 라벨에서 제외(표시 안 함·D3)", () => {
    const data = makeData({
      entityTypes: [typeRow({ typeName: "work" })],
      vocab: {
        entries: [
          vocabRow({ typeName: "work", slot: "attributes", value: "주인" }),
          vocabRow({ typeName: "work", slot: "attributes", value: "연재중" }),
        ],
        overrides: [],
      },
      relationKeys: ["주인", "창작자"],
    });
    const rows = buildEntityManagementRows(data);
    // '주인'은 관계 키라 라벨에서 빠지고 '연재중'만 남는다.
    expect(rows[0]!.labels.map((c) => c.value)).toEqual(["연재중"]);
  });

  test("관계 키 제외는 라벨(attributes)만 — 동의어·하위분류는 안 건드린다", () => {
    const data = makeData({
      entityTypes: [typeRow({ typeName: "work" })],
      vocab: {
        entries: [
          vocabRow({ typeName: "work", slot: "synonyms", value: "주인" }),
          vocabRow({ typeName: "work", slot: "attributes", value: "주인" }),
        ],
        overrides: [],
      },
      relationKeys: ["주인"],
    });
    const rows = buildEntityManagementRows(data);
    // 동의어의 '주인'은 그대로(관계 키 제외는 라벨 한정), 라벨의 '주인'만 빠진다.
    expect(rows[0]!.synonyms.map((c) => c.value)).toEqual(["주인"]);
    expect(rows[0]!.labels.length).toBe(0);
  });

  test("칸 키(columns)는 라벨에서 제외 — 칸으로 분류되는 '날짜'가 라벨에 유령으로 안 보인다", () => {
    // 일정(schedule)의 attributes 에 칸 키 '날짜'와 진짜 라벨 '장르'가 둘 다 있고, 그 종류
    // columns 에 '날짜' 칸이 있을 때 → 라벨 결과엔 '날짜' 없고 '장르'만(표시 버그 차단).
    const data = makeData({
      entityTypes: [
        typeRow({
          typeName: "schedule",
          koName: "일정",
          columns: [{ key: "날짜", label: "날짜", dataType: "text" }],
        }),
      ],
      vocab: {
        entries: [
          vocabRow({ typeName: "schedule", slot: "attributes", value: "날짜" }),
          vocabRow({ typeName: "schedule", slot: "attributes", value: "장르" }),
        ],
        overrides: [],
      },
    });
    const rows = buildEntityManagementRows(data);
    // '날짜'는 칸 키라 라벨에서 빠지고 '장르'만 남는다(칸은 칸 섹션에 따로 유지·정렬용 보존).
    expect(rows[0]!.labels.map((c) => c.value)).toEqual(["장르"]);
  });

  test("칸 키 제외는 key·label 둘 다 — label 로만 겹쳐도 라벨에서 뺀다", () => {
    // 칸의 key 와 label 이 다를 때(영문키 vs 표시명), attributes 가 어느 쪽과 겹쳐도 라벨에서
    // 빠진다(buildColumnChips 배지 출처가 label 이라 둘 다 막아야 유령이 안 남는다).
    const data = makeData({
      entityTypes: [
        typeRow({
          typeName: "ledger",
          koName: "가계부",
          columns: [{ key: "amount", label: "금액", dataType: "number" }],
        }),
      ],
      vocab: {
        entries: [
          vocabRow({ typeName: "ledger", slot: "attributes", value: "금액" }),
          vocabRow({ typeName: "ledger", slot: "attributes", value: "메모태그" }),
        ],
        overrides: [],
      },
    });
    const rows = buildEntityManagementRows(data);
    // label '금액'과 겹친 attributes 는 빠지고 '메모태그'만 남는다.
    expect(rows[0]!.labels.map((c) => c.value)).toEqual(["메모태그"]);
  });

  test("칸 키 제외는 라벨(attributes)만 — 동의어·하위분류는 안 건드린다", () => {
    const data = makeData({
      entityTypes: [
        typeRow({
          typeName: "schedule",
          columns: [{ key: "날짜", label: "날짜", dataType: "text" }],
        }),
      ],
      vocab: {
        entries: [
          vocabRow({ typeName: "schedule", slot: "synonyms", value: "날짜" }),
          vocabRow({ typeName: "schedule", slot: "attributes", value: "날짜" }),
        ],
        overrides: [],
      },
    });
    const rows = buildEntityManagementRows(data);
    // 동의어의 '날짜'는 그대로(칸 키 제외는 라벨 한정), 라벨의 '날짜'만 빠진다.
    expect(rows[0]!.synonyms.map((c) => c.value)).toEqual(["날짜"]);
    expect(rows[0]!.labels.length).toBe(0);
  });

  test("user 칩은 id 보존(삭제 게이트), yaml 칩은 id=null(읽기전용)", () => {
    const data = makeData({
      entityTypes: [typeRow({ typeName: "work" })],
      vocab: {
        entries: [
          vocabRow({ id: null, typeName: "work", slot: "synonyms", value: "소설", source: "yaml" }),
          vocabRow({ id: "u1", typeName: "work", slot: "synonyms", value: "장편소설", source: "user" }),
        ],
        overrides: [],
      },
    });
    const rows = buildEntityManagementRows(data);
    const chips = rows[0]!.synonyms;
    const yamlChip = chips.find((c) => c.value === "소설")!;
    const userChip = chips.find((c) => c.value === "장편소설")!;
    expect(yamlChip.source).toBe("yaml");
    expect(yamlChip.id).toBeNull();
    expect(userChip.source).toBe("user");
    expect(userChip.id).toBe("u1");
  });

  test("user 종류는 deletableTypeName 보유, code 종류는 null(읽기전용)", () => {
    const data = makeData({
      entityTypes: [
        typeRow({ typeName: "work", source: "code" }),
        typeRow({ typeName: "equipment", koName: "장비", source: "user" }),
      ],
    });
    const rows = buildEntityManagementRows(data);
    expect(rows.find((r) => r.typeName === "work")!.deletableTypeName).toBeNull();
    expect(rows.find((r) => r.typeName === "equipment")!.deletableTypeName).toBe("equipment");
  });

  test("종류가 0개면 빈 행 배열(정직한 빈 상태)", () => {
    const rows = buildEntityManagementRows(makeData({ entityTypes: [] }));
    expect(rows).toEqual([]);
  });

  test("어휘 없는 종류도 행은 보인다(칩 배열은 빈 채)", () => {
    const data = makeData({
      entityTypes: [typeRow({ typeName: "project", koName: "프로젝트" })],
      vocab: { entries: [], overrides: [] },
    });
    const rows = buildEntityManagementRows(data);
    expect(rows.length).toBe(1);
    expect(rows[0]!.synonyms).toEqual([]);
    expect(rows[0]!.subcategories).toEqual([]);
    expect(rows[0]!.columns).toEqual([aliasColumn]);
    expect(rows[0]!.labels).toEqual([]);
  });
});

describe("buildDisabledChips — 종류별 끈 칩 순수 함수(S7b)", () => {
  test("그 종류의 끈 값을 slot 과 함께 모은다", () => {
    const data = makeData({
      vocab: {
        entries: [],
        overrides: [
          { id: "ov1", typeName: "work", slot: "synonyms", value: "만화", kind: "tombstone" },
          { id: "ov2", typeName: "work", slot: "attributes", value: "절판", kind: "tombstone" },
        ],
      },
    });
    const chips = buildDisabledChips(data, "work");
    expect(chips).toEqual([
      { value: "만화", slot: "synonyms" },
      { value: "절판", slot: "attributes" },
    ]);
  });

  test("다른 종류의 끈 값은 안 섞인다(typeName 정확 매칭)", () => {
    const data = makeData({
      vocab: {
        entries: [],
        overrides: [
          { id: "ov1", typeName: "work", slot: "synonyms", value: "만화", kind: "tombstone" },
          { id: "ov2", typeName: "person", slot: "synonyms", value: "작가", kind: "tombstone" },
        ],
      },
    });
    expect(buildDisabledChips(data, "work")).toEqual([{ value: "만화", slot: "synonyms" }]);
    expect(buildDisabledChips(data, "person")).toEqual([{ value: "작가", slot: "synonyms" }]);
  });

  test("끄기 대상 3칸(synonyms·subcategories·attributes) 밖 slot 은 끈 칩에서 빠진다", () => {
    const data = makeData({
      vocab: {
        entries: [],
        overrides: [
          { id: "ov1", typeName: "work", slot: "synonyms", value: "만화", kind: "tombstone" },
          // columns·item_synonym 은 끄기 대상 칸이 아니라(라우트 OVERRIDE_SLOTS 밖) 무시.
          { id: "ov2", typeName: "work", slot: "columns", value: "가격", kind: "tombstone" },
        ],
      },
    });
    expect(buildDisabledChips(data, "work")).toEqual([{ value: "만화", slot: "synonyms" }]);
  });

  test("끈 값 value 는 가림표에 담긴 그대로 돌려준다(소문자 정규화 정합)", () => {
    const data = makeData({
      vocab: {
        entries: [],
        // 가림표 value 는 소문자 정규화돼 저장된다(UNIQUE 정합). 그대로 돌려준다.
        overrides: [
          { id: "ov1", typeName: "work", slot: "attributes", value: "manga", kind: "tombstone" },
        ],
      },
    });
    expect(buildDisabledChips(data, "work")).toEqual([{ value: "manga", slot: "attributes" }]);
  });

  test("끈 값 0건이면 빈 배열(정직한 빈 상태)", () => {
    const data = makeData({ vocab: { entries: [], overrides: [] } });
    expect(buildDisabledChips(data, "work")).toEqual([]);
  });
});

describe("buildTypeRelations — 그 종류 출발 관계 순수 함수(S7b·모달 편입)", () => {
  test("그 종류가 출발(source)인 관계만 거른다", () => {
    const all = [
      relRow({ relationKey: "주인", sourceTypes: ["work"] }),
      relRow({ relationKey: "참여자", sourceTypes: ["project"] }),
      relRow({ relationKey: "창작자", sourceTypes: ["work"] }),
    ];
    const works = buildTypeRelations(all, "work");
    expect(works.map((r) => r.relationKey)).toEqual(["주인", "창작자"]);
  });

  test("타 종류 출발 관계는 안 섞인다(교차 누수 0)", () => {
    const all = [
      relRow({ relationKey: "주인", sourceTypes: ["work"] }),
      relRow({ relationKey: "참여자", sourceTypes: ["project"] }),
    ];
    expect(buildTypeRelations(all, "project").map((r) => r.relationKey)).toEqual(["참여자"]);
    expect(buildTypeRelations(all, "person")).toEqual([]);
  });

  test("출발 종류가 여럿인 관계는 그 중 하나가 그 종류면 포함된다(sourceTypes 다중)", () => {
    const all = [
      relRow({ relationKey: "출처", sourceTypes: ["work", "project"] }),
      relRow({ relationKey: "주인", sourceTypes: ["work"] }),
    ];
    // work 도 project 도 '출처' 관계를 출발로 본다(sourceTypes 다중 포함).
    expect(buildTypeRelations(all, "work").map((r) => r.relationKey)).toEqual(["출처", "주인"]);
    expect(buildTypeRelations(all, "project").map((r) => r.relationKey)).toEqual(["출처"]);
  });

  test("그 종류 출발 관계 0건이면 빈 배열(정직한 빈 상태)", () => {
    const all = [relRow({ relationKey: "주인", sourceTypes: ["work"] })];
    expect(buildTypeRelations(all, "person")).toEqual([]);
  });

  test("관계 전체가 빈 목록이면 빈 배열", () => {
    expect(buildTypeRelations([], "work")).toEqual([]);
  });
});

// ── buildColumnChips — entity-types columns[] + vocab.entries columns slot 조인 (S8) ──

describe("buildColumnChips — 칸 칩 조인(배지·삭제 id·source 가름)", () => {
  test("entity-types columns[] 로 칸 키·dataType 배지를 그린다(뼈대 출처)", () => {
    const data = makeData({
      entityTypes: [
        typeRow({
          typeName: "ledger",
          koName: "가계부",
          source: "user",
          columns: [
            { key: "금액", label: "금액", dataType: "number" },
            { key: "메모", label: "메모", dataType: "text" },
          ],
        }),
      ],
    });
    const chips = buildColumnChips(data, "ledger");
    expect(chips.map((c) => c.key)).toEqual(["금액", "메모"]);
    expect(chips.map((c) => c.dataType)).toEqual(["number", "text"]);
  });

  test("user 종류 — vocab.entries columns slot user 행의 entry_id 를 삭제 id 로 단다(조인)", () => {
    const data = makeData({
      entityTypes: [
        typeRow({
          typeName: "ledger",
          source: "user",
          columns: [{ key: "금액", label: "금액", dataType: "number" }],
        }),
      ],
      vocab: {
        entries: [
          vocabRow({ id: "cv1", typeName: "ledger", slot: "columns", value: "금액", source: "user" }),
        ],
        overrides: [],
      },
    });
    const chips = buildColumnChips(data, "ledger");
    expect(chips[0]!.id).toBe("cv1");
  });

  test("code 종류 칸 — vocab.entries 에 매칭 user 행이 없어 삭제 id null(읽기전용)", () => {
    const data = makeData({
      entityTypes: [
        typeRow({
          typeName: "intake",
          source: "code",
          columns: [{ key: "유통기한", label: "유통기한", dataType: "date" }],
        }),
      ],
      vocab: { entries: [], overrides: [] },
    });
    const chips = buildColumnChips(data, "intake");
    expect(chips[0]!.id).toBeNull();
  });

  test("사람·작품·프로젝트에는 별칭 안내 칩을 덧붙인다", () => {
    const data = makeData({
      entityTypes: [
        typeRow({ typeName: "person", koName: "사람" }),
        typeRow({ typeName: "work", koName: "작품" }),
        typeRow({ typeName: "project", koName: "프로젝트" }),
        typeRow({ typeName: "intake", koName: "섭취" }),
      ],
    });

    expect(buildColumnChips(data, "person")).toContainEqual(aliasColumn);
    expect(buildColumnChips(data, "work")).toContainEqual(aliasColumn);
    expect(buildColumnChips(data, "project")).toContainEqual(aliasColumn);
    expect(buildColumnChips(data, "intake")).not.toContainEqual(aliasColumn);
  });

  test("타 종류 칸은 안 섞인다(typeName 정확 비교·columns slot 한정)", () => {
    const data = makeData({
      entityTypes: [
        typeRow({
          typeName: "ledger",
          source: "user",
          columns: [{ key: "금액", label: "금액", dataType: "number" }],
        }),
      ],
      vocab: {
        entries: [
          // 타 종류(other)의 금액 칸 user 행 — ledger 조인에 안 섞여야 한다.
          vocabRow({ id: "other1", typeName: "other", slot: "columns", value: "금액", source: "user" }),
          // 같은 종류이지만 columns 가 아닌 slot — 삭제 id 출처가 아니다.
          vocabRow({ id: "lbl1", typeName: "ledger", slot: "attributes", value: "금액", source: "user" }),
        ],
        overrides: [],
      },
    });
    const chips = buildColumnChips(data, "ledger");
    // ledger 의 columns slot user 행이 없으니 삭제 id 는 null(other·attributes 안 섞임).
    expect(chips[0]!.id).toBeNull();
  });

  test("칸 0개면 빈 배열(정직한 빈 상태)", () => {
    const data = makeData({
      entityTypes: [typeRow({ typeName: "ledger", source: "user", columns: [] })],
    });
    expect(buildColumnChips(data, "ledger")).toEqual([]);
  });

  test("없는 종류면 빈 배열", () => {
    const data = makeData({ entityTypes: [typeRow({ typeName: "work" })] });
    expect(buildColumnChips(data, "없는종류")).toEqual([]);
  });
});
