/**
 * 양식 정밀화 통합 회귀 테스트 — 잘린 추출 조각 근본 수정
 * (spec 2026-06-09-regex-l0-pattern-precision-spec §8 완료 기준 / plan T6).
 *
 * 데이터 fixture 방식만 쓴다(순수 함수 입력 → 출력 검증, mock 객체 0 — CLAUDE.md
 * 테스트 정책 정합). 실제 한국어 builtin 양식(BUILTIN_PATTERNS)·실제 booster 로만
 * 검증한다.
 *
 * 두 갈래를 고정한다:
 *   1) extract 레벨(캡처 경계·서술어 게이트·승격 게이트) — RegexL0Extractor 직접.
 *   2) cleanContent 정제(해시태그 제거) — parseTags 로 입력을 정제한 뒤 extract 에
 *      넘기는 save-input.ts:extractRegexCandidates 의 규칙을 그대로 재현.
 *
 * 재현 입력 두 개 + 정상 단문 보존 표(과교정 0)를 양식 단위로 고정한다.
 */

import { describe, expect, test } from "bun:test";
import { RegexL0Extractor } from "./extractor.ts";
import { parseTags } from "../tag-extractor.ts";

/** 실제 한국어 builtin 양식·booster 만 쓰는 추출기(사용자 양식 0, Mock 0). */
function builtinExtractor(): RegexL0Extractor {
  return new RegexL0Extractor({
    patternPaths: [],
    boosterPaths: [],
    userRepo: undefined,
    langs: ["ko"],
  });
}

/** save-input.ts:extractRegexCandidates 의 cleanContent 정제 규칙 재현. */
function extractFromInput(ex: RegexL0Extractor, raw: string) {
  const cleanContent = parseTags(raw).cleanContent;
  if (cleanContent.length === 0) return { candidates: [], boostersHit: [] };
  return ex.extract(cleanContent);
}

/** 어절 경계 직후에 올 수 있는 한국어 조사(추출 조각 뒤 직결 시 정상 분리). */
const JOSA = [
  "은", "는", "이", "가", "을", "를", "으로", "로", "에", "의", "와", "과",
  "도", "만", "까지", "부터", "에서", "에게", "한테", "보다", "처럼", "같이",
  "마다", "조차", "마저", "밖에", "뿐", "나", "이나", "든", "이든",
];

/**
 * 추출 조각이 원문 어절을 글자 단위로 가른(어절 중간 절단) 것인지 판정한다.
 *
 * qa 가 짚은 결함 — `Bun 런타임으로 결정했어` 에서 `Bun 런타임으로 결` 처럼 합성어
 * `결정했어` 를 `결` 에서 끊는 절단 — 을 잡는다. 조각 끝 바로 뒤가 (문장 끝 / 공백 /
 * 구두점) 이거나 (조사로 시작해 그 조사가 어절 경계로 끝나면) 정상 분리이고, 그 외에
 * 한글/영문 글자가 직결되면 어절을 가른 절단으로 본다.
 */
function isMidWordCut(input: string, captured: string): boolean {
  const c = captured.trim();
  if (c.length === 0) return false;
  const idx = input.indexOf(c);
  if (idx < 0) return true; // 추출이 원문에 없으면 이상 신호
  const rest = input.slice(idx + c.length);
  if (rest.length === 0) return false; // 원문 끝까지 = 어절 경계
  if (/^[\s,.()]/.test(rest)) return false; // 공백·구두점 = 어절 경계
  for (const j of JOSA) {
    if (rest.startsWith(j)) {
      const afterJosa = rest.slice(j.length);
      // 조사 다음이 어절 경계여야 진짜 조사 분리(우연 글자 겹침 배제).
      if (afterJosa.length === 0 || /^[\s,.()]/.test(afterJosa)) return false;
    }
  }
  return true; // 조각 끝 뒤에 글자가 직결 — 어절 중간 절단
}

