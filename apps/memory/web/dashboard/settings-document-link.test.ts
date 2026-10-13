import "../../test-setup-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { _resetTokenCacheForTest } from "./api-fetch";
import { renderDocumentProcessingPanel, renderMemoryTab } from "./settings";

const originalFetch = globalThis.fetch;
const targetId = "doc_한글/target";
const target = {
  documentId: targetId, title: "회의록", documentType: "free", chunkCount: 2,
  parse: { status: "text_succeeded", method: "tier1" },
  assetUrl: "/assets/" + "a".repeat(64), originalAssetSha256: "a".repeat(64),
  createdAt: "2026-09-24 12:00:00", updatedAt: "2026-09-24 12:00:00",
  nodeId: 42, extraction: { totalChunks: 2, completedChunks: 1 },
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const preventTestDownloadNavigation = (event: Event) => {
  if ((event.target as HTMLElement)?.hasAttribute("download")) event.preventDefault();
};

beforeEach(() => {
  document.body.replaceChildren();
  document.addEventListener("click", preventTestDownloadNavigation);
  _resetTokenCacheForTest();
  window.sessionStorage.setItem("bara.dashboard.token", "fixture-token");
  window.history.replaceState(null, "", "/web/dashboard/settings.html?documentId=" + encodeURIComponent(targetId) + "#memory");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  document.removeEventListener("click", preventTestDownloadNavigation);
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  _resetTokenCacheForTest();
});

test("deep link fetches a parsed document outside the OCR list and shows pending extraction", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input); urls.push(url);
    if (url === "/dashboard/sse-token") return Response.json({ token: "fixture-token" });
    return Response.json(url.endsWith("/status") ? { ok: true, document: target } : { candidates: [] });
  }) as typeof fetch;
  document.body.append(renderDocumentProcessingPanel());
  await settle();
  expect(urls).toContain(`/api/documents/${encodeURIComponent(targetId)}/status`);
  const row = document.querySelector("[data-document-id]") as HTMLElement;
  expect(row?.dataset.documentId).toBe(targetId);
  expect(row?.getAttribute("aria-current")).toBe("true");
  expect(row?.textContent).toContain("텍스트 추출 완료");
  expect(row?.textContent).toContain("의미 추출 대기");
  expect(row?.querySelector("textarea")).toBeNull();
  expect(row?.querySelector('a[href="/web/graph.html"]')).not.toBeNull();
});

test("a deep link to a record absorbed into another document says it shares that result, without OCR controls", async () => {
  const absorbed = {
    ...target,
    title: "사본.pdf",
    parse: { status: "needs_ocr", method: "tier1" },
    nodeId: 7,
    extraction: undefined,
    absorbedInto: { nodeId: 7, documentId: "doc_first", inTrash: false, notice: "같은 파일이 이미 다른 문서(doc_first, 노드 7)로 저장돼 있어, 이 기록은 그 문서의 결과를 함께 씁니다" },
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/dashboard/sse-token") return Response.json({ token: "fixture-token" });
    return Response.json(url.endsWith("/status") ? { ok: true, document: absorbed } : { candidates: [] });
  }) as typeof fetch;
  document.body.append(renderDocumentProcessingPanel());
  await settle();
  const row = document.querySelector("[data-document-id]") as HTMLElement;
  expect(row?.dataset.documentId).toBe(targetId);
  expect(row?.querySelector(".document-processing-badge")?.textContent).toBe("같은 파일 · 다른 문서와 함께 씀");
  expect(row?.textContent).toContain("doc_first");
  expect(row?.textContent).not.toContain("삭제되었거나");
  expect(row?.querySelector("textarea")).toBeNull();
  expect(row?.querySelector(".document-processing-submit")).toBeNull();
});

test("a deep link to a record wrongly merged by an earlier version asks for a re-upload, without OCR controls", async () => {
  const legacy = {
    ...target,
    title: "same.pdf",
    parse: { status: "needs_ocr", method: "tier1" },
    nodeId: undefined,
    extraction: undefined,
    legacyMerged: { nodeId: 7, documentId: "doc_first", inTrash: false, notice: "예전 버전이 이름만 같은 이 기록을 다른 문서(doc_first, 노드 7)에 잘못 합쳐 두었습니다." },
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/dashboard/sse-token") return Response.json({ token: "fixture-token" });
    return Response.json(url.endsWith("/status") ? { ok: true, document: legacy } : { candidates: [] });
  }) as typeof fetch;
  document.body.append(renderDocumentProcessingPanel());
  await settle();
  const row = document.querySelector("[data-document-id]") as HTMLElement;
  expect(row?.querySelector(".document-processing-badge")?.textContent).toBe("예전 버전에서 잘못 합쳐짐 · 다시 올려 주세요");
  expect(row?.textContent).toContain("잘못 합쳐 두었습니다");
  expect(row?.querySelector("textarea")).toBeNull();
  expect(row?.querySelector('a[href="/web/graph.html"]')).toBeNull();
});

test("a missing or deleted deep link is explicit and can retry after a request failure", async () => {
  let statusCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) === "/dashboard/sse-token") return Response.json({ token: "fixture-token" });
    if (String(input).endsWith("/status")) {
      statusCalls += 1;
      return statusCalls === 1
        ? Response.json({ error: "일시적인 조회 오류" }, { status: 503 })
        : Response.json({ error: "문서 없음" }, { status: 404 });
    }
    return Response.json({ candidates: [] });
  }) as typeof fetch;
  document.body.append(renderDocumentProcessingPanel());
  await settle();
  expect(document.body.textContent).toContain("일시적인 조회 오류");
  const retry = document.querySelector(".document-processing-retry") as HTMLButtonElement;
  expect(retry).not.toBeNull();
  retry.click(); await settle();
  expect(statusCalls).toBe(2);
  expect(document.body.textContent).toContain("삭제되었거나 찾을 수 없습니다");
});

