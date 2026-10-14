/**
 * Settings 페이지 단위 테스트 (Phase 5.7.1 W5 + extractor-vision-unified-clock-scheduler Task 6).
 *
 * Task 6 재배치 — 자동 처리의 의미 추출 5블록:
 *   (1) 텍스트 모델 → (2) 이미지 모델 → (3) 공통 동작방식 → (4) 텍스트 전용 → (5) 이미지 전용.
 * 캡션 시점(mode)·주기 분(intervalMin)은 의미 추출 공통 설정(llm.extractor 권위).
 * vision 에는 mode 라디오·intervalMin 입력 0 개, backfill = batchSize 한 칸만.
 *
 * 검증 갈래:
 *   1) 공통 동작방식 블록 — 즉시/주기 라디오 + 주기 분 입력 (extractor 권위 id).
 *      mode=주기 시 (3) 주기 분 + (4)/(5) batchSize 펼침, 즉시 시 숨김 (form-state 보존).
 *   2) 텍스트 블록 — 모델 블록(켜기+provider+모델) + 전용 설정(batchSize+minImportance).
 *   3) 이미지 블록 — 모델 블록 + 전용 설정(captionPrompt+forceCall+tokenCap+batchSize).
 *      mode 라디오·intervalMin 0 개.
 *   4) payload — extractor 는 mode·backfill(intervalMin+batchSize+minImportance) /
 *      vision 은 backfill={batchSize} 만 (mode·intervalMin 안 들어감).
 *   5) Ollama 자동 fetch — provider=ollama 진입 시 list-ollama-models 호출.
 */

import "../../test-setup-dom";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { _resetTokenCacheForTest } from "./api-fetch";
import { createSlotCommonControls } from "./settings-llm-controls";
import {
  buildCleanupLinkedPayload,
  createMemorySectionSchema,
  type InitState,
  renderDocumentProcessingPanel,
} from "./settings";
import { MEMORY_SCHEMA } from "../../src/settings/memory-schema";
import {
  renderCommonModeBlock,
  renderExtractorBlocks,
  renderCleanupSection,
  renderVisionBlocks,
} from "./settings-llm-section";
import type {
  CommonModeBlockHandle,
  LlmExtractorValue,
  LlmCleanupValue,
  LlmVisionValue,
  LlmSlotCommonValue,
} from "./settings-llm-types";

// ── fetch mock 헬퍼 ─────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface MockFetchHandle {
  calls: FetchCall[];
  restore: () => void;
}

