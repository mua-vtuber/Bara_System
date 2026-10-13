/**
 * entity-relation-target.test.ts — 관계 태그 파싱 + target 엔티티 해석 검증
 * (개념 엔티티 타입 체계 4단계 Task 3).
 *
 * 두 갈래를 가른다:
 *   - parseRelationTags — 순수 함수라 데이터 fixture(문자열 입력 → 산출 검증).
 *   - resolveRelationTarget — DB 의존이라 실제 SQLite + 실제 임베딩 store 로 통합 검증
 *     (Mock 클래스 0 — CLAUDE.md "DB/임베딩 의존 모듈은 실제 구현체와 통합 검증").
 *     셋업 양식은 entity-placement-wiring.test.ts 를 복제한다.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import {
  isSkippedTarget,
  parseRelationTags,
  resolveRelationTarget,
  type SameDocTypeHint,
} from "./entity-relation-target.ts";
import { lookupRelationTag, type RelationSpec } from "./entity-relation-vocabulary.ts";

describe("parseRelationTags — 관계 태그 식별(칸/라벨과 갈래 분리)", () => {
  test("관계 태그(#창작자:아쿠타미)만 골라낸다", () => {
    const tags = parseRelationTags("데못죽 좋다 #작품:데못죽 #창작자:아쿠타미");
    expect(tags).toHaveLength(1);
    expect(tags[0]!.rawKey).toBe("창작자");
    expect(tags[0]!.value).toBe("아쿠타미");
    expect(tags[0]!.spec.relation).toBe("created_by");
  });

  test("칸/라벨/일반 분류 태그는 제외한다(관계 키 아님)", () => {
    // #작품(타입 선언)·#장르(라벨)·#유통기한(칸)은 관계 키가 아니라 lookupRelationTag null → 제외.
    const tags = parseRelationTags(
      "#작품:데못죽 #장르:판타지 #유통기한:2026-07-01",
    );
    expect(tags).toHaveLength(0);
  });

  test("관계 태그와 비관계 태그가 섞이면 관계만 남긴다", () => {
    const tags = parseRelationTags("#생물:보리 #주인:엄마 #장르:없음");
    expect(tags.map((t) => t.rawKey)).toEqual(["주인"]);
    expect(tags[0]!.spec.relation).toBe("owned_by");
  });

  test("관계 키 여러 개를 순서대로 모은다", () => {
    const tags = parseRelationTags(
      "#일정:미팅 #관련사람:철수 #관련장소:서울",
    );
    expect(tags.map((t) => t.rawKey)).toEqual(["관련사람", "관련장소"]);
    expect(tags.map((t) => t.spec.relation)).toEqual([
      "related_person",
      "located_at",
    ]);
  });

  test("빈 입력·공백만 든 값은 결과 0(거짓 엣지 0)", () => {
    expect(parseRelationTags("")).toHaveLength(0);
    // 콜론 정규식 자체가 빈 value 를 안 잡으므로, 비관계 평면 해시태그도 0.
    expect(parseRelationTags("#창작자 #출처")).toHaveLength(0);
  });

  test("관계 키 대소문자(외부 fork 영어 키) 정규화 — lookupRelationTag 와 같은 규칙", () => {
    // 현재 관계 키는 전부 한국어라 한국어는 변동 0임을 함께 확인.
    expect(lookupRelationTag("창작자")?.relation).toBe("created_by");
    expect(lookupRelationTag("유통기한")).toBeNull();
    expect(lookupRelationTag("출처")).toBeNull();
  });
});

describe("resolveRelationTarget — target 엔티티 해석(실제 DB·실 임베딩)", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;

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
  });

  test("사람 target(#창작자:아쿠타미) = findOrCreatePersonByName 으로 person 행 생성", async () => {
    const spec = lookupRelationTag("창작자")!;
    const result = await resolveRelationTarget(store, spec, "아쿠타미");
    expect(isSkippedTarget(result)).toBe(false);
    if (isSkippedTarget(result)) return;
    expect(result.type).toBe("person");
    expect(result.id.startsWith("psn_")).toBe(true);
    expect(result.name).toBe("아쿠타미");

    // 실제로 person 행이 생겼는지(facade 로 같은 사람 재조회 — 멱등 확인).
    const again = await store.findOrCreatePersonByName("아쿠타미");
    expect(again.personId).toBe(result.id);
  });

  test("사람 target(#주인:엄마) = 명시 관계라 사람 행 생성(결정 B 는 명시 관계 막지 않음)", async () => {
    const spec = lookupRelationTag("주인")!;
    const result = await resolveRelationTarget(store, spec, "엄마");
    expect(isSkippedTarget(result)).toBe(false);
    if (isSkippedTarget(result)) return;
    expect(result.type).toBe("person");
    expect(result.name).toBe("엄마");
    const again = await store.findOrCreatePersonByName("엄마");
    expect(again.personId).toBe(result.id);
  });

  test("그 외 target(#관련장소:서울) = createEntityRow 로 place 행 생성(이름 UNIQUE)", async () => {
    const spec = lookupRelationTag("관련장소")!;
    const result = await resolveRelationTarget(store, spec, "서울");
    expect(isSkippedTarget(result)).toBe(false);
    if (isSkippedTarget(result)) return;
    expect(result.type).toBe("place");
    expect(result.id.startsWith("plc_")).toBe(true);
    expect(result.name).toBe("서울");

    // 같은 이름으로 다시 해석하면 같은 행(이름 UNIQUE 재사용·멱등).
    const second = await resolveRelationTarget(store, spec, "서울");
    expect(isSkippedTarget(second)).toBe(false);
    if (isSkippedTarget(second)) return;
    expect(second.id).toBe(result.id);
  });

  test("빈 값은 정직하게 skip(reason 에 관계명 식별자 보존·거짓 엣지 0)", async () => {
    const spec = lookupRelationTag("창작자")!;
    const result = await resolveRelationTarget(store, spec, "   ");
    expect(isSkippedTarget(result)).toBe(true);
    if (!isSkippedTarget(result)) return;
    expect(result.reason).toContain("created_by");
    expect(result.reason).toContain("비어");
  });
});

describe("resolveRelationTarget — target 타입이 여럿인 사용자 관계 가르기", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;
  const multiTargetSpec: RelationSpec = {
    relation: "cites_entity",
    sourceTypes: ["material"],
    targetTypes: ["person", "work", "material"],
    defaultTargetType: "person",
  };

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
  });

  test("같은 글 명시 타입 힌트(#작품:데못죽)가 있으면 그 타입으로 가른다", async () => {
    const hints: SameDocTypeHint[] = [{ value: "데못죽", type: "work" }];
    const result = await resolveRelationTarget(store, multiTargetSpec, "데못죽", hints);
    expect(isSkippedTarget(result)).toBe(false);
    if (isSkippedTarget(result)) return;
    expect(result.type).toBe("work"); // 기본 person 이 아니라 힌트 따라 work.
    expect(result.name).toBe("데못죽");
  });

  test("힌트 없으면 spec.defaultTargetType(person)으로 떨어진다", async () => {
    const result = await resolveRelationTarget(store, multiTargetSpec, "어떤값");
    expect(isSkippedTarget(result)).toBe(false);
    if (isSkippedTarget(result)) return;
    expect(result.type).toBe(multiTargetSpec.defaultTargetType); // person
    expect(result.type).toBe("person");
  });

  test("힌트 value 가 trim·소문자 동등으로 매칭된다", async () => {
    const hints: SameDocTypeHint[] = [{ value: " 자료A ", type: "material" }];
    const result = await resolveRelationTarget(store, multiTargetSpec, "자료a", hints);
    expect(isSkippedTarget(result)).toBe(false);
    if (isSkippedTarget(result)) return;
    expect(result.type).toBe("material");
  });

  test("같은 값이 서로 다른 타입으로 힌트되면(모순) 기본 타입으로 떨어진다", async () => {
    const hints: SameDocTypeHint[] = [
      { value: "혼란", type: "work" },
      { value: "혼란", type: "material" },
    ];
    // 힌트가 모순이라 hintTypeForValue 가 null → 기본 타입(person)으로 정직하게 떨어짐.
    const result = await resolveRelationTarget(store, multiTargetSpec, "혼란", hints);
    expect(isSkippedTarget(result)).toBe(false);
    if (isSkippedTarget(result)) return;
    expect(result.type).toBe("person");
  });

  test("허용 타입 밖 힌트는 무시하고 기본 타입으로 떨어진다", async () => {
    const hints: SameDocTypeHint[] = [{ value: "엉뚱", type: "place" }];
    const result = await resolveRelationTarget(store, multiTargetSpec, "엉뚱", hints);
    expect(isSkippedTarget(result)).toBe(false);
    if (isSkippedTarget(result)) return;
    expect(result.type).toBe("person"); // place 힌트 무시 → 기본 person.
  });
});