describe("양식 정밀화 회귀 — 재현 입력1 (긴 한국어 설정 묘사)", () => {
  // spec §8 완료 기준 1 — 잘린 조각 `라이크 매주 …호감도를` 이 안 생긴다.
  const INPUT1 =
    "#프로젝트:좀비로그라이크 매주 월요일로 되돌아가는 회귀 구조이고, " +
    "주인공만 기억과 호감도를 유지한다 (좀비가 생전 동선을 반복하는 것)";

  test("cleanContent 경유 추출 후보가 0개 (설정 묘사 false positive 차단)", () => {
    const ex = builtinExtractor();
    const r = extractFromInput(ex, INPUT1);
    // `유지한다`(현재 시제 서술 = 설정 묘사)는 결정 맥락 어미가 없어 decision_ko_008
    // 에 매치하지 않는다(spec §4.3 b). 다른 양식도 안 맞아 후보 0.
    expect(r.candidates).toHaveLength(0);
  });

  test("어떤 후보에도 쉼표 넘는 절단 조각(`구조이고, 주인공만`)이 없다", () => {
    const ex = builtinExtractor();
    const r = extractFromInput(ex, INPUT1);
    for (const c of r.candidates) {
      expect(c.extractedContent.includes(",")).toBe(false);
      expect(c.extractedContent.includes("구조이고")).toBe(false);
    }
  });

  test("매치돼도 auto_store 후보는 없다 (긴 설정 묘사 자동 저장 차단)", () => {
    const ex = builtinExtractor();
    const r = extractFromInput(ex, INPUT1);
    const autoStored = r.candidates.filter((c) => c.decision === "auto_store");
    expect(autoStored).toHaveLength(0);
  });
});

describe("양식 정밀화 회귀 — 재현 입력2 (해시태그 정제)", () => {
  // spec §8 완료 기준 2 — `#나` 가 섞인 조각이 안 생긴다.
  const INPUT2 = "#나 한국어 응답을 선호한다";

  test("추출 내용에 `#나`·`#` 부스러기가 없다 (cleanContent 정제)", () => {
    const ex = builtinExtractor();
    const r = extractFromInput(ex, INPUT2);
    for (const c of r.candidates) {
      expect(c.extractedContent.includes("#")).toBe(false);
      expect(c.extractedContent.includes("나 한국어")).toBe(false);
    }
  });

  test("선호 양식이 `한국어 응답을` 을 잡되 pending_review (선호 base<3 = auto_store 금지)", () => {
    const ex = builtinExtractor();
    const r = extractFromInput(ex, INPUT2);
    const pref = r.candidates.find((c) => c.category === "preference");
    expect(pref).toBeDefined();
    expect(pref!.extractedContent).toBe("한국어 응답을");
    // 선호 base 2 + booster `선호`(+2) = finalScore 4 → pending_review.
    // 설령 booster 가 더 붙어 finalScore≥5 가 돼도 base<3 이라 auto_store 안 됨(spec §5.4).
    expect(pref!.decision).not.toBe("auto_store");
  });
});

