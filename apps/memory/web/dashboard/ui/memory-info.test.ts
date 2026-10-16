/** memory-info.test.ts — "정보" 접힘 블록: 출처 라벨·저장 경로 이름·없음 처리·지연 불러오기 */

import { registerHappyDom } from "../test-happy-dom.ts";
registerHappyDom();

import { describe, expect, it } from "bun:test";
import {
  fieldSourceLabel,
  memoryInfoFromMemory,
  memoryInfoSection,
  platformLabel,
  type MemoryInfo,
} from "./memory-info.ts";
import { nodeDetail } from "./node-detail.ts";

const baseMemory = {
  id: 87,
  content: "내용",
  author: "민수",
  platform: "mcp",
  eventAt: "2026-10-20",
  eventUntil: null,
  place: "속초",
  places: ["속초"],
  metadata: { fieldSources: { place: "direct", event_at: "inferred" } },
};

function rows(section: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of section.querySelectorAll(".memory-info__row")) {
    out[row.querySelector("dt")!.textContent!] = row.querySelector("dd")!.textContent!;
  }
  return out;
}

describe("라벨", () => {
  it("출처 키를 직접 입력/추출/추론 으로 바꾼다", () => {
    expect(fieldSourceLabel("direct")).toBe("직접 입력");
    expect(fieldSourceLabel("system")).toBe("추출");
    expect(fieldSourceLabel("inferred")).toBe("추론");
    expect(fieldSourceLabel("other")).toBeUndefined();
  });

  it("저장 경로 값을 읽기 쉬운 이름으로, 모르는 값은 그대로 보인다", () => {
    expect(platformLabel("mcp")).toBe("AI 앱(MCP)");
    expect(platformLabel("pet")).toBe("펫 앱");
    expect(platformLabel("dashboard:manual")).toBe("대시보드");
    expect(platformLabel("dashboard")).toBe("대시보드");
    expect(platformLabel("discord-dm")).toBe("디스코드(DM)");
    expect(platformLabel("discord-channel")).toBe("디스코드(채널)");
    expect(platformLabel("slack")).toBe("slack");
    expect(platformLabel("")).toBeUndefined();
  });
});

describe("memoryInfoFromMemory", () => {
  it("목록 요약처럼 작성자·저장 경로·metadata 칸이 없으면 정보가 없다", () => {
    expect(memoryInfoFromMemory({ id: 1, content: "x" })).toBeUndefined();
  });

  it("상세 응답에서 장소·시각 출처를 metadata.fieldSources 로 읽는다", () => {
    const info = memoryInfoFromMemory(baseMemory)!;
    expect(info.places).toEqual(["속초"]);
    expect(info.placeSource).toBe("direct");
    expect(info.eventAtSource).toBe("inferred");
    expect(info.eventUntilSource).toBeUndefined();
    expect(info.author).toBe("민수");
    expect(info.platform).toBe("mcp");
  });

  it("옛 서버처럼 places 없이 place 만 와도 읽는다", () => {
    const info = memoryInfoFromMemory({ ...baseMemory, places: undefined })!;
    expect(info.places).toEqual(["속초"]);
  });
});

