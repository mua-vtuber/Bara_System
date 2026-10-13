// decorationKindFor 순수 resolver 단위 테스트 — WebGL 비의존.
// 캔버스 텍스처 그리기 자체는 테스트하지 않는다(브라우저 WebGL 없음). 타입→장식
// 매핑만 순수 함수로 검증한다.
import { describe, test, expect } from "bun:test";
import { decorationKindFor, decorationKindForGroup } from "./decorations.ts";
import type { GraphNodeType } from "../graph-view-model.ts";

describe("decorationKindFor — 역할별 장식 매핑 (Phase8 재매핑 Task 6)", () => {
  test("엔티티 9종(프로젝트 포함) → ring", () => {
    const entityTypes: GraphNodeType[] = [
      "work", "creature", "thing", "intake", "usable",
      "material", "place", "schedule", "project",
    ];
    for (const t of entityTypes) expect(decorationKindFor(t)).toBe("ring");
  });

  test("person → ray", () => {
    expect(decorationKindFor("person")).toBe("ray");
  });

  test("classification_key → shard", () => {
    expect(decorationKindFor("classification_key")).toBe("shard");
  });

  test("분류 값·평범 태그·글·문서·이미지·concept → null (일반 별)", () => {
    const none: GraphNodeType[] = [
      "concept", "decision", "tag", "memory", "document",
      "document_chunk", "image", "image_caption", "llm_extract", "unknown",
    ];
    for (const t of none) expect(decorationKindFor(t)).toBeNull();
  });
});

describe("decorationKindForGroup — 묶음 노드 장식 분기", () => {
  test("work 묶음은 자식 작품과 같은 ring", () => {
    expect(decorationKindForGroup("work")).toBe("ring");
  });
  test("person 묶음은 자식 사람과 같은 ray", () => {
    expect(decorationKindForGroup("person")).toBe("ray");
  });
  test("project 묶음은 ring", () => {
    expect(decorationKindForGroup("project")).toBe("ring");
  });
  test("material 묶음은 ring", () => {
    expect(decorationKindForGroup("material")).toBe("ring");
  });
  test("DECORATION_BY_TYPE 에 없는 묶음(user 새 종류)은 ring default(G5 문제2)", () => {
    // 묶음 노드 groupType 은 항상 1급 종류다. 표에 없는 user 새 종류('ledger' 등)는 8 종과
    // 같은 ring 을 받아 맨 별(장식 0) 비대칭을 없앤다. 닫힌 union 밖 string 도 ring default.
    expect(decorationKindForGroup("ledger")).toBe("ring");
    expect(decorationKindForGroup("nonsense")).toBe("ring");
  });
});
