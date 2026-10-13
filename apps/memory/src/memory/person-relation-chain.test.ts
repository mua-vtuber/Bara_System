/**
 * person-relation-chain.test.ts — 관계 콜론 사슬 독립 추적기(Task 1) 검증.
 *
 * 순수 함수에 데이터 fixture(parseClassificationTags 산출)를 넣어 산출을 확인한다.
 * mock 인터페이스 구현체는 만들지 않는다(프로젝트 정책) — DB·LLM 의존 0 이라 필요 없다.
 */

import { describe, expect, test } from "bun:test";
import { parseClassificationTags } from "./parsers/classification-tag.ts";
import {
  extractRelationChains,
  extractPersonDeclarations,
  decidePersonAttachment,
  type RelationChain,
  type PersonAttachmentDecision,
} from "./person-relation-chain.ts";

/** 글 본문을 parseClassificationTags 로 거쳐 추적기에 넣는 작은 도우미. */
function chainsOf(text: string): RelationChain[] {
  return extractRelationChains(parseClassificationTags(text));
}

/** 글 본문을 parseClassificationTags 로 거쳐 사람 선언 이름 목록으로 만드는 도우미. */
function personsOf(text: string): string[] {
  return extractPersonDeclarations(parseClassificationTags(text));
}

/** 글 본문 한 줄을 사람 선언 + 관계 사슬로 갈라 매달기 결정까지 거치는 도우미. */
function decideOf(text: string): PersonAttachmentDecision {
  const tags = parseClassificationTags(text);
  return decidePersonAttachment(extractPersonDeclarations(tags), extractRelationChains(tags));
}

describe("extractRelationChains — 관계 콜론 사슬 독립 추적", () => {
  test("#관계:가족 #가족:엄마 → 사슬 1개(가족 단을 거쳐 엄마 잎)", () => {
    expect(chainsOf("#관계:가족 #가족:엄마")).toEqual([
      { roof: "관계", category: "가족", leaf: "엄마" },
    ]);
  });

  test("#관계:엄마 → 중간 분류 단 없이 바로 잎(E3·category null)", () => {
    expect(chainsOf("#관계:엄마")).toEqual([
      { roof: "관계", category: null, leaf: "엄마" },
    ]);
  });

  test("#관계:막내동생 → 어휘 밖 호칭도 잎으로 잡는다(E3)", () => {
    expect(chainsOf("#관계:막내동생")).toEqual([
      { roof: "관계", category: null, leaf: "막내동생" },
    ]);
  });

  test("#관계:가족 #가족:엄마 #관계:친구 #친구:대웅 → 독립 사슬 2개", () => {
    const chains = chainsOf("#관계:가족 #가족:엄마 #관계:친구 #친구:대웅");
    expect(chains.length).toBe(2);
    expect(chains).toEqual([
      { roof: "관계", category: "가족", leaf: "엄마" },
      { roof: "관계", category: "친구", leaf: "대웅" },
    ]);
  });

  test("#사람:인영희 만 있으면 — 관계 사슬 아님(사람 선언)·빈 배열(정직)", () => {
    expect(chainsOf("#사람:인영희")).toEqual([]);
  });

  test("관계 태그가 전혀 없는 글 — 빈 배열", () => {
    expect(chainsOf("오늘 산책을 했다")).toEqual([]);
  });

  test("관계/친족 분류 키(가족)에서 바로 시작하는 사슬도 잡는다(#가족:엄마)", () => {
    expect(chainsOf("#가족:엄마")).toEqual([
      { roof: "가족", category: null, leaf: "엄마" },
    ]);
  });

  test("사람 선언과 관계 사슬이 섞이면 — 선언은 빼고 관계 사슬만 남긴다", () => {
    // `#사람:인영희` 는 사람 선언이라 빠지고, `#관계:가족 #가족:엄마` 만 사슬로 남는다.
    expect(chainsOf("#사람:인영희 #관계:가족 #가족:엄마")).toEqual([
      { roof: "관계", category: "가족", leaf: "엄마" },
    ]);
  });
});