describe("memoryInfoSection", () => {
  it("의미추출과 같은 접힘 요소(details.node-window__extracts)이고 기본은 접혀 있다", () => {
    const section = memoryInfoSection({ info: memoryInfoFromMemory(baseMemory)! })! as HTMLDetailsElement;
    expect(section.tagName.toLowerCase()).toBe("details");
    expect(section.classList.contains("node-window__extracts")).toBe(true);
    expect(section.open).toBe(false);
    expect(section.querySelector("summary")?.textContent).toBe("정보");
  });

  it("장소·시각은 출처와 함께, 작성자·저장 경로는 이름으로 보인다", () => {
    const section = memoryInfoSection({ info: memoryInfoFromMemory(baseMemory)! })!;
    expect(rows(section)).toEqual({
      장소: "속초 · 직접 입력",
      시각: "2026-10-20 · 추론",
      작성자: "민수",
      "저장 경로": "AI 앱(MCP)",
    });
  });

  it("비어 있으면 없음, 값은 있는데 출처 기록이 없으면 출처 기록 없음", () => {
    const empty = memoryInfoFromMemory({ ...baseMemory, author: "", platform: "", eventAt: null, place: null, places: [] })!;
    expect(rows(memoryInfoSection({ info: empty })!)).toEqual({
      장소: "없음", 시각: "없음", 작성자: "없음", "저장 경로": "없음",
    });
    const noSource = memoryInfoFromMemory({ ...baseMemory, metadata: {} })!;
    const r = rows(memoryInfoSection({ info: noSource })!);
    expect(r["장소"]).toBe("속초 · 출처 기록 없음");
    expect(r["시각"]).toBe("2026-10-20 · 출처 기록 없음");
  });

  it("기간이면 시작 → 종료, 출처가 다르면 따로 적는다", () => {
    const info = memoryInfoFromMemory({
      ...baseMemory,
      eventUntil: "2026-10-22",
      metadata: { fieldSources: { event_at: "direct", event_until: "system" } },
    })!;
    expect(rows(memoryInfoSection({ info })!)["시각"]).toBe("2026-10-20 → 2026-10-22 · 시작 직접 입력 / 종료 추출");
  });

  it("장소가 여럿이면 쉼표로 잇는다", () => {
    const info = memoryInfoFromMemory({ ...baseMemory, places: ["속초", "강릉"] })!;
    expect(rows(memoryInfoSection({ info })!)["장소"]).toBe("속초, 강릉 · 직접 입력");
  });

  it("모르는 저장 경로는 그대로, 알려진 값은 원래 값을 툴팁으로 남긴다", () => {
    const info = memoryInfoFromMemory({ ...baseMemory, platform: "slack" })!;
    expect(rows(memoryInfoSection({ info })!)["저장 경로"]).toBe("slack");
    const known = memoryInfoSection({ info: memoryInfoFromMemory(baseMemory)! })!;
    expect(known.querySelectorAll("dd")[3]?.getAttribute("title")).toBe("mcp");
  });

  it("정보도 불러오기도 없으면 그리지 않는다", () => {
    expect(memoryInfoSection({})).toBeNull();
  });

  it("지연 불러오기 — 처음 펼칠 때 한 번만 불러오고, 실패하면 다시 펼칠 때 재시도한다", async () => {
    let calls = 0;
    const info: MemoryInfo = memoryInfoFromMemory(baseMemory)!;
    const section = memoryInfoSection({
      load: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return info;
      },
    })! as HTMLDetailsElement;
    document.body.append(section);
    const wait = () => new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(0);
    section.open = true;
    section.dispatchEvent(new Event("toggle"));
    await wait(); await wait();
    expect(calls).toBe(1);
    expect(section.textContent).toContain("불러오지 못했습니다");
    section.open = false; section.dispatchEvent(new Event("toggle"));
    section.open = true; section.dispatchEvent(new Event("toggle"));
    await wait(); await wait();
    expect(calls).toBe(2);
    expect(rows(section)["작성자"]).toBe("민수");
    section.open = false; section.dispatchEvent(new Event("toggle"));
    section.open = true; section.dispatchEvent(new Event("toggle"));
    await wait();
    expect(calls).toBe(2);
    section.remove();
  });
});

describe("nodeDetail 안의 정보", () => {
  it("view.info 가 있으면 접힌 정보 블록을 그리고, 번호는 접히지 않는 배지 줄에 남는다", () => {
    const detail = nodeDetail({ nodeId: "node:87", memoryId: 87, title: "제목", info: memoryInfoFromMemory(baseMemory)! });
    const section = detail.querySelector<HTMLDetailsElement>("details.memory-info")!;
    expect(section.open).toBe(false);
    expect(section.contains(detail.querySelector(".memory-no"))).toBe(false);
    expect(detail.querySelector(".memory-no")?.textContent).toBe("#87");
  });

  it("view.info 가 없으면 정보 블록이 없다", () => {
    expect(nodeDetail({ nodeId: "node:87", title: "제목" }).querySelector(".memory-info")).toBeNull();
  });
});
