/**
 * web/dashboard/ui/badges.test.ts
 * 의미 배지 조각 단위 테스트 — happy-dom 실제 DOM 구현 사용.
 */
import { registerHappyDom } from "../test-happy-dom.ts";
registerHappyDom();

import { test, expect, describe } from "bun:test";
import {
  sourceBadge,
  displayGraphKindLabel,
  isSameDisplayGraphKind,
  stateBadge,
  markerBadge,
  scoreChip,
  tagChip,
} from "./badges.ts";

// ──────────────────────────────────────────────
// sourceBadge
// ──────────────────────────────────────────────
describe("sourceBadge", () => {
  test("vector → 텍스트 의미, class badge--source-vector 포함", () => {
    const el = sourceBadge("vector");
    expect(el.textContent).toBe("의미");
    expect(el.classList.contains("badge")).toBe(true);
    expect(el.classList.contains("badge--source-vector")).toBe(true);
  });

  test("fts → 텍스트 글자, class badge--source-fts 포함", () => {
    const el = sourceBadge("fts");
    expect(el.textContent).toBe("글자");
    expect(el.classList.contains("badge--source-fts")).toBe(true);
  });

  test("graph → 텍스트 그래프, class badge--source-graph 포함", () => {
    const el = sourceBadge("graph");
    expect(el.textContent).toBe("그래프");
    expect(el.classList.contains("badge--source-graph")).toBe(true);
  });

  test("concept → 텍스트 개념, class badge--source-concept 포함", () => {
    const el = sourceBadge("concept");
    expect(el.textContent).toBe("개념");
    expect(el.classList.contains("badge--source-concept")).toBe(true);
  });

  test("imageVec → 텍스트 이미지, class badge--source-imageVec 포함", () => {
    const el = sourceBadge("imageVec");
    expect(el.textContent).toBe("이미지");
    expect(el.classList.contains("badge--source-imageVec")).toBe(true);
  });

  test("project → 텍스트 프로젝트, class badge--source-project 포함", () => {
    const el = sourceBadge("project");
    expect(el.textContent).toBe("프로젝트");
    expect(el.classList.contains("badge--source-project")).toBe(true);
  });

  test("person → 텍스트 사람, class badge--source-person 포함", () => {
    const el = sourceBadge("person");
    expect(el.textContent).toBe("사람");
    expect(el.classList.contains("badge--source-person")).toBe(true);
  });

  test("그래프 구조·입력 출처 키도 한국어로 표시한다", () => {
    expect(sourceBadge("classification_key").textContent).toBe("분류");
    expect(sourceBadge("entity_group").textContent).toBe("종류");
    expect(sourceBadge("memory").textContent).toBe("글");
    expect(sourceBadge("auto_capture").textContent).toBe("자동 저장");
    expect(sourceBadge("llm_extract").textContent).toBe("AI 추출");
    expect(sourceBadge("document_section").textContent).toBe("문서 구간");
    expect(sourceBadge("document_chunk").textContent).toBe("본문 조각");
    expect(sourceBadge("work").textContent).toBe("작품");
  });

  test("알 수 없는 source 는 텍스트 그대로 + class badge--source-foobar", () => {
    const el = sourceBadge("foobar");
    expect(el.textContent).toBe("foobar");
    expect(el.classList.contains("badge--source-foobar")).toBe(true);
  });

  test("displayGraphKindLabel 과 중복 판정은 같은 한국어 라벨을 기준으로 한다", () => {
    expect(displayGraphKindLabel("classification_key")).toBe("분류");
    expect(isSameDisplayGraphKind("memory", "text")).toBe(true);
    expect(isSameDisplayGraphKind("auto_capture", "memory")).toBe(false);
  });
});