describe("양식 정밀화 회귀 — 정상 단문 보존 (과교정 0)", () => {
  // spec §8 완료 기준 3 — 정상 단문이 여전히 의도한 조각을 낸다.
  // 표: [입력, 기대 추출 조각, 그 조각이 ignore 가 아닌 저장 후보여야 하는지]
  const CASES: ReadonlyArray<[string, string, boolean]> = [
    ["Bun 런타임으로 결정했어", "Bun 런타임으로", true],
    ["수채화 톤이 좋아", "수채화 톤", true],
    ["Mock 객체 사용 금지", "Mock 객체 사용", true],
    ["bge-m3 모델을 선택했어", "bge-m3 모델", true],
    ["타입 검증 필수", "타입 검증", true],
    ["Phase 5.7.2 정착 확정", "Phase 5.7.2 정착", true],
  ];

  for (const [input, expectedFragment, mustStore] of CASES) {
    test(`"${input}" → "${expectedFragment}" 조각 보존`, () => {
      const ex = builtinExtractor();
      const r = ex.extract(input);
      const hit = r.candidates.find(
        (c) => c.extractedContent === expectedFragment,
      );
      expect(
        hit,
        `"${input}" 에서 "${expectedFragment}" 조각이 사라짐(과교정)`,
      ).toBeDefined();
      if (mustStore) {
        // 저장 후보(auto_store 또는 pending_review) — ignore 로 떨어지면 안 됨.
        expect(hit!.decision).not.toBe("ignore");
      }
    });
  }

  test("정상 단문 추출 조각에 쉼표·해시태그 부스러기가 없다", () => {
    const ex = builtinExtractor();
    for (const [input] of CASES) {
      const r = ex.extract(input);
      for (const c of r.candidates) {
        expect(c.extractedContent.includes(",")).toBe(false);
        expect(c.extractedContent.includes("#")).toBe(false);
      }
    }
  });

  // qa 발견 결함 회귀 가드 — 정상 단문 fixture 전부에 대해 "어절 중간이 잘린 조각이
  // 후보에 없다"를 본다. 기존 테스트는 "기대 조각이 존재하는지"만 봐서, 정상 조각
  // 옆에 추가로 생긴 잘린 조각(예: `Bun 런타임으로 결`)을 못 잡았다(qa 지적).
  test("정상 단문 후보에 어절 중간 절단 조각이 하나도 없다 (전수)", () => {
    const ex = builtinExtractor();
    const cuts: string[] = [];
    for (const [input] of CASES) {
      const r = ex.extract(input);
      for (const c of r.candidates) {
        if (isMidWordCut(input, c.extractedContent)) {
          cuts.push(`"${input}" → 절단 조각 "${c.extractedContent}"`);
        }
      }
    }
    expect(cuts).toEqual([]);
  });
});

describe("양식 정밀화 회귀 — 짧은 키워드 합성어 가르기 차단 (qa 발견)", () => {
  // decision_ko_004(`정했`)·decision_ko_002(`결정`) 가 합성어 `결정했`·`확정했`·`미결정`
  // 내부를 글자 단위로 가르던 결함. 키워드 앞 공백 필수(\s+)로 차단했다.
  const CUT_PROBES: ReadonlyArray<[string, string]> = [
    ["Bun 런타임으로 결정했어", "Bun 런타임으로 결"],
    ["방향을 확정했어", "방향을 확"],
    ["정족수 미결정했어", "정족수 미"],
  ];

  for (const [input, forbiddenFragment] of CUT_PROBES) {
    test(`"${input}" → 잘린 조각 "${forbiddenFragment}" 가 후보에 없다`, () => {
      const ex = builtinExtractor();
      const r = ex.extract(input);
      const found = r.candidates.find(
        (c) => c.extractedContent === forbiddenFragment,
      );
      expect(
        found,
        `"${input}" 에서 잘린 조각 "${forbiddenFragment}" 가 다시 생김`,
      ).toBeUndefined();
      // 후보가 있다면(정상 조각) 어절 중간 절단이 아니어야 한다.
      for (const c of r.candidates) {
        expect(
          isMidWordCut(input, c.extractedContent),
          `"${input}" 후보 "${c.extractedContent}" 가 어절 중간 절단`,
        ).toBe(false);
      }
    });
  }

  test("정상 입력 `주 1회 정리로 정했어` 는 의도 조각 `주 1회 정리로` 를 계속 낸다 (과교정 0)", () => {
    const ex = builtinExtractor();
    const r = ex.extract("주 1회 정리로 정했어");
    const hit = r.candidates.find(
      (c) => c.extractedContent === "주 1회 정리로",
    );
    expect(hit).toBeDefined();
    expect(hit!.decision).not.toBe("ignore");
  });
});
