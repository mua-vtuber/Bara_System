/**
 * ingest-form.mount.test.ts — mountIngestForm DOM 배선 검증(S8·happy-dom).
 *
 * 순수 로직(ingest-form.test.ts)과 분리한 까닭: 이 테스트는 DOM 구조만 확인하고 core import 는
 * 하지 않는다. MIME 권위 정합은 ingest-form.test.ts 가 가벼운 image-mime.ts 상수로 확인한다.
 * happy-dom 이 globalThis.URL 을 바꾼 상태에서 무거운 서버 모듈을 끌어오면 transformers 같은
 * 의존성이 상대 URL 처리로 깨질 수 있어, 이 파일은 ingest-form.js(transformers import 0)만 import 한다.
 *
 * 검증 축(S8): 종류 select·일정 date·동적 칸 마크업 제거(결정 1) / 텍스트 전송 핵심 마크업
 * 회귀 0 / 미리보기 패널 input 갱신·non-blocking(S7) / 자동완성 드롭다운 배선(S6) / 칸 자동
 * 표시 자리(결정 6) / el 누락 throw(No-fallback). CSS·시각 레이아웃은 happy-dom 밖이라 라이브
 * (S9) 몫이다. fetch(entity-types·tag-suggest·sse-token)는 stub 으로 갈아 끼운다 — 인터페이스
 * 가짜 구현이 아니라 네트워크 경계 stub 다(tag-autocomplete.test.ts 양식·Mock 0).
 */

import "../../test-setup-dom";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { _resetTokenCacheForTest } from "./api-fetch.ts";
import { mountIngestForm } from "./ingest-form.js";
import { el } from "./graph/shell/dom.ts";