describe("extractPersonDeclarations — `#사람:X` 선언에서 사람 이름만 뽑기", () => {
  test("#사람:인영희 → 사람 이름 한 명", () => {
    expect(personsOf("#사람:인영희")).toEqual(["인영희"]);
  });

  test("관계 사슬은 사람 선언이 아니다(#관계·#가족 은 이름이 아님)", () => {
    expect(personsOf("#관계:가족 #가족:엄마")).toEqual([]);
  });

  test("사람 선언과 관계 사슬이 섞여도 — 사람 이름만 남긴다", () => {
    expect(personsOf("#사람:인영희 #관계:가족 #가족:엄마")).toEqual(["인영희"]);
  });

  test("사람 선언 둘 이상이면 — 적힌 순서대로 둘 다 뽑는다", () => {
    expect(personsOf("#사람:인영희 #사람:박대웅")).toEqual(["인영희", "박대웅"]);
  });

  test("관계 지붕 동의어(#인물)는 사람 선언이 아니다(값이 사람 이름이 아님)", () => {
    // koNameOf("person")("사람") 만 선언 지붕이라 #인물 은 사람 선언으로 잡지 않는다.
    expect(personsOf("#인물:가족")).toEqual([]);
  });
});

describe("decidePersonAttachment — 사람-역할 1대1 매달기 결정(E4·거짓 연결 0)", () => {
  test("사람 1명 + 역할 잎 1개 → 매달기(인영희를 엄마 잎 아래)", () => {
    expect(decideOf("#사람:인영희 #관계:가족 #가족:엄마")).toEqual({
      attach: { person: "인영희", leaf: "엄마" },
      warnings: [],
    });
  });

  test("사람 둘 이상 → 매달지 않고 모호 경고(거짓 연결 0)", () => {
    const decision = decideOf("#사람:인영희 #사람:박대웅 #관계:가족 #가족:엄마");
    expect(decision.attach).toBeNull();
    expect(decision.warnings.length).toBe(1);
    expect(decision.warnings[0]).toContain("사람이 둘 이상");
  });

  test("역할 잎 둘 이상 → 매달지 않고 모호 경고(거짓 연결 0)", () => {
    const decision = decideOf("#사람:인영희 #관계:가족 #가족:엄마 #관계:친구 #친구:대웅");
    expect(decision.attach).toBeNull();
    expect(decision.warnings.length).toBe(1);
    expect(decision.warnings[0]).toContain("역할이 둘 이상");
  });

  test("사람 0명(관계 사슬만) → 매달 사람이 없으니 매달기 없음·경고 없음(정직)", () => {
    expect(decideOf("#관계:가족 #가족:엄마")).toEqual({
      attach: null,
      warnings: [],
    });
  });

  test("역할 잎 0개(사람 선언만) → 매달 잎이 없으니 매달기 없음·경고 없음(정직)", () => {
    expect(decideOf("#사람:인영희")).toEqual({
      attach: null,
      warnings: [],
    });
  });

  test("같은 잎이 사슬 2개로 나와도(#가족:엄마 가 #관계:가족 앞) — 잎 1개로 세어 매달린다", () => {
    // 비정상 입력: `#가족:엄마` 가 `#관계:가족` 앞에 오면 관계→가족→엄마 와 가족→엄마 두 사슬이
    // 같은 잎 "엄마"로 나올 수 있다. 사슬 개수로 세면 역할 2개로 오인해 거짓 거부한다.
    // 서로 다른 잎(distinct leaf) 으로 세야 실제 역할 1개라 정상 매달린다.
    const tags = parseClassificationTags("#가족:엄마 #관계:가족 #사람:인영희");
    const chains = extractRelationChains(tags);
    // 사슬은 잎이 같은 항목이 둘 이상 나올 수 있다(또는 1개) — distinct leaf 가 핵심.
    const distinctLeaves = new Set(chains.map((c) => c.leaf));
    expect(distinctLeaves.has("엄마")).toBe(true);
    const decision = decidePersonAttachment(extractPersonDeclarations(tags), chains);
    expect(decision).toEqual({
      attach: { person: "인영희", leaf: "엄마" },
      warnings: [],
    });
  });
});