// ──────────────────────────────────────────────
// stateBadge
// ──────────────────────────────────────────────
describe("stateBadge", () => {
  test("current → 텍스트 현재", () => {
    const el = stateBadge("current");
    expect(el.textContent).toBe("현재");
    expect(el.classList.contains("badge--state-current")).toBe(true);
  });

  test("superseded → 텍스트 대체됨", () => {
    const el = stateBadge("superseded");
    expect(el.textContent).toBe("대체됨");
    expect(el.classList.contains("badge--state-superseded")).toBe(true);
  });

  test("archived → 텍스트 보관", () => {
    const el = stateBadge("archived");
    expect(el.textContent).toBe("보관");
    expect(el.classList.contains("badge--state-archived")).toBe(true);
  });

  test("pending_review → 텍스트 검토대기", () => {
    const el = stateBadge("pending_review");
    expect(el.textContent).toBe("검토대기");
    expect(el.classList.contains("badge--state-pending_review")).toBe(true);
  });

  test("proposal → 텍스트 제안", () => {
    const el = stateBadge("proposal");
    expect(el.textContent).toBe("제안");
    expect(el.classList.contains("badge--state-proposal")).toBe(true);
  });

  test("project_paused → 텍스트 일시중지", () => {
    const el = stateBadge("project_paused");
    expect(el.textContent).toBe("일시중지");
    expect(el.classList.contains("badge--state-project_paused")).toBe(true);
  });

  test("project_done → 텍스트 완료", () => {
    const el = stateBadge("project_done");
    expect(el.textContent).toBe("완료");
    expect(el.classList.contains("badge--state-project_done")).toBe(true);
  });
});

// ──────────────────────────────────────────────
// markerBadge
// ──────────────────────────────────────────────
describe("markerBadge", () => {
  test("important → 텍스트 중요, class badge--marker-important", () => {
    const el = markerBadge("important");
    expect(el.textContent).toBe("중요");
    expect(el.classList.contains("badge")).toBe(true);
    expect(el.classList.contains("badge--marker-important")).toBe(true);
  });

  test("uncertain → 텍스트 미확인, class badge--marker-uncertain", () => {
    const el = markerBadge("uncertain");
    expect(el.textContent).toBe("미확인");
    expect(el.classList.contains("badge--marker-uncertain")).toBe(true);
  });

  test("supersedes → 텍스트 갱신함, class badge--marker-supersedes", () => {
    const el = markerBadge("supersedes");
    expect(el.textContent).toBe("갱신함");
    expect(el.classList.contains("badge--marker-supersedes")).toBe(true);
  });

  test("superseded → 텍스트 바뀜, class badge--marker-superseded", () => {
    const el = markerBadge("superseded");
    expect(el.textContent).toBe("바뀜");
    expect(el.classList.contains("badge--marker-superseded")).toBe(true);
  });
});

// ──────────────────────────────────────────────
// scoreChip
// ──────────────────────────────────────────────
describe("scoreChip", () => {
  test("0.4231 → 텍스트 0.423, class chip chip--score", () => {
    const el = scoreChip(0.4231);
    expect(el.textContent).toBe("0.423");
    expect(el.classList.contains("chip")).toBe(true);
    expect(el.classList.contains("chip--score")).toBe(true);
  });

  test("1.0 → 텍스트 1.000", () => {
    const el = scoreChip(1.0);
    expect(el.textContent).toBe("1.000");
  });

  test("0 → 텍스트 0.000", () => {
    const el = scoreChip(0);
    expect(el.textContent).toBe("0.000");
  });
});

// ──────────────────────────────────────────────
// tagChip
// ──────────────────────────────────────────────
describe("tagChip", () => {
  test("텍스트 그대로 반환, class chip chip--tag", () => {
    const el = tagChip("장소: 마트");
    expect(el.textContent).toBe("장소: 마트");
    expect(el.classList.contains("chip")).toBe(true);
    expect(el.classList.contains("chip--tag")).toBe(true);
  });

  test("특수문자 포함 텍스트도 그대로", () => {
    const el = tagChip("#주술회전 & 이타도리");
    expect(el.textContent).toBe("#주술회전 & 이타도리");
  });
});