describe("mountIngestForm — 폼 개조·미리보기·자동완성 배선 (S8)", () => {
  const noop = (): void => {};
  const escapeHtml = (s: string): string => s;

  // happy-dom 의 fetch 는 상대 URL("/api/entity-types")을 "Invalid URL" 로 거부한다. 마운트가
  // 부르는 entity-types·tag-suggest·sse-token 호출을 빈 정상 응답으로 갈아 끼워 배선 로드를
  // 깔끔히 끝낸다(실제 운영은 브라우저 same-origin 절대 URL 이라 무관).
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    window.sessionStorage.setItem("bara.dashboard.token", "t");
    _resetTokenCacheForTest();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/dashboard/sse-token")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      }
      if (url.includes("/api/entity-types")) {
        return new Response(JSON.stringify({ entityTypes: [] }), { status: 200 });
      }
      if (url.includes("/api/tag-suggest")) {
        return new Response(JSON.stringify({ tags: [] }), { status: 200 });
      }
      if (url.endsWith("/ingest")) {
        return new Response(JSON.stringify({ ok: true, type: "text", originNodeId: 1 }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;
  });
  afterEach(() => {
    window.sessionStorage.removeItem("bara.dashboard.token");
    globalThis.fetch = realFetch;
    _resetTokenCacheForTest();
  });

  /**
   * 폼을 마운트하고, 배선이 부르는 fetch 체인(sse-token→entity-types·tag-suggest)이 stub 응답
   * 으로 다 끝날 때까지 macrotask 한 번을 비운다. 정착을 안 기다리면 진행 중 fetch promise 가
   * 다음 테스트 사이로 새 unhandled rejection 으로 잡힌다.
   */
  async function mountAndSettle(): Promise<HTMLElement> {
    const mountEl = el("div");
    mountIngestForm({ mountEl, apiBase: "", escapeHtml, onIngested: noop, el });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return mountEl;
  }

  test("종류 select·일정 date·동적 칸 마크업이 모두 제거됐다(결정 1)", async () => {
    const mountEl = await mountAndSettle();
    expect(mountEl.querySelector("[data-ingest-kind]")).toBeNull();
    expect(mountEl.querySelector("[data-ingest-event-start]")).toBeNull();
    expect(mountEl.querySelector("[data-ingest-event-end]")).toBeNull();
    expect(mountEl.querySelector("[data-ingest-fields]")).toBeNull();
    // 옛 종류 헤더 컨테이너도 없다.
    expect(mountEl.querySelector(".ingest-kind-header")).toBeNull();
  });

  test("텍스트 전송 핵심 마크업은 그대로다(회귀 0 — input·send·add·file·drop box)", async () => {
    const mountEl = await mountAndSettle();
    expect(mountEl.querySelector("[data-ingest-input]")).not.toBeNull();
    expect(mountEl.querySelector("[data-ingest-send]")).not.toBeNull();
    expect(mountEl.querySelector("[data-ingest-add]")).not.toBeNull();
    expect(mountEl.querySelector("[data-ingest-file]")).not.toBeNull();
    expect(mountEl.querySelector("[data-ingest-box]")).not.toBeNull();
    expect(mountEl.querySelector("[data-ingest-attachments]")).not.toBeNull();
  });

  test("미리보기 패널이 붙고 input 이벤트마다 갱신된다(S7 배선·non-blocking)", async () => {
    const mountEl = await mountAndSettle();
    const previewEl = mountEl.querySelector("[data-ingest-preview]") as HTMLElement;
    expect(previewEl).not.toBeNull();
    const inputEl = mountEl.querySelector("[data-ingest-input]") as HTMLTextAreaElement;
    // 빈 입력이면 "인식된 태그 없음" 정직한 빈 상태.
    expect(previewEl.querySelector(".preview-empty")).not.toBeNull();
    // 종류 토큰을 치면 미리보기 종류 줄이 갱신된다.
    inputEl.value = "#가계부:미용, 투블럭";
    inputEl.dispatchEvent(new Event("input"));
    expect(
      previewEl.querySelector('[data-preview-field="kind"] .preview-value')?.textContent,
    ).toBe("가계부");
    // non-blocking — 미리보기가 textarea 값을 건드리지 않는다(타이핑 안 막음).
    expect(inputEl.value).toBe("#가계부:미용, 투블럭");
  });

  test("자동완성 드롭다운(<ul.tag-autocomplete>)이 입력 래퍼에 배선됐다(S6)", async () => {
    const mountEl = await mountAndSettle();
    const wrap = mountEl.querySelector("[data-ingest-input-wrap]") as HTMLElement;
    expect(wrap).not.toBeNull();
    const listEl = wrap.querySelector("ul.tag-autocomplete");
    expect(listEl).not.toBeNull();
    // 초기엔 숨김(추천 미로드·태그 입력 아님).
    expect((listEl as HTMLElement).hidden).toBe(true);
  });

  test("칸 자동 표시 자리(.ingest-fields-auto)가 미리보기 안에 있다(결정 6 배선)", async () => {
    const mountEl = await mountAndSettle();
    const previewEl = mountEl.querySelector("[data-ingest-preview]") as HTMLElement;
    // 종류 인식 onParsed 콜백이 매 갱신마다 다시 붙이는 자동 칸 컨테이너.
    expect(previewEl.querySelector("[data-ingest-fields-auto]")).not.toBeNull();
  });

  test("전송 성공 후 늘어난 입력 높이가 기본 상태로 돌아간다", async () => {
    let ingested = 0;
    const mountEl = el("div");
    mountIngestForm({
      mountEl,
      apiBase: "",
      escapeHtml,
      onIngested: () => { ingested += 1; },
      el,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const inputEl = mountEl.querySelector("[data-ingest-input]") as HTMLTextAreaElement;
    const sendBtn = mountEl.querySelector("[data-ingest-send]") as HTMLButtonElement;
    Object.defineProperty(inputEl, "scrollHeight", { configurable: true, value: 180 });
    inputEl.value = "긴 메모\n".repeat(12);
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    expect(inputEl.style.height).toBe("180px");

    sendBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inputEl.value).toBe("");
    expect(inputEl.style.height).toBe("");
    expect(ingested).toBe(1);
  });

  test("el 헬퍼 누락 시 식별자와 함께 throw(조용한 no-op 0·No-fallback)", () => {
    expect(() => {
      mountIngestForm({ mountEl: el("div"), apiBase: "", escapeHtml, onIngested: noop });
    }).toThrow(/mountIngestForm: el/);
  });
});