function installFetchMock(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): MockFetchHandle {
  window.sessionStorage.setItem("bara.dashboard.token", "test-token");
  const calls: FetchCall[] = [];
  const original = (globalThis as { fetch?: typeof fetch }).fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    // apiFetch 내부 토큰 발급 요청 — calls 목록에 추가하지 않고 토큰 응답만 돌려준다.
    if (url === "/dashboard/sse-token") {
      return new Response(JSON.stringify({ token: "test-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    calls.push({ url, init: init as RequestInit });
    return responder(url, init as RequestInit);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      window.sessionStorage.removeItem("bara.dashboard.token");
      if (original) {
        (globalThis as { fetch: typeof fetch }).fetch = original;
      } else {
        delete (globalThis as { fetch?: typeof fetch }).fetch;
      }
    },
  };
}

function ollamaSlotValue(overrides: Partial<LlmSlotCommonValue> = {}): LlmSlotCommonValue {
  return {
    enabled: true,
    provider: "ollama",
    ollamaUrl: "http://127.0.0.1:11434",
    ollamaModel: "exaone3.5:7.8b",
    anthropicApiKey: "",
    anthropicModel: "",
    openaiBaseUrl: "http://127.0.0.1:1234/v1",
    openaiModel: "qwen3:4b-instruct",
    openaiApiKey: "",
    gptApiKey: "",
    gptModel: "",
    geminiApiKey: "",
    geminiModel: "",
    savedKeyFields: [],
    ...overrides,
  };
}

function makeExtractorValue(
  overrides: Partial<LlmExtractorValue> = {},
): LlmExtractorValue {
  return {
    ...ollamaSlotValue(),
    mode: "backfill",
    backfill: {
      intervalMin: 30,
      batchSize: 10,
      minImportance: 0,
      maxAttempts: 5,
      retryDelayMin: 30,
      retryMaxDelayMin: 1440,
    },
    ...overrides,
  };
}

function makeCleanupValue(
  overrides: Partial<LlmCleanupValue> = {},
): LlmCleanupValue {
  return {
    ...ollamaSlotValue({ ollamaModel: "exaone3.5:32b" }),
    intervalDays: 7,
    ...overrides,
  };
}

function makeVisionValue(
  overrides: Partial<LlmVisionValue> = {},
): LlmVisionValue {
  return {
    enabled: false,
    provider: "anthropic",
    ollamaUrl: "http://127.0.0.1:11434",
    ollamaModel: "qwen3-vl:4b",
    anthropicApiKey: "",
    anthropicModel: "claude-haiku-4-5",
    openaiBaseUrl: "http://127.0.0.1:1234/v1",
    openaiModel: "qwen3-vl:4b-instruct",
    openaiApiKey: "",
    gptApiKey: "",
    gptModel: "",
    geminiApiKey: "",
    geminiModel: "",
    savedKeyFields: [],
    forceCall: false,
    tokenCap: 2000,
    captionPrompt: "",
    // Task 4·6 — vision.backfill 은 batchSize 한 칸. mode·intervalMin 은 extractor 권위.
    backfill: {
      batchSize: 10,
      maxAttempts: 5,
      retryDelayMin: 30,
      retryMaxDelayMin: 1440,
    },
    ...overrides,
  };
}


/**
 * 공통 동작방식 핸들 1개 + extractor / vision 블록 한 묶음 산출 헬퍼.
 * 두 블록이 같은 commonMode 라디오를 구독하므로 (registerBackfillTarget) 한 셋업으로
 * 합산 가시성·payload 정합을 검증한다.
 */
function setupBlocks(opts: {
  extractor?: Partial<LlmExtractorValue>;
  extractorOriginal?: Partial<LlmExtractorValue>;
  vision?: Partial<LlmVisionValue>;
  visionOriginal?: Partial<LlmVisionValue>;
}): {
  commonMode: CommonModeBlockHandle;
  extractor: ReturnType<typeof renderExtractorBlocks>;
  vision: ReturnType<typeof renderVisionBlocks>;
} {
  const extractorCurrent = makeExtractorValue(opts.extractor);
  const extractorOriginal = makeExtractorValue(
    opts.extractorOriginal ?? opts.extractor,
  );
  const visionCurrent = makeVisionValue(opts.vision);
  const visionOriginal = makeVisionValue(opts.visionOriginal ?? opts.vision);

  const commonMode = renderCommonModeBlock(extractorCurrent, extractorOriginal);
  const extractor = renderExtractorBlocks(
    extractorCurrent,
    extractorOriginal,
    commonMode,
  );
  const vision = renderVisionBlocks(visionCurrent, visionOriginal, commonMode);
  return { commonMode, extractor, vision };
}

/**
 * microtask + task 큐를 모두 드레인한다.
 * autoFetchOllamaModels 는 void fire-and-forget 이라 Promise.resolve() 반복만으로는
 * apiFetch 내부 체인(토큰발급 2단계 + 실제API 1단계) 완료를 보장할 수 없다.
 * setTimeout(0) 이 task 큐 경계를 넘어 microtask 를 완전히 소진시킨다.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}



// 문서 OCR 설정 패널 시험은 settings-document-ocr-panel.test.ts 로 옮겼다(진짜 설정 라우터·메모리 API + 대역 서버,
// 2026-10-11 document-ocr spec T10). 옛 "OpenAI 빈 주소 자동 채움" 시험은 그 동작을 지워 함께 없앴다.

describe("renderDocumentProcessingPanel — OCR 필요 문서 최소 UI", () => {
  beforeEach(() => {
    _resetTokenCacheForTest();
    document.body.textContent = "";
  });

  afterEach(() => {
    _resetTokenCacheForTest();
    document.body.textContent = "";
  });

  test("목록 응답에 candidates 배열이 없으면 빈 목록이 아니라 이름 있는 오류를 보인다", async () => {
    const fetchMock = installFetchMock(() =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    try {
      document.body.appendChild(renderDocumentProcessingPanel());
      await flushMicrotasks();
      expect(document.body.textContent).toContain("문서 목록 응답에 candidates 배열이 없습니다");
      expect(document.body.textContent).not.toContain("OCR 처리가 필요한 문서 없음");
    } finally {
      fetchMock.restore();
    }
  });

  test("후보 0건이면 빈 상태를 표시한다", async () => {
    const fetchMock = installFetchMock((url) => {
      expect(url).toBe("/api/documents/ocr-candidates");
      return new Response(JSON.stringify({ ok: true, candidates: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      document.body.appendChild(renderDocumentProcessingPanel());
      await flushMicrotasks();
      expect(document.body.textContent).toContain("OCR 처리가 필요한 문서 없음");
    } finally {
      fetchMock.restore();
    }
  });

  test("후보 문서 제목, 상태 배지, 원본 링크를 표시한다", async () => {
    const fetchMock = installFetchMock(() =>
      new Response(
        JSON.stringify({
          ok: true,
          candidates: [
            {
              documentId: "doc_scan",
              title: "scan.pdf",
              documentType: "free",
              chunkCount: 0,
              parse: { status: "needs_ocr", method: "tier1" },
              originalAssetSha256: "a".repeat(64),
              assetUrl: `/assets/${"a".repeat(64)}`,
              createdAt: "2026-07-01 10:00:00",
              updatedAt: "2026-07-01 10:00:00",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      document.body.appendChild(renderDocumentProcessingPanel());
      await flushMicrotasks();
      expect(document.body.textContent).toContain("scan.pdf");
      expect(document.body.textContent).toContain("OCR 필요");
      const link = document.querySelector(".document-processing-actions a") as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe(`/assets/${"a".repeat(64)}`);
    } finally {
      fetchMock.restore();
    }
  });

  test("lease 가 있으면 처리 중 상태를 표시한다", async () => {
    const fetchMock = installFetchMock(() =>
      new Response(
        JSON.stringify({
          ok: true,
          candidates: [
            {
              documentId: "doc_scan",
              title: "scan.pdf",
              documentType: "free",
              chunkCount: 0,
              parse: {
                status: "needs_ocr",
                method: "tier1",
                lease: {
                  workerId: "worker-a",
                  claimedAt: "2026-07-01 10:00:00",
                  leaseUntil: "2026-07-01 10:30:00",
                },
              },
              originalAssetSha256: "a".repeat(64),
              assetUrl: `/assets/${"a".repeat(64)}`,
              assetMimeType: "application/pdf",
              originalName: "scan.pdf",
              createdAt: "2026-07-01 10:00:00",
              updatedAt: "2026-07-01 10:00:00",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      document.body.appendChild(renderDocumentProcessingPanel());
      await flushMicrotasks();
      expect(document.body.textContent).toContain("처리 중");
      expect(document.body.textContent).toContain("worker-a");
      expect(document.body.textContent).toContain("2026-07-01 10:30:00까지 처리 중");
    } finally {
      fetchMock.restore();
    }
  });

  test("OCR 실패 후보는 실패 상태와 에러 메시지를 표시한다", async () => {
    const fetchMock = installFetchMock(() =>
      new Response(
        JSON.stringify({
          ok: true,
          candidates: [
            {
              documentId: "doc_failed",
              title: "failed.pdf",
              documentType: "free",
              chunkCount: 0,
              parse: {
                status: "ocr_failed",
                method: "ocr",
                errorMessage: "OCR command failed",
              },
              originalAssetSha256: "f".repeat(64),
              assetUrl: `/assets/${"f".repeat(64)}`,
              createdAt: "2026-07-01 10:00:00",
              updatedAt: "2026-07-01 10:05:00",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      document.body.appendChild(renderDocumentProcessingPanel());
      await flushMicrotasks();
      expect(document.body.textContent).toContain("failed.pdf");
      expect(document.body.textContent).toContain("OCR 실패");
      expect(document.body.textContent).toContain("OCR command failed");
    } finally {
      fetchMock.restore();
    }
  });

  test("암호 필요 문서는 Markdown 붙이기를 비활성화하고 재업로드 안내를 표시한다", async () => {
    const fetchMock = installFetchMock(() =>
      new Response(
        JSON.stringify({
          ok: true,
          candidates: [
            {
              documentId: "doc_locked",
              title: "locked.pdf",
              documentType: "free",
              chunkCount: 0,
              parse: {
                status: "password_required",
                method: "tier1",
              },
              originalAssetSha256: "d".repeat(64),
              assetUrl: `/assets/${"d".repeat(64)}`,
              createdAt: "2026-07-01 10:00:00",
              updatedAt: "2026-07-01 10:05:00",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      document.body.appendChild(renderDocumentProcessingPanel());
      await flushMicrotasks();
      expect(document.body.textContent).toContain("암호 필요");
      expect(document.body.textContent).toContain("암호가 걸린 문서는 암호를 해제한 파일로 다시 업로드");
      const textarea = document.querySelector(".document-processing-textarea") as HTMLTextAreaElement;
      const button = document.querySelector(".document-processing-submit") as HTMLButtonElement;
      expect(textarea.disabled).toBe(true);
      expect(button.disabled).toBe(true);
    } finally {
      fetchMock.restore();
    }
  });

  test("OCR 결과 붙이기 성공 후 목록을 다시 불러온다", async () => {
    let listCalls = 0;
    const fetchMock = installFetchMock((url, init) => {
      if (url === "/api/documents/ocr-candidates") {
        listCalls += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            candidates:
              listCalls === 1
                ? [
                    {
                      documentId: "doc_scan",
                      title: "scan.pdf",
                      documentType: "free",
                      chunkCount: 0,
                      parse: { status: "needs_ocr", method: "tier1" },
                      originalAssetSha256: "b".repeat(64),
                      assetUrl: `/assets/${"b".repeat(64)}`,
                      createdAt: "2026-07-01 10:00:00",
                      updatedAt: "2026-07-01 10:00:00",
                    },
                  ]
                : [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(url).toBe("/api/documents/doc_scan/ocr-result");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      document.body.appendChild(renderDocumentProcessingPanel());
      await flushMicrotasks();
      const textarea = document.querySelector(".document-processing-textarea") as HTMLTextAreaElement;
      textarea.value = "# OCR\n\n본문";
      const button = document.querySelector(".document-processing-submit") as HTMLButtonElement;
      button.click();
      await flushMicrotasks();
      await flushMicrotasks();
      expect(listCalls).toBe(2);
      expect(document.body.textContent).toContain("OCR 처리가 필요한 문서 없음");
    } finally {
      fetchMock.restore();
    }
  });

  test("OCR 결과 붙이기 실패 메시지를 표시한다", async () => {
    const fetchMock = installFetchMock((url) => {
      if (url === "/api/documents/ocr-candidates") {
        return new Response(
          JSON.stringify({
            ok: true,
            candidates: [
              {
                documentId: "doc_scan",
                title: "scan.pdf",
                documentType: "free",
                chunkCount: 0,
                parse: { status: "needs_ocr", method: "tier1" },
                originalAssetSha256: "c".repeat(64),
                assetUrl: `/assets/${"c".repeat(64)}`,
                createdAt: "2026-07-01 10:00:00",
                updatedAt: "2026-07-01 10:00:00",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "재적용 불가" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      document.body.appendChild(renderDocumentProcessingPanel());
      await flushMicrotasks();
      const textarea = document.querySelector(".document-processing-textarea") as HTMLTextAreaElement;
      textarea.value = "# OCR\n\n본문";
      const button = document.querySelector(".document-processing-submit") as HTMLButtonElement;
      button.click();
      await flushMicrotasks();
      expect(document.body.textContent).toContain("재적용 불가");
    } finally {
      fetchMock.restore();
    }
  });
});

// 어댑터 승인 큐 패널(renderAdapterTokenManagementPanel)의 단위 테스트는
// WP-B1-14 로 settings-adapter-tokens.test.ts 로 이동했다. 그 테스트는 실제
// memory API(Bun.serve, 실 SQLite·SseTokenStore)를 띄우고 happy-dom 주소를
// 맞춰 실 HTTP 로 승인·권한 변경을 검증한다 — 이 파일의 fetch 대체 방식
// (installFetchMock) 은 새 계약(requestedScope·existingAdapter·scope·
// legacyScope)의 권한 로직을 검증하기에 충분하지 않아 이식하지 않는다.

// ── 공통 동작방식 (3) 블록 — 즉시/주기 라디오 + 주기 분 (extractor 권위) ──────

describe("renderCommonModeBlock — 즉시/주기 라디오 + 주기 분 (Task 6)", () => {
  test("주기 라디오 + 주기 분 입력 mount — extractor 권위 id 유지", () => {
    const value = makeExtractorValue({ mode: "backfill" });
    const handle = renderCommonModeBlock(value, value);

    const immediateRadio = handle.element.querySelector(
      "#llm-extractor-mode-immediate",
    ) as HTMLInputElement;
    const backfillRadio = handle.element.querySelector(
      "#llm-extractor-mode-backfill",
    ) as HTMLInputElement;
    const intervalInput = handle.element.querySelector(
      "#llm-extractor-backfill-intervalMin",
    ) as HTMLInputElement;

    expect(immediateRadio).toBeTruthy();
    expect(backfillRadio).toBeTruthy();
    expect(backfillRadio.checked).toBe(true);
    expect(intervalInput).toBeTruthy();
    expect(intervalInput.value).toBe("30");
  });

  test("mode=backfill 시 주기 분 펼침, mode=immediate 시 숨김 (form-state 보존)", () => {
    const value = makeExtractorValue({ mode: "backfill" });
    const handle = renderCommonModeBlock(value, value);

    const intervalBox = handle.element.querySelector(
      '[data-section="common-mode-interval"]',
    ) as HTMLElement;
    const intervalInput = handle.element.querySelector(
      "#llm-extractor-backfill-intervalMin",
    ) as HTMLInputElement;
    const immediateRadio = handle.element.querySelector(
      "#llm-extractor-mode-immediate",
    ) as HTMLInputElement;
    const backfillRadio = handle.element.querySelector(
      "#llm-extractor-mode-backfill",
    ) as HTMLInputElement;

    expect(intervalBox.style.display).toBe("");
    intervalInput.value = "45";

    immediateRadio.checked = true;
    immediateRadio.dispatchEvent(new Event("change"));
    expect(intervalBox.style.display).toBe("none");
    // form-state 보존 — display:none 후에도 입력값 살아있음.
    expect(intervalInput.value).toBe("45");

    backfillRadio.checked = true;
    backfillRadio.dispatchEvent(new Event("change"));
    expect(intervalBox.style.display).toBe("");
    expect(intervalInput.value).toBe("45");
  });

  test("getPayload — mode=backfill 시 mode + intervalMin / mode=immediate 시 intervalMin 0", () => {
    const backfillHandle = renderCommonModeBlock(
      makeExtractorValue({ mode: "backfill" }),
      makeExtractorValue({ mode: "backfill" }),
    );
    const bf = backfillHandle.getPayload();
    expect(bf.mode).toBe("backfill");
    expect(bf.intervalMin).toBe(30);

    const immediateHandle = renderCommonModeBlock(
      makeExtractorValue({ mode: "immediate" }),
      makeExtractorValue({ mode: "immediate" }),
    );
    const im = immediateHandle.getPayload();
    expect(im.mode).toBe("immediate");
    expect(im.intervalMin).toBeUndefined();
  });

  test("isChanged — mode 또는 intervalMin 변경 감지", () => {
    const value = makeExtractorValue({ mode: "backfill" });
    const handle = renderCommonModeBlock(value, value);
    expect(handle.isChanged()).toBe(false);

    const intervalInput = handle.element.querySelector(
      "#llm-extractor-backfill-intervalMin",
    ) as HTMLInputElement;
    intervalInput.value = "60";
    expect(handle.isChanged()).toBe(true);
  });
});

// ── 텍스트 블록 (1)/(4) — 모델 + 전용 설정 ──────────────────────────────────

describe("renderExtractorBlocks — 모델 블록 + 텍스트 전용 설정 (Task 6)", () => {
  let fetchMock: MockFetchHandle;

  beforeEach(() => {
    _resetTokenCacheForTest();
    fetchMock = installFetchMock(
      () =>
        new Response(JSON.stringify([{ id: "exaone3.5:7.8b", name: "exaone3.5:7.8b" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  });

  afterEach(() => {
    fetchMock.restore();
    _resetTokenCacheForTest();
  });

  test("(1) 모델 블록 — 켜기 체크박스 + 처리 방법 + 선택 AI + 모델", () => {
    const { extractor } = setupBlocks({});
    const enabledInput = extractor.modelBlock.querySelector(
      "#llm-extractor-enabled",
    ) as HTMLInputElement;
    const methodSelect = extractor.modelBlock.querySelector(
      "#llm-extractor-provider-mode",
    ) as HTMLSelectElement;
    const providerSelect = extractor.modelBlock.querySelector(
      "#llm-extractor-provider",
    ) as HTMLSelectElement;
    expect(enabledInput).toBeTruthy();
    expect(enabledInput.type).toBe("checkbox");
    expect(methodSelect).toBeTruthy();
    expect(Array.from(methodSelect.options).map((o) => o.textContent)).toEqual([
      "서버에 설치된 AI로 처리",
      "AI API 사용",
    ]);
    expect(providerSelect).toBeTruthy();
    expect(Array.from(providerSelect.options).map((o) => o.value)).toEqual([
      "ollama",
      "openai_compatible",
    ]);
    expect(providerSelect.options[1]?.disabled).toBe(false);

    methodSelect.value = "api";
    methodSelect.dispatchEvent(new Event("change"));
    // 2026-10-11 — API 공급자 셋 다 활성(준비 중 표시 없음). 순서는 공급자 표 순서.
    expect(Array.from(providerSelect.options).map((o) => o.value)).toEqual([
      "anthropic",
      "openai",
      "google",
    ]);
    expect(Array.from(providerSelect.options).map((o) => o.textContent)).toEqual([
      "Anthropic (Claude)",
      "OpenAI (GPT)",
      "Google (Gemini)",
    ]);
    expect(Array.from(providerSelect.options).some((o) => o.disabled)).toBe(false);
    expect(providerSelect.value).toBe("anthropic");
    // mode 라디오·intervalMin 은 모델 블록에 없다 (공통 동작방식으로 이동).
    expect(extractor.modelBlock.querySelector("#llm-extractor-mode-backfill")).toBeNull();
    expect(
      extractor.modelBlock.querySelector("#llm-extractor-backfill-intervalMin"),
    ).toBeNull();
  });

  test("(4) 텍스트 전용 설정 — batchSize + minImportance 칸 (intervalMin 없음)", () => {
    const { extractor } = setupBlocks({});
    const batchInput = extractor.detailBlock.querySelector(
      "#llm-extractor-backfill-batchSize",
    ) as HTMLInputElement;
    const minImpInput = extractor.detailBlock.querySelector(
      "#llm-extractor-backfill-minImportance",
    ) as HTMLInputElement;
    expect(batchInput).toBeTruthy();
    expect(batchInput.value).toBe("10");
    expect(minImpInput).toBeTruthy();
    expect(minImpInput.value).toBe("0");
    // intervalMin 은 (3) 공통 동작방식으로 이동 — detailBlock 에 없다.
    expect(
      extractor.detailBlock.querySelector("#llm-extractor-backfill-intervalMin"),
    ).toBeNull();
  });

  test("공통 라디오가 (4) batchSize 가시성 제어 — immediate 시 숨김, backfill 시 펼침", () => {
    const { commonMode, extractor } = setupBlocks({ extractor: { mode: "backfill" } });
    const detailBlock = extractor.detailBlock;
    const backfillBox = extractor.detailBlock.querySelector(
      '[data-section="extractor-backfill"]',
    ) as HTMLElement;
    expect(detailBlock.style.display).toBe("");
    expect(backfillBox.style.display).toBe("");

    const immediateRadio = commonMode.element.querySelector(
      "#llm-extractor-mode-immediate",
    ) as HTMLInputElement;
    immediateRadio.checked = true;
    immediateRadio.dispatchEvent(new Event("change"));
    expect(detailBlock.style.display).toBe("none");
  });

  test("getPayload — mode·intervalMin(공통 머지) + backfill(intervalMin+batchSize+minImportance)", () => {
    const { extractor } = setupBlocks({ extractor: { mode: "backfill" } });
    const payload = extractor.getPayload();
    expect(payload.mode).toBe("backfill");
    expect(payload.backfill).toBeDefined();
    const backfill = payload.backfill as Record<string, unknown>;
    expect(backfill.intervalMin).toBe(30);
    expect(backfill.batchSize).toBe(10);
    expect(backfill.minImportance).toBe(0);
  });

  test("getPayload — mode=immediate 시 backfill 포함 0", () => {
    const { extractor } = setupBlocks({
      extractor: { mode: "immediate" },
      extractorOriginal: { mode: "immediate" },
    });
    const payload = extractor.getPayload();
    expect(payload.mode).toBe("immediate");
    expect(payload.backfill).toBeUndefined();
  });

  test("isChanged — batchSize 변경 감지", () => {
    const { extractor } = setupBlocks({});
    expect(extractor.isChanged()).toBe(false);
    const batchInput = extractor.detailBlock.querySelector(
      "#llm-extractor-backfill-batchSize",
    ) as HTMLInputElement;
    batchInput.value = "25";
    expect(extractor.isChanged()).toBe(true);
  });

  test("isChanged — minImportance(float) 변경 감지", () => {
    const { extractor } = setupBlocks({});
    expect(extractor.isChanged()).toBe(false);
    const minImpInput = extractor.detailBlock.querySelector(
      "#llm-extractor-backfill-minImportance",
    ) as HTMLInputElement;
    minImpInput.value = "0.5";
    expect(extractor.isChanged()).toBe(true);
  });

  test("isChanged — 공통 동작방식 mode 변경도 extractor 변경으로 합류 (extractor 권위)", () => {
    const { commonMode, extractor } = setupBlocks({ extractor: { mode: "backfill" } });
    expect(extractor.isChanged()).toBe(false);
    const immediateRadio = commonMode.element.querySelector(
      "#llm-extractor-mode-immediate",
    ) as HTMLInputElement;
    immediateRadio.checked = true;
    immediateRadio.dispatchEvent(new Event("change"));
    expect(extractor.isChanged()).toBe(true);
  });
});

// ── createSlotCommonControls — Ollama 자동 fetch + 갱신 버튼 폐기 ────────────

describe("createSlotCommonControls — Ollama 자동 fetch + 갱신 버튼 폐기 (Phase 5.7.1 W5)", () => {
  beforeEach(() => { _resetTokenCacheForTest(); });
  afterEach(() => { _resetTokenCacheForTest(); });

  test("settings 기본 — Ollama 주소 입력은 접힌 고급 영역 안에 둔다", () => {
    const fetchMock = installFetchMock(() =>
      new Response("[]", { status: 200 }),
    );

    try {
      const slotValue = ollamaSlotValue({ provider: "anthropic" });
      const ctrl = createSlotCommonControls(
        "extractor",
        "글에서 의미 추출하기",
        "본 설명",
        slotValue,
        slotValue,
      );

      const details = ctrl.section.querySelector(
        ".llm-ollama-advanced",
      ) as HTMLDetailsElement;
      expect(details).toBeTruthy();
      expect(details.open).toBe(false);
      expect(details.textContent ?? "").toContain("외부 Ollama 연결");
      const urlInput = ctrl.section.querySelector(
        "#llm-extractor-ollama-url",
      ) as HTMLInputElement;
      expect(urlInput).toBeTruthy();
      expect(details.contains(urlInput)).toBe(true);
      expect(urlInput.value).toBe("http://127.0.0.1:11434");
    } finally {
      fetchMock.restore();
    }
  });

  test("provider=ollama 슬롯 — 페이지 진입 시 자동 fetch + 받은 목록 채움", async () => {
    const fetchMock = installFetchMock((url) => {
      if (url.includes("/actions/list-ollama-models")) {
        return new Response(
          JSON.stringify([
            { id: "exaone3.5:7.8b", name: "exaone3.5:7.8b" },
            { id: "exaone3.5:32b", name: "exaone3.5:32b" },
            { id: "qwen3:8b", name: "qwen3:8b" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not mocked", { status: 404 });
    });

    try {
      const slotValue = ollamaSlotValue();
      const ctrl = createSlotCommonControls(
        "extractor",
        "글에서 의미 추출하기",
        "본 설명",
        slotValue,
        slotValue,
      );

      await flushMicrotasks();

      const ollamaCalls = fetchMock.calls.filter((c) =>
        c.url.includes("/actions/list-ollama-models"),
      );
      expect(ollamaCalls.length).toBeGreaterThanOrEqual(1);
      expect(ollamaCalls[0]?.init?.method).toBe("POST");

      // M15 LLM 슬롯 단일 정본화 — settings 는 dropdown 모드라 ollamaModelField 가
      // HTMLSelectElement. 두 모드 공통 접근자 ollamaModelField 로 option 채움을 검증한다.
      const modelField = ctrl.ollamaModelField as HTMLSelectElement;
      const options = modelField.querySelectorAll("option");
      expect(options.length).toBe(3);
      const values = Array.from(options).map((o) => (o as HTMLOptionElement).value);
      expect(values).toContain("exaone3.5:7.8b");
      expect(values).toContain("exaone3.5:32b");
      expect(values).toContain("qwen3:8b");

      expect(modelField.value).toBe("exaone3.5:7.8b");
    } finally {
      fetchMock.restore();
    }
  });

  test("provider=anthropic 슬롯 — 자동 fetch 호출 0 (옛 능동 모드 자리 정리 정합)", async () => {
    const fetchMock = installFetchMock(() =>
      new Response("[]", { status: 200 }),
    );

    try {
      const slotValue = ollamaSlotValue({
        provider: "anthropic",
        anthropicApiKey: "sk-ant-xyz",
        anthropicModel: "claude-haiku-4-5",
      });
      createSlotCommonControls("cleanup", "데이터 정리 AI", "본 설명", slotValue, slotValue);

      await flushMicrotasks();

      const ollamaCalls = fetchMock.calls.filter((c) =>
        c.url.includes("/actions/list-ollama-models"),
      );
      expect(ollamaCalls.length).toBe(0);
    } finally {
      fetchMock.restore();
    }
  });

  test("'모델 목록 갱신' 버튼 노출 0 — 옛 갱신 통로 폐기", () => {
    const fetchMock = installFetchMock(() =>
      new Response("[]", { status: 200 }),
    );

    try {
      const slotValue = ollamaSlotValue();
      const ctrl = createSlotCommonControls(
        "extractor",
        "글에서 의미 추출하기",
        "본 설명",
        slotValue,
        slotValue,
      );

      const refreshBtn = ctrl.section.querySelector(".llm-ollama-refresh");
      expect(refreshBtn).toBeNull();

      const buttons = ctrl.section.querySelectorAll("button");
      const refreshLike = Array.from(buttons).filter((b) =>
        (b.textContent ?? "").includes("갱신"),
      );
      expect(refreshLike.length).toBe(0);
    } finally {
      fetchMock.restore();
    }
  });

  test("Ollama 미가동 (fetch 실패) — 옛 디스크 값 fallback + toast 출력", async () => {
    const fetchMock = installFetchMock(
      () => new Response("Ollama down", { status: 500 }),
    );

    try {
      const slotValue = ollamaSlotValue({ ollamaModel: "exaone3.5:7.8b" });
      const ctrl = createSlotCommonControls(
        "extractor",
        "글에서 의미 추출하기",
        "본 설명",
        slotValue,
        slotValue,
      );

      await flushMicrotasks();
      await flushMicrotasks();

      // M15 — ollamaModelField (dropdown 모드 = HTMLSelectElement) 로 fallback option 검증.
      const modelField = ctrl.ollamaModelField as HTMLSelectElement;
      const options = modelField.querySelectorAll("option");
      expect(options.length).toBe(1);
      expect((options[0] as HTMLOptionElement).value).toBe("exaone3.5:7.8b");

      const toastHost = document.getElementById("form-toast-host");
      expect(toastHost).toBeTruthy();
      const toasts = toastHost?.querySelectorAll(".form-toast");
      expect((toasts?.length ?? 0)).toBeGreaterThanOrEqual(1);
      const errorToasts = toastHost?.querySelectorAll(".form-toast-error");
      expect((errorToasts?.length ?? 0)).toBeGreaterThanOrEqual(1);
    } finally {
      fetchMock.restore();
    }
  });
});

// ── 설정 메모리 세부 메뉴 schema + 데이터 정리 연동 ────────────────────────

describe("settings memory sections — 사용자용 schema 분리", () => {
  const sampleSchema = {
    type: "object",
    title: "메모리 코어 설정",
    properties: {
      db: {
        type: "object",
        title: "DB",
        properties: {
          path: { type: "string", title: "DB 파일 경로", default: "data/bara.sqlite" },
          port: { type: "integer", title: "HTTP 포트", default: 3001 },
          embeddingModel: {
            type: "string",
            title: "임베딩 모델",
            enum: ["bge-m3"],
            default: "bge-m3",
          },
        },
        required: ["path"],
      },
      ui: {
        type: "object",
        title: "화면",
        properties: {
          startPage: {
            type: "string",
            title: "첫 화면",
            enum: ["dashboard", "graph"],
            default: "graph",
          },
        },
        required: ["startPage"],
      },
    },
    required: ["db", "ui"],
  };

  test("기본 설정에는 첫 화면 + DB 경로만 노출하고 의미 모델과 포트는 숨긴다", () => {
    const schema = createMemorySectionSchema(sampleSchema, "basic");
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["db", "ui"]);
    const db = (schema.properties?.db as Record<string, unknown>) ?? {};
    const props = (db.properties as Record<string, unknown>) ?? {};
    expect(Object.keys(props).sort()).toEqual(["path"]);
    expect(props.port).toBeUndefined();
    expect(props.embeddingModel).toBeUndefined();

    const path = props.path as Record<string, unknown>;
    expect(path.title).toBe("메모리 파일 위치");
  });

  test("고급 설정에는 사용자가 직접 골라도 되는 운영값만 남긴다", () => {
    const schema = createMemorySectionSchema(
      MEMORY_SCHEMA as unknown as Parameters<typeof createMemorySectionSchema>[0],
      "advanced",
    );
    const top = schema.properties ?? {};
    expect(Object.keys(top).sort()).toEqual([
      "assets",
      "autoCleanup",
      "db",
      "images",
      "metadataInfer",
      "reranker",
      "trashManagement",
      "writeGuard",
    ]);
    expect(top.chunking).toBeUndefined();
    expect(top.search).toBeUndefined();
    expect(top.valueDecay).toBeUndefined();
    expect(top.security).toBeUndefined();

    const dbProps = ((top.db as Record<string, unknown>).properties ??
      {}) as Record<string, unknown>;
    expect(Object.keys(dbProps).sort()).toEqual(["host", "port"]);

    const rerankerProps = ((top.reranker as Record<string, unknown>).properties ??
      {}) as Record<string, unknown>;
    expect(Object.keys(rerankerProps)).toEqual(["enabled"]);

    const imagesProps = ((top.images as Record<string, unknown>).properties ??
      {}) as Record<string, unknown>;
    expect(Object.keys(imagesProps).sort()).toEqual([
      "animatedPassthroughMaxMb",
      "autoConceptLink",
      "passthroughMaxMb",
      "preserveMode",
    ]);
    const autoConceptProps = (
      (imagesProps.autoConceptLink as Record<string, unknown>).properties ?? {}
    ) as Record<string, unknown>;
    expect(Object.keys(autoConceptProps)).toEqual(["enabled"]);
  });

  test("구현 제작 설정에는 검색 측정값과 내부 처리 기준을 모은다", () => {
    const schema = createMemorySectionSchema(
      MEMORY_SCHEMA as unknown as Parameters<typeof createMemorySectionSchema>[0],
      "implementation",
    );
    const top = schema.properties ?? {};
    expect(top.search).toBeTruthy();
    expect(top.valueDecay).toBeTruthy();
    expect(top.security).toBeTruthy();

    const rerankerProps = ((top.reranker as Record<string, unknown>).properties ??
      {}) as Record<string, unknown>;
    expect(Object.keys(rerankerProps).sort()).toEqual([
      "host",
      "maxPairTokens",
      "model",
      "topK_input",
      "topK_output",
    ]);
    expect(rerankerProps.enabled).toBeUndefined();

    const cleanupDeepPass = top.cleanupDeepPass as Record<string, unknown>;
    const cleanupProps = (cleanupDeepPass.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(cleanupProps)).toEqual(["summary", "entityRegister"]);
    // 하위 묶음이 둘(요약, 항목·일정 등록)이면 겹껍질 제거(inline)를 하지 않고 묶음 제목을 보인다.
    expect((cleanupDeepPass["x-ui"] as Record<string, unknown> | undefined)?.widget).not.toBe("inline-object");
    const entityRegisterProps = ((cleanupProps.entityRegister as Record<string, unknown>).properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(entityRegisterProps)).toEqual(["batchSize"]);

    const chunkingProps = ((top.chunking as Record<string, unknown>).properties ??
      {}) as Record<string, unknown>;
    expect(Object.keys(chunkingProps).sort()).toEqual([
      "maxContextTokens",
      "minChunkTokens",
      "tokenCap",
    ]);
    expect(chunkingProps.strategy).toBeUndefined();
  });

  test("데이터 정리 AI 토글 하나로 요약 + 추출 규칙 개선 + 항목·일정 자동 등록 단계를 같이 연동한다", () => {
    expect(buildCleanupLinkedPayload(true, true)).toEqual({
      cleanupDeepPass: {
        regexStrengthen: { enabled: true },
        summary: { enabled: true },
        entityRegister: { enabled: true, autoApply: true },
      },
    });
    expect(buildCleanupLinkedPayload(false, false)).toEqual({
      cleanupDeepPass: {
        regexStrengthen: { enabled: false },
        summary: { enabled: false },
        entityRegister: { enabled: false, autoApply: false },
      },
    });
  });
});

// ── 이미지 블록 (2)/(5) — 모델 + 전용 설정 (mode·intervalMin 0개) ────────────

describe("renderVisionBlocks — 모델 블록 + 이미지 전용 설정 (Task 6)", () => {
  test("(2) 모델 블록 — 쉬운 이름 + 켜기 체크박스 + 처리 방법 + 선택 AI + 모델", () => {
    const { vision } = setupBlocks({ vision: { enabled: true } });

    const enabledInput = vision.modelBlock.querySelector(
      "#llm-vision-enabled",
    ) as HTMLInputElement;
    expect(enabledInput).toBeTruthy();
    expect(enabledInput.type).toBe("checkbox");

    const providerSelect = vision.modelBlock.querySelector(
      "#llm-vision-provider",
    ) as HTMLSelectElement;
    expect(providerSelect).toBeTruthy();
    const methodSelect = vision.modelBlock.querySelector(
      "#llm-vision-provider-mode",
    ) as HTMLSelectElement;
    expect(methodSelect).toBeTruthy();
    expect(methodSelect.value).toBe("api");
    // 2026-10-11 — API 공급자 셋 다 활성(준비 중 표시 없음). 순서는 공급자 표 순서.
    expect(Array.from(providerSelect.options).map((o) => o.value)).toEqual([
      "anthropic",
      "openai",
      "google",
    ]);
    expect(Array.from(providerSelect.options).map((o) => o.textContent)).toEqual([
      "Anthropic (Claude)",
      "OpenAI (GPT)",
      "Google (Gemini)",
    ]);
    expect(Array.from(providerSelect.options).some((o) => o.disabled)).toBe(false);
    expect(providerSelect.value).toBe("anthropic");

    methodSelect.value = "server";
    methodSelect.dispatchEvent(new Event("change"));
    expect(Array.from(providerSelect.options).map((o) => o.value)).toEqual([
      "ollama",
      "openai_compatible",
    ]);
    expect(providerSelect.options[1]?.disabled).toBe(false);
    expect(providerSelect.value).toBe("ollama");

    const blockText = vision.modelBlock.textContent ?? "";
    expect(blockText).toContain("이미지 설명 만들기");
    expect(blockText).toContain("서버에 설치된 AI로 처리");
    expect(blockText).toContain("AI API 사용");
    expect(blockText).toContain("켜기");
    expect(vision.modelBlock.querySelector(".llm-section-desc")).toBeNull();
  });

  test("(5) 이미지 전용 설정 — 고급 프롬프트/강제 호출은 숨기고 tokenCap + batchSize 만 노출", () => {
    const { vision } = setupBlocks({ vision: { enabled: true } });

    expect(vision.detailBlock.querySelector("#llm-vision-captionPrompt")).toBeNull();
    expect(vision.detailBlock.querySelector("#llm-vision-forceCall")).toBeNull();
    expect(vision.detailBlock.textContent ?? "").not.toContain("이미지 설명 방식");
    expect(vision.detailBlock.textContent ?? "").not.toContain("항상 캡션 만들기");

    const capInput = vision.detailBlock.querySelector(
      "#llm-vision-tokenCap",
    ) as HTMLInputElement;
    expect(capInput).toBeTruthy();
    expect(capInput.value).toBe("2000");

    const batchInput = vision.detailBlock.querySelector(
      "#llm-vision-backfill-batchSize",
    ) as HTMLInputElement;
    expect(batchInput).toBeTruthy();
    expect(batchInput.value).toBe("10");
  });

  test("이미지 블록에 mode 라디오·intervalMin·minImportance 0 개 (공통·extractor 권위 따라감)", () => {
    const { vision } = setupBlocks({ vision: { enabled: true } });
    // 모델 블록 + 전용 설정 둘 다 검사.
    for (const block of [vision.modelBlock, vision.detailBlock]) {
      expect(block.querySelector("#llm-vision-mode-immediate")).toBeNull();
      expect(block.querySelector("#llm-vision-mode-backfill")).toBeNull();
      expect(block.querySelector("#llm-vision-backfill-intervalMin")).toBeNull();
      expect(
        block.querySelector("#llm-vision-backfill-minImportance"),
      ).toBeNull();
    }
  });

  test("공통 라디오가 (5) batchSize 가시성 제어 — immediate 시 숨김, backfill 시 펼침", () => {
    const { commonMode, vision } = setupBlocks({ extractor: { mode: "backfill" }, vision: { enabled: true } });
    const backfillBox = vision.detailBlock.querySelector(
      '[data-section="vision-backfill"]',
    ) as HTMLElement;
    expect(backfillBox.style.display).toBe("");

    const immediateRadio = commonMode.element.querySelector(
      "#llm-extractor-mode-immediate",
    ) as HTMLInputElement;
    immediateRadio.checked = true;
    immediateRadio.dispatchEvent(new Event("change"));
    expect(backfillBox.style.display).toBe("none");
  });

  test("getPayload — backfill = batchSize 한 칸만 (mode·intervalMin·minImportance 0)", () => {
    const { vision } = setupBlocks({ extractor: { mode: "backfill" }, vision: { enabled: true } });
    const payload = vision.getPayload();
    expect(payload.enabled).toBe(true);
    expect(payload.provider).toBe("anthropic");
    expect(payload.forceCall).toBeUndefined();
    expect(payload.captionPrompt).toBeUndefined();
    expect(payload.tokenCap).toBe(2000);
    // mode·intervalMin 은 vision payload 에 안 들어간다 (extractor 권위).
    expect(payload.mode).toBeUndefined();
    expect(payload.backfill).toBeDefined();
    const backfill = payload.backfill as Record<string, unknown>;
    expect(backfill.batchSize).toBe(10);
    expect(backfill.intervalMin).toBeUndefined();
    expect(backfill.minImportance).toBeUndefined();
    expect(backfill.maxAttempts).toBe(5);
  });

  test("getPayload — 공통 mode=immediate 시 vision backfill 포함 0", () => {
    const { vision } = setupBlocks({
      extractor: { mode: "immediate" },
      extractorOriginal: { mode: "immediate" },
      vision: { enabled: true },
    });
    const payload = vision.getPayload();
    expect(payload.mode).toBeUndefined();
    expect(payload.backfill).toBeUndefined();
  });

  test("isChanged — tokenCap 변경 감지", () => {
    const { vision } = setupBlocks({ vision: { enabled: true, tokenCap: 2000 } });
    expect(vision.isChanged()).toBe(false);
    const capInput = vision.detailBlock.querySelector(
      "#llm-vision-tokenCap",
    ) as HTMLInputElement;
    capInput.value = "500";
    expect(vision.isChanged()).toBe(true);
  });

  test("isChanged — backfill batchSize 변경 감지", () => {
    const { vision } = setupBlocks({ extractor: { mode: "backfill" }, vision: { enabled: true } });
    expect(vision.isChanged()).toBe(false);
    const batchInput = vision.detailBlock.querySelector(
      "#llm-vision-backfill-batchSize",
    ) as HTMLInputElement;
    batchInput.value = "25";
    expect(vision.isChanged()).toBe(true);
  });
});

// ── 이미지 블록 설명 기본 숨김 ──────────────────────────────────────────────

describe("renderVisionBlocks — 설명 기본 숨김", () => {
  test("enabled=false — 긴 비활성 안내를 따로 노출하지 않는다", () => {
    const { vision } = setupBlocks({ vision: { enabled: false } });
    const notice = vision.modelBlock.querySelector(
      '[data-section="vision-disabled-notice"]',
    ) as HTMLElement;
    expect(notice).toBeNull();
    expect(vision.modelBlock.querySelector(".llm-section-desc")).toBeNull();
  });

  test("enabled 토글 — 입력값은 보존하고 설정 카드만 펼치고 접는다", () => {
    const { vision } = setupBlocks({ vision: { enabled: false } });
    const enabledInput = vision.modelBlock.querySelector(
      "#llm-vision-enabled",
    ) as HTMLInputElement;
    const config = vision.modelBlock.querySelector("#llm-vision-config") as HTMLElement;

    expect(config.style.display).toBe("none");
    enabledInput.checked = true;
    enabledInput.dispatchEvent(new Event("change"));
    expect(config.style.display).toBe("");
    enabledInput.checked = false;
    enabledInput.dispatchEvent(new Event("change"));
    expect(config.style.display).toBe("none");
  });
});

// ── cleanup 별 섹션 — 회귀 0 확인 ───────────────────────────────────────────

describe("renderCleanupSection — Ollama 자동 fetch 정합 (Phase 5.7.1 W5)", () => {
  beforeEach(() => { _resetTokenCacheForTest(); });
  afterEach(() => { _resetTokenCacheForTest(); });

  test("cleanup 슬롯 처리 방법에 PC 보조 프로그램 항목이 없다 (2026-10-11 제거)", () => {
    const fetchMock = installFetchMock(() =>
      new Response("[]", { status: 200 }),
    );

    try {
      const value = makeCleanupValue();
      const handle = renderCleanupSection(value, value);
      const methodSelect = handle.element.querySelector(
        "#llm-cleanup-provider-mode",
      ) as HTMLSelectElement;
      expect(methodSelect).toBeTruthy();
      expect(Array.from(methodSelect.options).map((o) => o.textContent)).toEqual([
        "서버에 설치된 AI로 처리",
        "AI API 사용",
      ]);
      expect(Array.from(methodSelect.options).map((o) => o.value)).not.toContain("pc_companion");
      expect(handle.element.textContent ?? "").not.toContain("PC 보조");
      expect(handle.element.textContent ?? "").not.toContain("준비 중");
    } finally {
      fetchMock.restore();
    }
  });

  test("cleanup 슬롯도 provider=ollama 시 자동 fetch + 채움", async () => {
    const fetchMock = installFetchMock(() =>
      new Response(
        JSON.stringify([{ id: "exaone3.5:32b", name: "exaone3.5:32b" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    try {
      const value = makeCleanupValue();
      const handle = renderCleanupSection(value, value);
      await flushMicrotasks();

      const select = handle.element.querySelector(
        "#llm-cleanup-ollama-model",
      ) as HTMLSelectElement;
      expect(select).toBeTruthy();
      const ollamaCalls = fetchMock.calls.filter((c) =>
        c.url.includes("/actions/list-ollama-models"),
      );
      expect(ollamaCalls.length).toBeGreaterThanOrEqual(1);

      const intervalInput = handle.element.querySelector(
        "#llm-cleanup-intervalDays",
      ) as HTMLInputElement;
      expect(intervalInput).toBeTruthy();
      expect(intervalInput.value).toBe("7");
    } finally {
      fetchMock.restore();
    }
  });
});
