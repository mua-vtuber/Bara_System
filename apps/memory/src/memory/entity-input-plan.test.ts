import { afterEach, describe, expect, test } from "bun:test";
import { planEntityInput } from "./entity-input-plan.ts";
import {
  resetConceptTypeVocabularyCache,
  setEntityTypeOverride,
} from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";

afterEach(() => {
  setEntityTypeOverride([]);
  resetConceptTypeVocabularyCache();
  resetClassifierCache();
});

describe("planEntityInput — 본문 없는 엔티티 전용 입력 분류", () => {
  test("사람 속성/별명만 있는 입력은 entity_patch", () => {
    const plan = planEntityInput(
      "#사람:홍길동, #직업:2D산골나무꾼, #별명:동글이, #생일:0000년 0월 0일",
    );

    expect(plan.mode).toBe("entity_patch");
  });

  test("작품 속성/별명만 있는 입력은 entity_patch", () => {
    const plan = planEntityInput("#작품:데못죽 #장르:판타지 #별명:데못죽");

    expect(plan.mode).toBe("entity_patch");
  });

  test("사용자 추가 타입도 entity_patch 대상", () => {
    setEntityTypeOverride([{ typeName: "household_ledger", koName: "가계부" }]);
    resetConceptTypeVocabularyCache();
    resetClassifierCache();

    const plan = planEntityInput("#가계부:배달 #배달:돈까스 #금액:17000");

    expect(plan.mode).toBe("entity_patch");
  });

  test("본문이 있으면 memory_text", () => {
    const plan = planEntityInput("#사람:홍길동, 오늘 작업했다");

    expect(plan.mode).toBe("memory_text");
  });

  test("콜론 없는 태그만 있는 입력은 기존처럼 memory_text", () => {
    const plan = planEntityInput("#만화 #애니");

    expect(plan.mode).toBe("memory_text");
  });

  test("본문 없는 일정+날짜 입력은 schedule_occurrence", () => {
    const plan = planEntityInput("#일정:치과 #날짜:내일");

    expect(plan.mode).toBe("schedule_occurrence");
  });

  test("본문 있는 일정+날짜 입력은 memory_text", () => {
    const plan = planEntityInput("#일정:치과 #날짜:7월 15일, 정기 검진");

    expect(plan.mode).toBe("memory_text");
  });

  test("날짜 없는 일정 단독 입력은 entity_patch", () => {
    const plan = planEntityInput("#일정:치과");

    expect(plan.mode).toBe("entity_patch");
  });

  test("일정 값이 여러 개면 schedule_occurrence 로 보지 않는다", () => {
    const plan = planEntityInput("#일정:치과 #약속:상담 #날짜:내일");

    expect(plan.mode).toBe("memory_text");
  });

  test("직접 장소 필드 단독 입력은 memory_text", () => {
    const plan = planEntityInput("#장소:강남 A마트");

    expect(plan.mode).toBe("memory_text");
  });

  test("장소 계층 사슬은 entity_patch", () => {
    const plan = planEntityInput("#장소:병원 #병원:피부과 #피부과:무지개의원");

    expect(plan.mode).toBe("entity_patch");
  });
});
