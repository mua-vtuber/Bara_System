/** node-detail.test.ts — nodeDetail 컴포넌트 "있는 칸만 그림" 검증 */

import { registerHappyDom } from "../test-happy-dom.ts";
registerHappyDom();

import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { nodeDetail, skipNodeDetailTypewriter } from "./node-detail.ts";
import type { CardView } from "./card-view.ts";
import { _resetTokenCacheForTest } from "../api-fetch.js";

const minimal: CardView = {
  nodeId: "mem:20",
  title: "최소 노드",
};

const full: CardView = {
  nodeId: "mem:21",
  title: "전체 노드",
  snippet: "내용 미리보기",
  sourceType: "graph",
  score: 0.77,
  kind: "회의",
  components: { graph: 0.44, vector: 0.31 },
  state: "current",
  markers: { important: true, superseded: false },
  sources: ["vector", "fts"],
  matchReason: ["제목 일치", "태그 일치"],
  tags: ["그래프", "메모리"],
  date: "2026-06-18",
};

const noOptional: CardView = {
  nodeId: "mem:22",
  title: "선택 칸 없음",
  snippet: "내용만",
};

let originalFetch: typeof globalThis.fetch;

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForSrc(img: HTMLImageElement | null): Promise<string | null> {
  for (let i = 0; i < 10; i++) {
    const src = img?.getAttribute("src") ?? null;
    if (src) return src;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return img?.getAttribute("src") ?? null;
}

beforeEach(() => {
  window.sessionStorage.setItem("bara.dashboard.token", "image-token");
  _resetTokenCacheForTest();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ token: "image-token" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  window.sessionStorage.removeItem("bara.dashboard.token");
  document.body.replaceChildren();
  globalThis.fetch = originalFetch;
  _resetTokenCacheForTest();
});

describe("nodeDetail", () => {
  it(".node-detail 컨테이너로 렌더링", () => {
    const el = nodeDetail(minimal);
    expect(el.classList.contains("node-detail")).toBe(true);
  });

  it(".node-detail__title 에 title 텍스트", () => {
    const el = nodeDetail(minimal);
    expect(el.querySelector(".node-detail__title")?.textContent).toBe("최소 노드");
  });

  describe("없는 칸 생략", () => {
    it("snippet 없으면 .node-detail__snippet 0개", () => {
      const el = nodeDetail(minimal);
      expect(el.querySelectorAll(".node-detail__snippet").length).toBe(0);
    });

    it("matchReason 없으면 .node-detail__match 0개", () => {
      const el = nodeDetail(minimal);
      expect(el.querySelectorAll(".node-detail__match").length).toBe(0);
    });

    it("sources 없으면 .node-detail__sources 0개", () => {
      const el = nodeDetail(minimal);
      expect(el.querySelectorAll(".node-detail__sources").length).toBe(0);
    });

    it("tags 없으면 .chip--tag 0개", () => {
      const el = nodeDetail(minimal);
      expect(el.querySelectorAll(".chip--tag").length).toBe(0);
    });

    it("date 없으면 .card__date 0개", () => {
      const el = nodeDetail(minimal);
      expect(el.querySelectorAll(".card__date").length).toBe(0);
    });

    it("score 없으면 .chip--score 0개", () => {
      const el = nodeDetail(noOptional);
      expect(el.querySelectorAll(".chip--score").length).toBe(0);
    });

    it("sourceType 없으면 source .badge 0개", () => {
      const el = nodeDetail(noOptional);
      // badge 자체가 0이어야 함(state·marker 도 없으므로)
      expect(el.querySelectorAll(".badge").length).toBe(0);
    });

    it("sources 빈 배열이면 .node-detail__sources 0개", () => {
      const view: CardView = { ...minimal, sources: [] };
      const el = nodeDetail(view);
      expect(el.querySelectorAll(".node-detail__sources").length).toBe(0);
    });
  });

  describe("있는 칸 그림", () => {
    it("snippet 있으면 .node-detail__snippet 1개", () => {
      const el = nodeDetail(full);
      expect(el.querySelectorAll(".node-detail__snippet").length).toBe(1);
    });

    it("renderMode=markdown 이면 안전 마크다운 HTML 로 렌더링한다", () => {
      const el = nodeDetail({
        ...minimal,
        snippet: "# 문서 제목\n\n- 항목",
        renderMode: "markdown",
      });
      const snippet = el.querySelector(".node-detail__snippet");
      expect(snippet?.classList.contains("graph-node-snippet")).toBe(true);
      expect(snippet?.querySelector("h1")?.textContent).toBe("문서 제목");
      expect(snippet?.querySelector("li")?.textContent).toBe("항목");
    });

    it("renderMode=markdown 이어도 위험 HTML 은 실행 가능한 노드로 만들지 않는다", () => {
      const el = nodeDetail({
        ...minimal,
        snippet: '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">',
        renderMode: "markdown",
      });
      expect(el.querySelector("script")).toBeNull();
      expect(el.querySelector("img")).toBeNull();
      expect(el.textContent).toContain("<script>alert(1)</script>");
    });

    it("renderMode 없으면 마크다운 문법을 평문으로 둔다", () => {
      const el = nodeDetail({ ...minimal, snippet: "# 제목" });
      expect(el.querySelector(".node-detail__snippet")?.textContent).toBe("# 제목");
      expect(el.querySelector("h1")).toBeNull();
    });

    it("animateContent=true 면 본문 타이핑 상태로 시작하고 skip 하면 전체 평문을 표시한다", () => {
      const el = nodeDetail({ ...minimal, snippet: "타닥타닥 나타나는 내용" }, { animateContent: true });
      const snippet = el.querySelector<HTMLElement>(".node-detail__snippet");
      expect(snippet?.classList.contains("node-detail__snippet--typing")).toBe(true);
      expect(snippet?.dataset["typewriterActive"]).toBe("true");
      expect(snippet?.textContent).toBe("");

      expect(skipNodeDetailTypewriter(el)).toBe(true);
      expect(snippet?.classList.contains("node-detail__snippet--typing")).toBe(false);
      expect(snippet?.dataset["typewriterActive"]).toBeUndefined();
      expect(snippet?.textContent).toBe("타닥타닥 나타나는 내용");
      expect(skipNodeDetailTypewriter(el)).toBe(false);
    });

    it("마크다운 본문도 skip 뒤 안전 마크다운 HTML 로 복원한다", () => {
      const el = nodeDetail({
        ...minimal,
        snippet: "# 문서 제목\n\n- 항목",
        renderMode: "markdown",
      }, { animateContent: true });

      expect(skipNodeDetailTypewriter(el)).toBe(true);
      expect(el.querySelector(".node-detail__snippet")?.querySelector("h1")?.textContent).toBe("문서 제목");
      expect(el.querySelector(".node-detail__snippet")?.querySelector("li")?.textContent).toBe("항목");
    });

    it("score 있으면 .chip--score 1개", () => {
      const el = nodeDetail(full);
      expect(el.querySelectorAll(".chip--score").length).toBe(1);
    });

    it("kind 있으면 .badge--kind 1개", () => {
      const el = nodeDetail(full);
      expect(el.querySelectorAll(".badge--kind").length).toBe(1);
    });

    it("nodeType 과 sourceType 이 같은 뜻이면 source 배지를 반복하지 않는다", () => {
      const el = nodeDetail({
        ...minimal,
        nodeType: "classification_key",
        sourceType: "classification_key",
      });
      expect(el.querySelectorAll(".badge--source-classification_key").length).toBe(0);
      expect(el.textContent).not.toContain("classification_key");
    });

    it("다른 뜻의 sourceType 은 한국어 배지로 표시한다", () => {
      const el = nodeDetail({
        ...minimal,
        nodeType: "memory",
        sourceType: "auto_capture",
      });
      expect(el.querySelector(".badge--source-auto_capture")?.textContent).toBe("자동 저장");
      expect(el.textContent).not.toContain("auto_capture");
    });

    it("components 있으면 점수 구성 칩을 그린다", () => {
      const el = nodeDetail(full);
      expect(el.querySelector(".node-detail__components-label")?.textContent).toBe("점수 구성");
      expect(el.querySelectorAll(".chip--component").length).toBe(2);
    });

    it("state 있으면 .badge--state-current 1개", () => {
      const el = nodeDetail(full);
      expect(el.querySelectorAll(".badge--state-current").length).toBe(1);
    });

    it("markers.important=true 면 .badge--marker-important 1개", () => {
      const el = nodeDetail(full);
      expect(el.querySelectorAll(".badge--marker-important").length).toBe(1);
    });

    it("markers.superseded=false 면 .badge--marker-superseded 0개", () => {
      const el = nodeDetail(full);
      expect(el.querySelectorAll(".badge--marker-superseded").length).toBe(0);
    });

    it("sources 있으면 .node-detail__sources 1개", () => {
      const el = nodeDetail(full);
      expect(el.querySelectorAll(".node-detail__sources").length).toBe(1);
    });

    it("sources 2개면 그 안에 .badge 2개", () => {
      const el = nodeDetail(full);
      const src = el.querySelector(".node-detail__sources");
      expect(src?.querySelectorAll(".badge").length).toBe(2);
    });

    it("matchReason 있으면 .node-detail__match 1개", () => {
      const el = nodeDetail(full);
      expect(el.querySelectorAll(".node-detail__match").length).toBe(1);
    });

    it("matchReason 안 각 사유가 자식으로 들어감", () => {
      const el = nodeDetail(full);
      const match = el.querySelector(".node-detail__match");
      expect(match?.children.length).toBe(2);
    });

    it("tags 있으면 .chip--tag 그림", () => {
      const el = nodeDetail(full);
      expect(el.querySelectorAll(".chip--tag").length).toBe(2);
    });

    it("tags 있으면 태그 라벨을 함께 그린다", () => {
      const el = nodeDetail(full);
      expect(el.querySelector(".node-detail__tags-label")?.textContent).toBe("태그");
    });

    it("date 있으면 .card__date 1개", () => {
      const el = nodeDetail(full);
      expect(el.querySelectorAll(".card__date").length).toBe(1);
    });

    it("eventAt+eventUntil 있으면 .node-detail__schedule 에 scheduleLineText 출력", () => {
      const view: CardView = {
        ...minimal,
        eventAt: "2026-06-01T00:00:00.000Z",
        eventUntil: "2026-06-05T00:00:00.000Z",
      };
      const el = nodeDetail(view);
      const line = el.querySelector(".node-detail__schedule");
      expect(line?.textContent).toBe("일정: 2026-06-01 → 2026-06-05");
    });

    it("eventAt 만 있으면 .node-detail__schedule 에 시작만", () => {
      const view: CardView = { ...minimal, eventAt: "2026-06-01T14:00:00.000Z" };
      const el = nodeDetail(view);
      expect(el.querySelector(".node-detail__schedule")?.textContent).toBe("일정: 2026-06-01");
    });

    it("eventAt 없으면 .node-detail__schedule 0개", () => {
      const el = nodeDetail(minimal);
      expect(el.querySelectorAll(".node-detail__schedule").length).toBe(0);
    });

    it("images 가 있으면 썸네일을 그리고 클릭 시 원본 모달을 연다", async () => {
      const assetSha = "a".repeat(64);
      const thumbSha = "b".repeat(64);
      const el = nodeDetail({
        ...minimal,
        images: [{ assetSha256: assetSha, thumbSha256: thumbSha, alt: "작업컴 이미지" }],
      });
      document.body.append(el);
      await flushMicrotasks();

      const thumb = el.querySelector<HTMLButtonElement>(".node-detail__image-thumb");
      expect(thumb).not.toBeNull();
      const thumbImg = thumb!.querySelector("img");
      expect(await waitForSrc(thumbImg)).toBe(`/thumbs/${thumbSha}?token=image-token`);

      thumb!.click();
      await flushMicrotasks();

      const modal = document.querySelector<HTMLElement>(".node-image-modal");
      expect(modal).not.toBeNull();
      const modalImg = modal!.querySelector("img");
      expect(await waitForSrc(modalImg)).toBe(`/assets/${assetSha}?token=image-token`);

      modal!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(document.querySelector(".node-image-modal")).toBeNull();
    });
  });
});
