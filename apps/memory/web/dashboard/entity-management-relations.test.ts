/**
 * entity-management-relations.test.ts — 관계 설정 부품 검증 (엔티티 관리 통합 S7b).
 *
 * 라이브 정정(2026-06-27): 관계는 종류 표 아래 별 섹션이 아니라 *종류 수정 모달 안*에
 * 들어간다. 그래서 renderRelationSection(출발 select 포함) 대신 renderTypeRelations(출발
 * 고정·도착 한 종류) 를 검증한다. 도착은 사용자 단순화로 한 종류만 고른다(여럿 선택 +
 * 기본 도착 두 칸 폐기).
 *
 * 검증 정신 — fetch mock 0·Mock 객체 0:
 *   renderRelationList·buildRelationAddPayload 는 순수(데이터·콜백 fixture)다.
 *   renderTypeRelations 는 add/remove/reload/latestRelations 콜백을 *plain 객체*(함수 몇 개
 *   담은 데이터)로 주입받아 호출을 배열에 기록해 단언한다(인터페이스 가짜 구현 클래스 0).
 *
 * 검증 갈래:
 *   - 관계 목록 순수 렌더 — code 행 삭제버튼 없음 / user 행 있음 / 0건 안내 / 출발→도착 표시.
 *   - 추가 payload 빌더 — 도착 한 종류를 targetTypes[하나]·defaultTargetType 둘 다로 채움·
 *     빈 키/이름이면 null·출발은 단일 배열로 감쌈.
 *   - renderTypeRelations — 출발·기본도착 select 부재(도착 single)·추가 콜백·삭제 콜백.
 */

import "../../test-setup-dom";
import { describe, test, expect } from "bun:test";
import {
  renderRelationList,
  renderTypeRelations,
  buildRelationAddPayload,
} from "./entity-management-relations";
import type {
  RelationVocabRow,
  AddRelationVocabPayload,
} from "./relation-vocab-panel-api";
import type { EntityTypeRow } from "./entity-types-panel-api";

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

