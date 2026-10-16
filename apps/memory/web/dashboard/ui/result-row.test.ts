/** result-row.test.ts — resultRow 컴포넌트 검증 */

import { registerHappyDom } from "../test-happy-dom.ts";
registerHappyDom();

import { describe, it, expect, mock } from "bun:test";
import { resultRow } from "./result-row.ts";
import type { CardView } from "./card-view.ts";

const full: CardView = {
  nodeId: "mem:10",
  title: "검색 결과 항목",
  sourceType: "fts",
  score: 0.91,
};

const minimal: CardView = {
  nodeId: "mem:11",
  title: "최소 항목",
};

describe("resultRow", () => {
  it("button.rp-row 로 렌더링", () => {
    const row = resultRow(full, { onPick: () => {} });
    expect(row.tagName.toLowerCase()).toBe("button");
    expect(row.classList.contains("rp-row")).toBe(true);
  });

  it("dataset.nodeId 에 view.nodeId 저장", () => {
    const row = resultRow(full, { onPick: () => {} });
    expect((row as HTMLButtonElement).dataset["nodeId"]).toBe("mem:10");
  });

  it(".rp-row__label 에 title 텍스트", () => {
    const row = resultRow(full, { onPick: () => {} });
    expect(row.querySelector(".rp-row__label")?.textContent).toBe("검색 결과 항목");
  });

  it("click 시 onPick 이 view.nodeId 로 호출", () => {
    const onPick = mock((id: string) => id);
    const row = resultRow(full, { onPick });
    row.click();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("mem:10");
  });

  it("sourceType 있으면 .badge 1개", () => {
    const row = resultRow(full, { onPick: () => {} });
    expect(row.querySelectorAll(".badge").length).toBe(1);
  });

  it("score 는 줄 안에 칩으로 그리지 않고 툴팁으로만 보인다", () => {
    const row = resultRow(full, { onPick: () => {} });
    expect(row.querySelectorAll(".chip--score").length).toBe(0);
    expect(row.title).toBe("검색 점수 0.910");
  });

  it("종류 배지가 출처 배지와 같은 라벨이면 한 번만 보인다", () => {
    const row = resultRow(
      { nodeId: "mem:30", title: "프로젝트 글", sources: ["vector", "project"], kind: "프로젝트" },
      { onPick: () => {} },
    );
    const labels = [...row.querySelectorAll(".badge")].map((b) => b.textContent);
    expect(labels.filter((t) => t === "프로젝트").length).toBe(1);
    expect(labels).toContain("의미");
  });

  it("출처와 다른 종류 배지는 그대로 보인다", () => {
    const row = resultRow(
      { nodeId: "mem:31", title: "사람 글", sources: ["vector"], kind: "사람" },
      { onPick: () => {} },
    );
    expect(row.querySelector(".badge--kind")?.textContent).toBe("사람");
  });

  it("sourceType 없으면 .badge 0개", () => {
    const row = resultRow(minimal, { onPick: () => {} });
    expect(row.querySelectorAll(".badge").length).toBe(0);
  });

  it("score 없으면 툴팁도 없다", () => {
    const row = resultRow(minimal, { onPick: () => {} });
    expect(row.title).toBe("");
  });

  it("sources 있으면 채널 배지 그림", () => {
    const withSources: CardView = {
      nodeId: "mem:20",
      title: "채널 있는 결과",
      sources: ["fts", "graph"],
    };
    const row = resultRow(withSources, { onPick: () => {} });
    expect(row.querySelectorAll(".badge--source-fts").length).toBe(1);
    expect(row.querySelectorAll(".badge--source-graph").length).toBe(1);
  });

  it("nodeType 과 같은 sourceType 은 반복하지 않고 raw 키를 노출하지 않는다", () => {
    const row = resultRow(
      {
        nodeId: "concept:work",
        title: "작품",
        nodeType: "classification_key",
        sourceType: "classification_key",
        sources: ["classification_key", "graph"],
      },
      { onPick: () => {} },
    );
    expect(row.querySelectorAll(".badge--source-classification_key").length).toBe(0);
    expect(row.querySelector(".badge--source-graph")?.textContent).toBe("그래프");
    expect(row.textContent).not.toContain("classification_key");
  });

  it("markers.supersedes=true 면 갱신함 배지 그림", () => {
    const supersedes: CardView = {
      nodeId: "mem:21",
      title: "갱신 결과",
      markers: { supersedes: true },
    };
    const row = resultRow(supersedes, { onPick: () => {} });
    expect(row.querySelectorAll(".badge--marker-supersedes").length).toBe(1);
  });

  it("markers.superseded=true 면 바뀜 배지 그림", () => {
    const superseded: CardView = {
      nodeId: "mem:22",
      title: "대체된 결과",
      markers: { superseded: true },
    };
    const row = resultRow(superseded, { onPick: () => {} });
    expect(row.querySelectorAll(".badge--marker-superseded").length).toBe(1);
  });

  it("markers 없으면 revision 배지 없음", () => {
    const row = resultRow(minimal, { onPick: () => {} });
    expect(row.querySelectorAll(".badge--marker-supersedes").length).toBe(0);
    expect(row.querySelectorAll(".badge--marker-superseded").length).toBe(0);
  });
});
