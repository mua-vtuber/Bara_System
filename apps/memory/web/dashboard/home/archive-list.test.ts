import { afterEach, beforeEach, expect, test } from "bun:test";
import { registerHappyDom } from "../test-happy-dom.ts";
import { _resetTokenCacheForTest } from "../api-fetch.ts";
import { renderArchiveList } from "./archive-list.ts";
registerHappyDom();
const originalFetch = globalThis.fetch;
let failNext = false;
beforeEach(() => {
  window.sessionStorage.setItem("bara.dashboard.token", "fixture");
  _resetTokenCacheForTest();
  failNext = false;
  globalThis.fetch = (async (input) => {
    const path = String(input);
    if (path.includes("/dashboard/sse-token")) return Response.json({token: "fixture"});
    if (failNext) { failNext = false; throw new Error("offline"); }
    const url = new URL(path, "http://localhost");
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const end = Math.min(offset + limit, 205);
    return Response.json({
      archive: Array.from({length: end - offset}, (_, i) => ({id: 205 - offset - i, content: "기억 " + (205 - offset - i)})),
      total: 205, nextCursor: end < 205 ? String(end) : null,
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
  window.sessionStorage.clear();
  _resetTokenCacheForTest();
});
async function settled(host: HTMLElement): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (!host.querySelector<HTMLButtonElement>("[data-archive-more]")?.disabled) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("목록 조회 미완료");
}
test("205개의 휴지통 항목을 더보기로 끝까지 읽고 총개수를 표시한다", async () => {
  const host = renderArchiveList(async () => {});
  document.body.append(host);
  await settled(host);
  const more = host.querySelector<HTMLButtonElement>("[data-archive-more]")!;
  expect(host.textContent).toContain("205건");
  expect(host.querySelectorAll(".archive-item")).toHaveLength(50);
  for (let i = 0; i < 4; i++) { more.click(); await settled(host); }
  expect(host.querySelectorAll(".archive-item")).toHaveLength(205);
  expect(more.hidden).toBe(true);
  expect(host.querySelectorAll(".archive-item-content")[204]!.textContent).toBe("기억 1");
});
test("다음 페이지 오류는 읽은 항목을 보존하고 같은 위치에서 다시 시도한다", async () => {
  const host = renderArchiveList(async () => {});
  document.body.append(host);
  await settled(host);
  const more = host.querySelector<HTMLButtonElement>("[data-archive-more]")!;
  failNext = true;
  more.click(); await settled(host);
  expect(host.querySelectorAll(".archive-item")).toHaveLength(50);
  expect(more.textContent).toContain("다시");
  more.click(); await settled(host);
  expect(host.querySelectorAll(".archive-item")).toHaveLength(100);
});

test("두 복구의 목록 갱신 응답이 역전되어도 최신 총개수를 유지한다", async () => {
  const counts: ((response: Response) => void)[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path.includes("/dashboard/sse-token")) return Response.json({token: "fixture"});
    if (init?.method === "POST") return Response.json({restored: true});
    if (path.includes("limit=1")) return await new Promise<Response>(resolve => counts.push(resolve));
    return Response.json({archive: [{id: 2, content: "두 번째"}, {id: 1, content:"첫 번째"}], total:2, nextCursor:null});
  }) as typeof fetch;
  const host = renderArchiveList(async () => {});
  document.body.append(host); await settled(host);
  const buttons = host.querySelectorAll<HTMLButtonElement>(".archive-item .dash-secondary-actions > button:first-child");
  buttons[0]!.click(); buttons[1]!.click();
  for (let i=0; i<100 && counts.length<2; i++) await new Promise(resolve=>setTimeout(resolve, 2));
  expect(counts.length).toBe(2);
  counts[1]!(Response.json({archive:[],total:0,nextCursor:null}));
  await new Promise(resolve=>setTimeout(resolve, 5));
  counts[0]!(Response.json({archive:[],total:1,nextCursor:null}));
  await new Promise(resolve=>setTimeout(resolve, 5));
  expect(host.querySelector(".dash-secondary-count")!.textContent).toBe("휴지통 0건");
});