/** 호출 기록을 담는 plain 콜백 한 벌(가짜 구현 클래스 아님·데이터 + 함수). */
function makeRecordingRelationDeps(opts: {
  sourceType: string;
  entityTypes: EntityTypeRow[];
  relations: RelationVocabRow[];
  /** reload 후 latestRelations 가 돌려줄 목록(미지정 시 relations 그대로). */
  latest?: RelationVocabRow[];
}): {
  deps: Parameters<typeof renderTypeRelations>[0];
  addCalls: AddRelationVocabPayload[];
  removeCalls: string[];
  reloadCount: { n: number };
} {
  const addCalls: AddRelationVocabPayload[] = [];
  const removeCalls: string[] = [];
  const reloadCount = { n: 0 };
  return {
    addCalls,
    removeCalls,
    reloadCount,
    deps: {
      sourceType: opts.sourceType,
      entityTypes: () => opts.entityTypes,
      relations: opts.relations,
      async addRelation(payload) {
        addCalls.push(payload);
      },
      async removeRelation(relationKey) {
        removeCalls.push(relationKey);
      },
      onReload() {
        reloadCount.n += 1;
      },
      latestRelations: () => opts.latest ?? opts.relations,
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe("buildRelationAddPayload — 관계 추가 payload 순수 함수", () => {
  test("출발·도착 한 종류를 라우트 배열 계약으로 감싼다(targetTypes[하나]·defaultTargetType 같은 값)", () => {
    const payload = buildRelationAddPayload({
      relationKey: "감독",
      relationName: "directed_by",
      sourceType: "work",
      targetType: "person",
    });
    // 도착 한 종류 'person' 이 targetTypes 배열 한 칸·defaultTargetType 둘 다로 들어간다.
    expect(payload).toEqual({
      relationKey: "감독",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
  });

  test("관계키·관계명은 trim 한다", () => {
    const payload = buildRelationAddPayload({
      relationKey: "  감독  ",
      relationName: "  directed_by  ",
      sourceType: "work",
      targetType: "person",
    });
    expect(payload?.relationKey).toBe("감독");
    expect(payload?.relationName).toBe("directed_by");
  });

  test("빈 관계키면 null(폼이 안내하고 호출 0)", () => {
    expect(
      buildRelationAddPayload({
        relationKey: "   ",
        relationName: "directed_by",
        sourceType: "work",
        targetType: "person",
      }),
    ).toBeNull();
  });

  test("빈 관계명이면 null", () => {
    expect(
      buildRelationAddPayload({
        relationKey: "감독",
        relationName: "",
        sourceType: "work",
        targetType: "person",
      }),
    ).toBeNull();
  });
});

describe("renderRelationList — 관계 목록 순수 렌더", () => {
  test("출발 → 도착 종류가 표시된다", () => {
    const list = renderRelationList(
      [relRow({ relationKey: "주인", relationName: "owned_by", sourceTypes: ["work"], targetTypes: ["person"] })],
      () => {},
    );
    const text = list.textContent ?? "";
    expect(text).toContain("주인");
    expect(text).toContain("owned_by");
    expect(text).toContain("work");
    expect(text).toContain("person");
  });

  test("code 행은 삭제 버튼 없음, user 행은 삭제 버튼 있음", () => {
    const list = renderRelationList(
      [
        relRow({ relationKey: "창작자", source: "code" }),
        relRow({ relationKey: "감독", source: "user" }),
      ],
      () => {},
    );
    const codeRow = list.querySelector('[data-relation-key="창작자"]')!;
    const userRow = list.querySelector('[data-relation-key="감독"]')!;
    expect(codeRow.querySelector("[data-relation-delete]")).toBeNull();
    expect(userRow.querySelector("[data-relation-delete]")).not.toBeNull();
  });

  test("user 행 삭제 버튼 클릭 → onDelete(relationKey) 호출", () => {
    const deleted: string[] = [];
    const list = renderRelationList(
      [relRow({ relationKey: "감독", source: "user" })],
      (key) => deleted.push(key),
    );
    (list.querySelector("[data-relation-delete]") as HTMLButtonElement).click();
    expect(deleted).toEqual(["감독"]);
  });

  test("그 종류 출발 관계 0건이면 안내만", () => {
    const list = renderRelationList([], () => {});
    expect(list.querySelector("[data-relation-empty]")).not.toBeNull();
    expect(list.querySelectorAll("[data-relation-row]").length).toBe(0);
  });
});

describe("renderTypeRelations — 모달 안 관계 칸(출발 고정)", () => {
  test("출발·기본도착 select 가 없다(출발 현재 종류 고정·도착 한 칸) — 도착 select 만 있다", () => {
    const { deps } = makeRecordingRelationDeps({
      sourceType: "work",
      entityTypes: [typeRow({ typeName: "work", koName: "작품" }), typeRow({ typeName: "person", koName: "사람" })],
      relations: [],
    });
    const section = renderTypeRelations(deps);
    // 출발 select 가 없다(현재 종류 고정).
    expect(section.querySelector("[data-relation-source]")).toBeNull();
    // 기본 도착 select 도 없다(도착 한 칸이라 폐기·사용자 단순화).
    expect(section.querySelector("[data-relation-default-target]")).toBeNull();
    // 도착 select 만 있다.
    expect(section.querySelector("[data-relation-target]")).not.toBeNull();
  });

  test("도착 select 는 single(여럿 선택 아님)·옵션이 entityTypes() 단일 출처로 채워진다", () => {
    const { deps } = makeRecordingRelationDeps({
      sourceType: "work",
      entityTypes: [typeRow({ typeName: "work", koName: "작품" }), typeRow({ typeName: "person", koName: "사람" })],
      relations: [],
    });
    const section = renderTypeRelations(deps);
    const targetSelect = section.querySelector("[data-relation-target]") as HTMLSelectElement;
    // 도착은 한 종류만 고른다(single·multiple 아님).
    expect(targetSelect.multiple).toBe(false);
    expect(Array.from(targetSelect.options).map((o) => o.value)).toEqual(["work", "person"]);
  });

  test("초기 목록은 deps.relations(그 종류 출발 관계)를 그대로 그린다", () => {
    const { deps } = makeRecordingRelationDeps({
      sourceType: "work",
      entityTypes: [typeRow()],
      relations: [relRow({ relationKey: "주인", source: "code" }), relRow({ relationKey: "감독", source: "user" })],
    });
    const section = renderTypeRelations(deps);
    expect(section.querySelectorAll("[data-relation-row]").length).toBe(2);
    expect(section.querySelector('[data-relation-key="주인"]')).not.toBeNull();
    expect(section.querySelector('[data-relation-key="감독"]')).not.toBeNull();
  });

  test("폼 제출 → addRelation 이 출발 고정·도착 한 종류 payload 로 불린다", async () => {
    const { deps, addCalls, reloadCount } = makeRecordingRelationDeps({
      sourceType: "work",
      entityTypes: [typeRow({ typeName: "work", koName: "작품" }), typeRow({ typeName: "person", koName: "사람" })],
      relations: [],
    });
    const section = renderTypeRelations(deps);
    (section.querySelector("[data-relation-key-input]") as HTMLInputElement).value = "감독";
    (section.querySelector("[data-relation-name-input]") as HTMLInputElement).value = "directed_by";
    const targetSelect = section.querySelector("[data-relation-target]") as HTMLSelectElement;
    // 도착 한 종류만 고른다 — 'person' 선택.
    targetSelect.value = "person";
    const form = section.querySelector(".entity-mgmt-relation-add-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    // 출발은 deps.sourceType('work') 고정, 도착 한 종류 'person' 이 targetTypes 한 칸·
    // defaultTargetType 둘 다로 들어간다(라우트 계약 유지·UI 단일 입력).
    expect(addCalls).toEqual([
      {
        relationKey: "감독",
        relationName: "directed_by",
        sourceTypes: ["work"],
        targetTypes: ["person"],
        defaultTargetType: "person",
      },
    ]);
    // 추가 성공 후 reload 가 일어난다.
    expect(reloadCount.n).toBe(1);
  });

  test("user 관계 삭제 버튼 → removeRelation(relationKey) 호출 + reload", async () => {
    const { deps, removeCalls, reloadCount } = makeRecordingRelationDeps({
      sourceType: "work",
      entityTypes: [typeRow()],
      relations: [relRow({ relationKey: "감독", source: "user" })],
    });
    const section = renderTypeRelations(deps);
    (section.querySelector("[data-relation-delete]") as HTMLButtonElement).click();
    await flush();
    expect(removeCalls).toEqual(["감독"]);
    expect(reloadCount.n).toBe(1);
  });

  test("추가 후 latestRelations 로 목록이 갱신된다(reload 반영)", async () => {
    // 처음 0건, 추가 후 latestRelations 가 새 관계 1건을 돌려준다(서버 반영 흉내).
    const { deps } = makeRecordingRelationDeps({
      sourceType: "work",
      entityTypes: [typeRow({ typeName: "work", koName: "작품" }), typeRow({ typeName: "person", koName: "사람" })],
      relations: [],
      latest: [relRow({ relationKey: "감독", relationName: "directed_by", source: "user" })],
    });
    const section = renderTypeRelations(deps);
    // 초기 — 0건 안내.
    expect(section.querySelector("[data-relation-empty]")).not.toBeNull();
    (section.querySelector("[data-relation-key-input]") as HTMLInputElement).value = "감독";
    (section.querySelector("[data-relation-name-input]") as HTMLInputElement).value = "directed_by";
    const targetSelect = section.querySelector("[data-relation-target]") as HTMLSelectElement;
    // 도착 한 종류 선택(single).
    targetSelect.value = "person";
    const form = section.querySelector(".entity-mgmt-relation-add-form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    // reload 후 latestRelations 가 준 새 관계 '감독'이 목록에 보인다.
    expect(section.querySelector('[data-relation-key="감독"]')).not.toBeNull();
    expect(section.querySelector("[data-relation-empty]")).toBeNull();
  });
});
