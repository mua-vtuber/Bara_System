/** memory-card.test.ts — memoryCard 컴포넌트 "있는 칸만 그림" 검증 */

import { registerHappyDom } from "../test-happy-dom.ts";
registerHappyDom();

import { describe, it, expect } from "bun:test";
import { memoryCard } from "./memory-card.ts";
import type { CardView } from "./card-view.ts";

// ── 최소 CardView (title만) ──────────────────────────────────────
const minimal: CardView = {
  nodeId: "mem:1",
  title: "제목만 있는 글",
};

// ── 풍부한 CardView ──────────────────────────────────────────────
const rich: CardView = {
  nodeId: "mem:2",
  title: "풍부한 글",
  snippet: "이것이 내용 미리보기입니다",
  nodeType: "document",
  sourceType: "vector",
  score: 0.872,
  kind: "일정",
  components: { vector: 0.52, fts: 0.35 },
  tags: ["일상", "메모"],
  date: "2026-06-18",
  markers: { important: true, uncertain: false },
};

// ── tags 없는 detail 용 ──────────────────────────────────────────
const noTags: CardView = {
  nodeId: "mem:3",
  title: "태그 없음",
  snippet: "내용",
  score: 0.5,
};

describe("memoryCard", () => {
  describe("top3 mode — 없는 칸 생략", () => {
    it("snippet 없으면 .card__snippet 0개", () => {
      const card = memoryCard(minimal, "top3");
      expect(card.querySelectorAll(".card__snippet").length).toBe(0);
    });

    it("title 은 항상 존재", () => {
      const card = memoryCard(minimal, "top3");
      expect(card.querySelector(".card__title")?.textContent).toBe("제목만 있는 글");
    });

    it("sourceType·score 없으면 badge·chip 0개", () => {
      const card = memoryCard(minimal, "top3");
      expect(card.querySelectorAll(".badge").length).toBe(0);
      expect(card.querySelectorAll(".chip--score").length).toBe(0);
    });
  });

  describe("top3 mode — 있는 칸 그림", () => {
    it("snippet 있으면 .card__snippet 1개", () => {
      const card = memoryCard(rich, "top3");
      expect(card.querySelectorAll(".card__snippet").length).toBe(1);
    });

    it("sourceType 있으면 .badge 1개 이상", () => {
      const card = memoryCard(rich, "top3");
      expect(card.querySelectorAll(".badge").length).toBeGreaterThanOrEqual(1);
    });

    it("score 있으면 .chip--score 1개", () => {
      const card = memoryCard(rich, "top3");
      expect(card.querySelectorAll(".chip--score").length).toBe(1);
    });

    it("markers.important=true 면 .badge--marker-important 1개", () => {
      const card = memoryCard(rich, "top3");
      expect(card.querySelectorAll(".badge--marker-important").length).toBe(1);
    });

    it("markers.uncertain=false 면 .badge--marker-uncertain 0개", () => {
      const card = memoryCard(rich, "top3");
      expect(card.querySelectorAll(".badge--marker-uncertain").length).toBe(0);
    });

    it("kind·nodeType·components 를 정보 줄로 그린다", () => {
      const card = memoryCard(rich, "top3");
      expect(card.querySelectorAll(".badge--kind").length).toBe(1);
      expect(card.querySelector(".card__node-type")?.textContent).toBe("문서");
      expect(card.querySelector(".card__components-label")?.textContent).toBe("점수 근거");
      expect(card.querySelectorAll(".chip--component").length).toBe(2);
    });

    it("nodeType 과 sourceType 이 같은 뜻이면 source 배지를 한 번 더 그리지 않는다", () => {
      const card = memoryCard(
        {
          nodeId: "concept:work",
          title: "작품",
          nodeType: "classification_key",
          sourceType: "classification_key",
        },
        "top3",
      );
      expect(card.querySelector(".card__node-type")?.textContent).toBe("분류");
      expect(card.querySelectorAll(".badge--source-classification_key").length).toBe(0);
      expect(card.textContent).not.toContain("classification_key");
    });

    it("서로 다른 글 종류와 입력 출처는 한국어로 각각 한 번씩 보인다", () => {
      const card = memoryCard(
        {
          nodeId: "node:1",
          title: "메모",
          nodeType: "memory",
          sourceType: "auto_capture",
        },
        "top3",
      );
      expect(card.querySelector(".card__node-type")?.textContent).toBe("글");
      expect(card.querySelector(".badge--source-auto_capture")?.textContent).toBe("자동 저장");
      expect(card.textContent).not.toContain("memory");
      expect(card.textContent).not.toContain("auto_capture");
    });
  });

  describe("mode 별 컨테이너 class", () => {
    it("top3 → card--top3", () => {
      const card = memoryCard(minimal, "top3");
      expect(card.classList.contains("card--top3")).toBe(true);
    });

    it("list → card--list", () => {
      const card = memoryCard(minimal, "list");
      expect(card.classList.contains("card--list")).toBe(true);
    });

    it("detail → card--detail", () => {
      const card = memoryCard(minimal, "detail");
      expect(card.classList.contains("card--detail")).toBe(true);
    });

    it("모든 mode 에 card class 공통 포함", () => {
      for (const mode of ["top3", "list", "detail"] as const) {
        expect(memoryCard(minimal, mode).classList.contains("card")).toBe(true);
      }
    });
  });

  describe("detail mode — 추가 칸", () => {
    it("tags 있으면 .chip--tag 그림", () => {
      const card = memoryCard(rich, "detail");
      expect(card.querySelectorAll(".chip--tag").length).toBe(2);
    });

    it("tags 없으면 .chip--tag 0개", () => {
      const card = memoryCard(noTags, "detail");
      expect(card.querySelectorAll(".chip--tag").length).toBe(0);
    });

    it("date 있으면 .card__date 1개", () => {
      const card = memoryCard(rich, "detail");
      expect(card.querySelectorAll(".card__date").length).toBe(1);
    });

    it("date 없으면 .card__date 0개", () => {
      const card = memoryCard(noTags, "detail");
      expect(card.querySelectorAll(".card__date").length).toBe(0);
    });

    it("eventAt+eventUntil 있으면 .card__schedule 에 scheduleLineText 출력", () => {
      const view: CardView = {
        nodeId: "mem:9",
        title: "기간 일정",
        eventAt: "2026-06-01T00:00:00.000Z",
        eventUntil: "2026-06-05T00:00:00.000Z",
      };
      const card = memoryCard(view, "detail");
      expect(card.querySelector(".card__schedule")?.textContent).toBe("일정: 2026-06-01 → 2026-06-05");
    });

    it("eventAt 만 있으면 .card__schedule 에 시작만", () => {
      const view: CardView = {
        nodeId: "mem:10",
        title: "단일 일정",
        eventAt: "2026-06-01T14:00:00.000Z",
      };
      const card = memoryCard(view, "detail");
      expect(card.querySelector(".card__schedule")?.textContent).toBe("일정: 2026-06-01");
    });
  });

  describe("hover mode — 종류 줄 + 내용 표시", () => {
    it("snippet 이 있으면 제목 없이 snippet 을 표시하고 tags/date 없음", () => {
      const elx = memoryCard(
        { nodeId: "n1", title: "제목", snippet: "내용", tags: ["t"], date: "2026-06-21" } as CardView,
        "hover",
      );
      expect(elx.className).toContain("card--hover");
      expect(elx.querySelector(".card__title")).toBeNull();
      expect(elx.querySelector(".card__snippet")?.textContent).toBe("내용");
      expect(elx.querySelector(".card__tags")).toBeNull();
      expect(elx.querySelector(".card__date")).toBeNull();
      expect(elx.textContent).not.toContain("제목");
    });

    it("kind 와 nodeType 이 있으면 hover 카드 상단에 종류 배지를 표시한다", () => {
      const card = memoryCard(
        { nodeId: "n2", title: "제목", snippet: "내용", kind: "가계부", nodeType: "memory" },
        "hover",
      );
      expect(card.querySelector(".card__kicker")).not.toBeNull();
      expect(card.querySelector(".badge--kind")?.textContent).toBe("가계부");
      expect(card.querySelector(".card__node-type")?.textContent).toBe("글");
    });

    it("snippet 이 없으면 title 을 내용으로 대체한다", () => {
      const card = memoryCard(minimal, "hover");
      expect(card.querySelector(".card__title")).toBeNull();
      expect(card.querySelector(".card__snippet")?.textContent).toBe("제목만 있는 글");
    });

    it("card class 공통 포함", () => {
      const card = memoryCard(minimal, "hover");
      expect(card.classList.contains("card")).toBe(true);
    });
  });

  describe("list mode — detail 전용 칸 제외", () => {
    it("list 에서 tags 있어도 .chip--tag 0개", () => {
      const card = memoryCard(rich, "list");
      expect(card.querySelectorAll(".chip--tag").length).toBe(0);
    });

    it("list 에서 date 있어도 .card__date 0개", () => {
      const card = memoryCard(rich, "list");
      expect(card.querySelectorAll(".card__date").length).toBe(0);
    });

    it("list 에서 eventAt 있어도 .card__schedule 0개", () => {
      const view: CardView = { ...rich, eventAt: "2026-06-01T00:00:00.000Z" };
      const card = memoryCard(view, "list");
      expect(card.querySelectorAll(".card__schedule").length).toBe(0);
    });
  });

  describe("sources 채널 배지 — top3 mode", () => {
    it("sources 있으면 채널 sourceBadge 추가", () => {
      const withSources: CardView = {
        nodeId: "mem:5",
        title: "채널 배지 테스트",
        sources: ["fts", "vector"],
      };
      const card = memoryCard(withSources, "top3");
      // fts 채널 배지와 vector 채널 배지 각 1개
      expect(card.querySelectorAll(".badge--source-fts").length).toBe(1);
      expect(card.querySelectorAll(".badge--source-vector").length).toBe(1);
    });

    it("sources 없으면 채널 배지 없음", () => {
      const card = memoryCard(minimal, "top3");
      expect(card.querySelectorAll('[class*="badge--source-"]').length).toBe(0);
    });
  });
});