test("the linked document opens the memory documents subsection", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) === "/dashboard/sse-token") return Response.json({ token: "fixture-token" });
    return Response.json(String(input).endsWith("/status") ? { document: target } : { candidates: [] });
  }) as typeof fetch;
  renderMemoryTab(document.body, { schema: { properties: {} }, value: {}, apps: [] });
  expect(document.querySelector('.memory-settings-nav-button[aria-selected="true"]')?.textContent).toBe("문서");
  await settle();
  expect(document.querySelector('[aria-current="true"]')?.textContent).toContain("회의록");
});

test("the original document download uses the authenticated API", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    if (url === "/dashboard/sse-token") return Response.json({ token: "fixture-token" });
    if (url.startsWith("/assets/")) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
      return new Response("# 원본");
    }
    return Response.json(url.endsWith("/status") ? { document: target } : { candidates: [] });
  }) as typeof fetch;
  document.body.append(renderDocumentProcessingPanel());
  await settle();
  (document.querySelector('.document-processing-actions a') as HTMLAnchorElement).click();
  await settle();
  expect(calls).toContain(target.assetUrl);
  expect(document.body.textContent).toContain("원본 다운로드를 시작했습니다");
});
test("expired OCR reservations do not claim the document is processing", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) === "/dashboard/sse-token") return Response.json({ token: "fixture-token" });
    return Response.json(String(input).endsWith("/status") ? { document: { ...target, leaseActive: false,
      parse: { status: "needs_ocr", lease: { workerId: "old-worker", leaseUntil: "2020-01-01 00:00:00" } },
    } } : { candidates: [] });
  }) as typeof fetch;
  document.body.append(renderDocumentProcessingPanel()); await settle();
  expect(document.body.textContent).toContain("처리 예약 만료");
  expect(document.body.textContent).not.toContain("처리 중");
});
test("a failed candidate list cannot hide a successfully loaded target document", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/dashboard/sse-token") return Response.json({ token: "fixture-token" });
    return url.endsWith("/status") ? Response.json({ document: target })
      : Response.json({ error: "문서 목록 일시 오류" }, { status: 503 });
  }) as typeof fetch;
  document.body.append(renderDocumentProcessingPanel()); await settle();
  expect(document.body.textContent).toContain("회의록");
  expect(document.body.textContent).toContain("문서 목록 일시 오류");
});

test.each([
  ["late", "success"], ["late", "error"], ["early", "success"], ["early", "error"],
])("stale OCR refresh (%s/%s) cannot replace the post-apply state or unlock its refresh", async (order, outcome) => {
  const needsOcr = { ...target, parse: { status: "needs_ocr", method: "tier1" } };
  const completed = { ...target, parse: { status: "ocr_succeeded", method: "ocr" } };
  const apply = Promise.withResolvers<Response>();
  const oldList = Promise.withResolvers<Response>();
  const oldStatus = Promise.withResolvers<Response>();
  const newList = Promise.withResolvers<Response>();
  const newStatus = Promise.withResolvers<Response>();
  let listCalls = 0;
  let statusCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/dashboard/sse-token") return Response.json({ token: "fixture-token" });
    if (url.endsWith("/ocr-result")) return apply.promise;
    if (url.endsWith("/status")) {
      statusCalls += 1;
      return statusCalls === 1 ? Response.json({ document: needsOcr })
        : statusCalls === 2 ? oldStatus.promise : newStatus.promise;
    }
    listCalls += 1;
    return listCalls === 1 ? Response.json({ candidates: [needsOcr] })
      : listCalls === 2 ? oldList.promise : newList.promise;
  }) as typeof fetch;
  document.body.append(renderDocumentProcessingPanel());
  await settle();
  (document.querySelector("textarea") as HTMLTextAreaElement).value = "# 적용한 OCR 본문";
  (document.querySelector(".document-processing-item .document-processing-submit") as HTMLButtonElement).click();
  await settle();
  const refresh = document.querySelector(".document-processing-retry") as HTMLButtonElement;
  refresh.click();
  await settle();
  apply.resolve(Response.json({ ok: true }));
  await settle();
  expect(statusCalls).toBe(3);
  const resolveOld = () => {
    oldList.resolve(outcome === "error" ? Response.json({ error: "오래된 조회 실패" }, { status: 503 })
      : Response.json({ candidates: [needsOcr] }));
    oldStatus.resolve(outcome === "error" ? Response.json({ error: "오래된 조회 실패" }, { status: 503 })
      : Response.json({ document: needsOcr }));
  };
  const resolveNew = () => {
    newList.resolve(Response.json({ candidates: [] }));
    newStatus.resolve(Response.json({ document: completed }));
  };
  if (order === "early") {
    resolveOld(); await settle();
    expect(refresh.disabled).toBe(true);
    expect(document.body.textContent).toContain("문서 상태를 불러오는 중");
    expect(document.querySelector("textarea")).toBeNull();
    resolveNew();
  } else {
    resolveNew(); await settle();
    expect(document.body.textContent).toContain("OCR 완료");
    resolveOld();
  }
  await settle();
  expect(document.body.textContent).toContain("OCR 완료");
  expect(document.body.textContent).not.toContain("오래된 조회 실패");
  expect(document.body.textContent).not.toContain("OCR 필요");
  expect(document.querySelector("textarea")).toBeNull();
  expect(refresh.disabled).toBe(false);
});
