import { test, expect, beforeAll, describe } from "bun:test";
import {
  groupTypeDeclarations,
  excludeDirectInputDeclarations,
} from "./type-declaration-grouping.ts";
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";

beforeAll(() => { resetConceptTypeVocabularyCache(); resetClassifierCache(); });

test("사람+작품 혼합 — 타입별 1그룹씩(work 그룹에 선언 둘)", () => {
  const groups = groupTypeDeclarations("#사람:백덕수 #직업:소설작가 #작품:데못죽 #작품:괴담");
  const types = groups.map((g) => g.type).sort();
  expect(types).toEqual(["person", "work"]);
  const work = groups.find((g) => g.type === "work")!;
  expect(work.declValues).toEqual(["데못죽", "괴담"]);
});

test("단일 타입 — 길이 1(회귀 0)", () => {
  const groups = groupTypeDeclarations("#작품:주술회전 재밌었다");
  expect(groups.map((g) => g.type)).toEqual(["work"]);
});

test("타입 선언 0개 — 빈 배열(기타 글)", () => {
  expect(groupTypeDeclarations("#취미:독서 오늘 좋았다")).toEqual([]);
});

test("분류 진입 키도 타입 그룹으로(#소설:괴담 → work)", () => {
  const groups = groupTypeDeclarations("#소설:괴담에떨어져도");
  expect(groups.map((g) => g.type)).toEqual(["work"]);
});

describe("excludeDirectInputDeclarations — #장소 단독 잎 제외·사슬 진입점 보존(라이브 유령 차단)", () => {
  test("단독 잎 #장소:강남 → place 그룹 통째 제외(유령 차단)", () => {
    const content = "#일정 장 봤다 #장소:강남 A마트,"; // 콜론은 '강남' 으로 잘림(단독 잎).
    const groups = groupTypeDeclarations(content);
    // groupTypeDeclarations 는 콜론 '강남' 을 place 그룹으로 만든다(결함 출발점).
    expect(groups.some((g) => g.type === "place")).toBe(true);
    const filtered = excludeDirectInputDeclarations(groups, content);
    // 직접 입력 갈래 단독 잎이라 place 그룹이 빠진다.
    expect(filtered.some((g) => g.type === "place")).toBe(false);
  });

  test("사슬 진입점 #장소:병원 #병원:피부과 → place 그룹 보존(콜론 다단계 위계)", () => {
    const content = "#장소:병원 #병원:피부과 #피부과:무지개의원";
    const groups = groupTypeDeclarations(content);
    const filtered = excludeDirectInputDeclarations(groups, content);
    // '병원' 이 #병원: 키로 이어지는 사슬 진입점이라 place 그룹이 보존된다.
    const place = filtered.find((g) => g.type === "place");
    expect(place).toBeDefined();
    expect(place!.declValues).toContain("병원");
  });

  test("공백 없는 단독 #장소:속초 → 제외(직접 입력 전담·수렴)", () => {
    const content = "여행 #장소:속초";
    const filtered = excludeDirectInputDeclarations(
      groupTypeDeclarations(content),
      content,
    );
    expect(filtered.some((g) => g.type === "place")).toBe(false);
  });

  test("다른 타입(#작품·#생물)은 무영향(직접 입력 갈래 키 아님)", () => {
    const content = "#작품:소설 #소설:데못죽 #생물:고양이";
    const groups = groupTypeDeclarations(content);
    const filtered = excludeDirectInputDeclarations(groups, content);
    const types = filtered.map((g) => g.type).sort();
    expect(types).toEqual(["creature", "work"]);
  });

  test("#장소 + 다른 타입 공존 — place 단독 잎만 빠지고 나머지 보존", () => {
    const content = "#작품:주술회전 #장소:강남 A마트,";
    const filtered = excludeDirectInputDeclarations(
      groupTypeDeclarations(content),
      content,
    );
    const types = filtered.map((g) => g.type);
    expect(types).toContain("work"); // 작품 보존.
    expect(types).not.toContain("place"); // 장소 단독 잎 제외.
  });
});
