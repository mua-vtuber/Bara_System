/**
 * caption-flow.test.ts — Phase 11b T10.
 *
 * decideVlmInvocation 5 분기 + applyVlmCaptionFlow 통합 흐름 검증.
 *
 * 격리 양식 (T9 ollama.test / T11 memory-schema / T12 cleanup-proposals-repository
 * 가족 정합):
 *   - VisionProvider 인터페이스 type-only import — anthropic.ts / ollama.ts 구체
 *     import 0 → onnxruntime-node transitive 트리거 0.
 *   - SqliteMemoryStore 직접 인스턴스화 0 → Bgem3Embedder transitive import 0.
 *   - applyVlmCaptionFlow 흐름 검증은 storeStub minimal (addImageCaption 한 메서드만
 *     노출) — 옛 T4 `storeStub.getRawDb` 가족 정합. 자식 노드 등록 흐름의 *행동*
 *     (호출됨/안됨 + 인자 정합) 만 검증.
 *   - store.addImageCaption 안 실 SQLite + NodeRepository 통합 검증은 옛 store.test.ts
 *     가족이 책임 (안 가동되더라도 코드 진리는 갱신 — A1 환경 + 사용자 매뉴얼 sanity
 *     단계 위 실효 검증).
 *
 * CLAUDE.md "Mock 객체 금지" 정합 — 본 안 fixture 는 *데이터 fixture* (VisionProvider
 * 한 인터페이스 한정 한 줄 짜리 + 회신 글 자체가 검증 자료). 인터페이스를 가짜로 구현
 * 한 mock 클래스 가족 X.
 *
 * 검증 case:
 *   (1) decideVlmInvocation — enabled=false → false
 *   (2) decideVlmInvocation — provider=null → false
 *   (3) decideVlmInvocation — forceCall=false + hasEmbedding=true → false
 *   (4) decideVlmInvocation — forceCall=false + hasEmbedding=false → true
 *   (5) decideVlmInvocation — forceCall=true → true (임베딩 가용 무관)
 *   (6) applyVlmCaptionFlow — decision=false → storeStub.addImageCaption 호출 0
 *   (7) applyVlmCaptionFlow — decision=true + provider 정상 → addImageCaption 호출 1
 *   (8) applyVlmCaptionFlow — provider=null + decision=true → addImageCaption 호출 0
 *   (9) applyVlmCaptionFlow — provider.captionImage throw → addImageCaption 호출 0
 *  (10) applyVlmCaptionFlow — caption 빈 글자 → addImageCaption 호출 0
 *  (11) toVisionProviderSettings — provider='anthropic' 변환 양식
 *  (12) toVisionProviderSettings — provider='ollama' 변환 양식
 *  (20) requestVlmCaption — 저장 인자 없이 캡션만 회수 (WP-B1-07 잠금 밖 단계)
 *  (21) requestVlmCaption — provider throw → called=true + caption=null
 */

import { describe, expect, test } from "bun:test";
import {
  applyVlmCaptionFlow,
  requestVlmCaption,
  DEFAULT_CAPTION_PROMPT,
  decideVlmInvocation,
  resolveCaptionPrompt,
  toVisionProviderSettings,
} from "./caption-flow.ts";
import type {
  VisionCaptionOptions,
  VisionCaptionResult,
  VisionProvider,
  VisionProviderSettings,
} from "./index.ts";
import type { LlmVisionSlot } from "../../settings/memory-settings.ts";

// ── 공통 fixture ────────────────────────────────────────────────────────────

const DEFAULT_VISION_SETTINGS: VisionProviderSettings = {
  enabled: true,
  provider: "anthropic",
  model: "claude-haiku-4-5",
  endpoint: null,
  apiKey: "sk-ant-test",
  tokenCap: 200,
  forceCall: false,
};

/**
 * storeStub — addImageCaption 한 메서드만 노출. 호출 인자·횟수 captures 안 누적.
 * applyVlmCaptionFlow 안 ApplyVlmCaptionFlowArgs.store 위치에 그대로 주입한다
 * (TypeScript 정합 — `as unknown as SqliteMemoryStore` 단단 형변환 한 줄 한 한).
 */
function createStoreStub() {
  const captures: Array<{
    parentNodeId: number;
    assetSha256: string;
    caption: string;
    captionRole: "auto" | "user";
  }> = [];
  let nextId = 1000;
  return {
    captures,
    addImageCaption: async (args: {
      parentNodeId: number;
      assetSha256: string;
      caption: string;
      captionRole: "auto" | "user";
    }): Promise<number> => {
      captures.push(args);
      return nextId++;
    },
  };
}

/**
 * fixture VisionProvider — caption 글 회신용 한 줄 짜리. CLAUDE.md "Mock 객체 금지"
 * 정합 — 인터페이스를 가짜로 *구현한 클래스* 가 아니라 *데이터 fixture* 양식 한 묶음
 * (회신 글 자체가 검증 자료).
 */
function fixtureVisionProvider(
  caption: string,
  promptSink?: { value: string | null },
): VisionProvider {
  return {
    name: "fixture",
    async captionImage(
      _buffer: Uint8Array | Buffer,
      _mimeType: string,
      prompt: string,
      _options?: VisionCaptionOptions,
    ): Promise<VisionCaptionResult> {
      if (promptSink) promptSink.value = prompt;
      return { caption, usage: { inputTokens: 100, outputTokens: 10 } };
    },
  };
}

function throwingVisionProvider(): VisionProvider {
  return {
    name: "throwing-fixture",
    async captionImage(): Promise<VisionCaptionResult> {
      throw new Error("VLM 가짜 호출 실패 — HTTP 500 가족");
    },
  };
}

// ── (1)~(5) decideVlmInvocation 5 분기 ─────────────────────────────────────

describe("decideVlmInvocation — 5 분기", () => {
  test("(1) enabled=false → false (옵션 OFF)", () => {
    expect(
      decideVlmInvocation(
        { ...DEFAULT_VISION_SETTINGS, enabled: false },
        { hasEmbedding: false },
      ),
    ).toBe(false);
  });

  test("(2) enabled=true + provider=null → false (provider 미지정 = OFF)", () => {
    expect(
      decideVlmInvocation(
        { ...DEFAULT_VISION_SETTINGS, provider: null },
        { hasEmbedding: false },
      ),
    ).toBe(false);
  });

  test("(3) forceCall=false + hasEmbedding=true → false (SigLIP 가동 → 호출 건너뜀)", () => {
    expect(
      decideVlmInvocation(
        { ...DEFAULT_VISION_SETTINGS, forceCall: false },
        { hasEmbedding: true },
      ),
    ).toBe(false);
  });

  test("(4) forceCall=false + hasEmbedding=false → true (임베딩 없으면 자연 fallback)", () => {
    expect(
      decideVlmInvocation(
        { ...DEFAULT_VISION_SETTINGS, forceCall: false },
        { hasEmbedding: false },
      ),
    ).toBe(true);
  });

  test("(5) forceCall=true → true (SigLIP 임베딩 있어도 강제 호출)", () => {
    expect(
      decideVlmInvocation(
        { ...DEFAULT_VISION_SETTINGS, forceCall: true },
        { hasEmbedding: true },
      ),
    ).toBe(true);
  });

  // ── ctx.forceCall override (백필 갈래) — vision 캡션 백필 0/5 fail 회귀 차단 ──
  // 운영 settings.llm.vision.forceCall=false 인데 백필은 임베딩 가용 여부와 무관하게
  // 캡션을 만들어야 한다. ctx.forceCall override 가 없으면 hasEmbedding=true 인 모든
  // 이미지가 token 절약 skip 으로 빠져 백필이 한 건도 캡션을 안 만든다(이번 버그).
  test("(5a) settings.forceCall=false + ctx.forceCall=true + hasEmbedding=true → true (백필 강제)", () => {
    expect(
      decideVlmInvocation(
        { ...DEFAULT_VISION_SETTINGS, provider: "ollama", forceCall: false },
        { hasEmbedding: true, forceCall: true },
      ),
    ).toBe(true);
  });

  test("(5b) settings.forceCall=false + ctx.forceCall 미지정 + hasEmbedding=true → false (ingest token 절약 보존)", () => {
    expect(
      decideVlmInvocation(
        { ...DEFAULT_VISION_SETTINGS, provider: "ollama", forceCall: false },
        { hasEmbedding: true },
      ),
    ).toBe(false);
  });

  test("(5c) enabled=false + ctx.forceCall=true → false (꺼짐이 강제 호출보다 우선)", () => {
    expect(
      decideVlmInvocation(
        { ...DEFAULT_VISION_SETTINGS, enabled: false },
        { hasEmbedding: true, forceCall: true },
      ),
    ).toBe(false);
  });

  test("(5d) provider=null + ctx.forceCall=true → false (provider 미지정이 강제 호출보다 우선)", () => {
    expect(
      decideVlmInvocation(
        { ...DEFAULT_VISION_SETTINGS, provider: null },
        { hasEmbedding: true, forceCall: true },
      ),
    ).toBe(false);
  });
});

// ── (6)~(10) applyVlmCaptionFlow 통합 흐름 ─────────────────────────────────

describe("applyVlmCaptionFlow — 통합 흐름", () => {
  // storeStub + db null 양식 — applyVlmCaptionFlow 안 db 인자는 본 task 단계 안
  // 직접 안 활용 (옛 plan 안 db 인자가 있지만 store facade 통로 안 자연 흡수).
  // TypeScript 정합 위 `as unknown as Database` 단단 형변환 한 줄.
  const fakeDb = {} as unknown as import("bun:sqlite").Database;

  test("(6) decision=false → addImageCaption 호출 0", async () => {
    const stub = createStoreStub();
    // forceCall=false + hasEmbedding=true → decide=false
    const result = await applyVlmCaptionFlow({
      store: stub as unknown as import("../../db/store.ts").SqliteMemoryStore,
      db: fakeDb,
      parentNodeId: 42,
      assetSha256: "a".repeat(64),
      imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      visionSettings: { ...DEFAULT_VISION_SETTINGS, forceCall: false },
      provider: fixtureVisionProvider("호출 안 됨 — 본 글은 등록 안 됨"),
      hasEmbedding: true,
    });
    expect(result.called).toBe(false);
    expect(result.captionNodeId).toBeUndefined();
    expect(stub.captures.length).toBe(0);
  });

  test("(7) decision=true + provider 정상 → addImageCaption 호출 1 + 인자 정합", async () => {
    const stub = createStoreStub();
    // hasEmbedding=false + forceCall=false → decide=true
    const result = await applyVlmCaptionFlow({
      store: stub as unknown as import("../../db/store.ts").SqliteMemoryStore,
      db: fakeDb,
      parentNodeId: 42,
      assetSha256: "a".repeat(64),
      imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      visionSettings: DEFAULT_VISION_SETTINGS,
      provider: fixtureVisionProvider("고양이 한 마리가 창가에 앉아 있다"),
      hasEmbedding: false,
    });
    expect(result.called).toBe(true);
    expect(result.caption).toBe("고양이 한 마리가 창가에 앉아 있다");
    expect(typeof result.captionNodeId).toBe("number");
    expect(stub.captures.length).toBe(1);
    expect(stub.captures[0]).toEqual({
      parentNodeId: 42,
      assetSha256: "a".repeat(64),
      caption: "고양이 한 마리가 창가에 앉아 있다",
      captionRole: "auto",
    });
  });

  test("(8) provider=null + decision=true → addImageCaption 호출 0 (정직 경고 흐름)", async () => {
    const stub = createStoreStub();
    const result = await applyVlmCaptionFlow({
      store: stub as unknown as import("../../db/store.ts").SqliteMemoryStore,
      db: fakeDb,
      parentNodeId: 42,
      assetSha256: "a".repeat(64),
      imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      visionSettings: { ...DEFAULT_VISION_SETTINGS, forceCall: true },
      provider: null,
      hasEmbedding: true,
    });
    expect(result.called).toBe(false);
    expect(stub.captures.length).toBe(0);
  });

  test("(9) provider.captionImage throw → addImageCaption 호출 0 + caption=null 정직 회수", async () => {
    const stub = createStoreStub();
    const result = await applyVlmCaptionFlow({
      store: stub as unknown as import("../../db/store.ts").SqliteMemoryStore,
      db: fakeDb,
      parentNodeId: 42,
      assetSha256: "a".repeat(64),
      imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      visionSettings: { ...DEFAULT_VISION_SETTINGS, forceCall: true },
      provider: throwingVisionProvider(),
      hasEmbedding: true,
    });
    // graceful — 호출 자체는 시도 (called=true) + 캡션 null 정직 회수.
    expect(result.called).toBe(true);
    expect(result.caption).toBeNull();
    expect(result.captionNodeId).toBeUndefined();
    expect(stub.captures.length).toBe(0);
  });

  test("(10) provider 회수 caption 빈 글자 → addImageCaption 호출 0 + caption=null", async () => {
    const stub = createStoreStub();
    const result = await applyVlmCaptionFlow({
      store: stub as unknown as import("../../db/store.ts").SqliteMemoryStore,
      db: fakeDb,
      parentNodeId: 42,
      assetSha256: "a".repeat(64),
      imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      visionSettings: DEFAULT_VISION_SETTINGS,
      provider: fixtureVisionProvider("   "),
      hasEmbedding: false,
    });
    expect(result.called).toBe(true);
    expect(result.caption).toBeNull();
    expect(stub.captures.length).toBe(0);
  });

  // ── 백필 갈래 forceCall override — vision 캡션 백필 0/5 fail 회귀 차단 ──
  // 운영 settings.forceCall=false + hasEmbedding=true 인 이미지여도, args.forceCall=true
  // 면 decideVlmInvocation 이 호출을 허용해 캡션이 실제로 만들어진다. 이 칸이 없던 게
  // 백필이 매 사이클 0/5 fail 한 근본 원인이었다.
  test("(10a) forceCall=true + hasEmbedding=true → 호출됨 + 캡션 노드 생성 (백필 정상 동작)", async () => {
    const stub = createStoreStub();
    const result = await applyVlmCaptionFlow({
      store: stub as unknown as import("../../db/store.ts").SqliteMemoryStore,
      db: fakeDb,
      parentNodeId: 99,
      assetSha256: "c".repeat(64),
      imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      visionSettings: { ...DEFAULT_VISION_SETTINGS, forceCall: false },
      provider: fixtureVisionProvider("파란 머리 소녀가 우산을 들고 서 있다"),
      hasEmbedding: true,
      forceCall: true,
    });
    expect(result.called).toBe(true);
    expect(result.caption).toBe("파란 머리 소녀가 우산을 들고 서 있다");
    expect(typeof result.captionNodeId).toBe("number");
    expect(stub.captures.length).toBe(1);
  });

  test("(10b) forceCall 미지정 + hasEmbedding=true → 호출 안 됨 (ingest token 절약 보존)", async () => {
    const stub = createStoreStub();
    const result = await applyVlmCaptionFlow({
      store: stub as unknown as import("../../db/store.ts").SqliteMemoryStore,
      db: fakeDb,
      parentNodeId: 99,
      assetSha256: "c".repeat(64),
      imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      visionSettings: { ...DEFAULT_VISION_SETTINGS, forceCall: false },
      provider: fixtureVisionProvider("이 글은 등록 안 됨"),
      hasEmbedding: true,
    });
    expect(result.called).toBe(false);
    expect(stub.captures.length).toBe(0);
  });
});

// ── (11)~(12) toVisionProviderSettings 변환 ────────────────────────────────

describe("toVisionProviderSettings — LlmVisionSlot → VisionProviderSettings", () => {
  const SLOT_BASE: LlmVisionSlot = {
    enabled: true,
    provider: "anthropic",
    ollamaUrl: "http://127.0.0.1:11434",
    ollamaModel: "qwen2.5vl:3b",
    anthropicApiKey: "sk-ant-abc",
    anthropicModel: "claude-haiku-4-5",
    openaiBaseUrl: "http://127.0.0.1:1234/v1",
    openaiModel: "qwen3-vl:4b-instruct",
    openaiApiKey: "",
    gptApiKey: "",
    gptModel: "",
    geminiApiKey: "",
    geminiModel: "",
    forceCall: false,
    tokenCap: 200,
    timeoutMs: 360000,
    captionPrompt: "",
    backfill: { batchSize: 10 },
  };

  test("(11) provider='anthropic' → model=anthropicModel + apiKey=anthropicApiKey + endpoint=null", () => {
    const out = toVisionProviderSettings(SLOT_BASE);
    expect(out).toEqual({
      enabled: true,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      endpoint: null,
      apiKey: "sk-ant-abc",
      tokenCap: 200,
      forceCall: false,
      // 2026-10-11 — 공급자 표 기반 변환이라 호출 한도는 모든 공급자에 넘긴다(Anthropic 은 쓰지 않음).
      timeoutMs: 360000,
    });
  });

  test("provider='openai' → gptModel·gptApiKey, 고정 주소라 endpoint=null", () => {
    const out = toVisionProviderSettings({ ...SLOT_BASE, provider: "openai", gptModel: "gpt-4.1-mini", gptApiKey: "sk-gpt-x" });
    expect(out).toEqual({
      enabled: true,
      provider: "openai",
      model: "gpt-4.1-mini",
      endpoint: null,
      apiKey: "sk-gpt-x",
      tokenCap: 200,
      forceCall: false,
      timeoutMs: 360000,
    });
  });

  test("provider='google' → geminiModel·geminiApiKey, endpoint=null", () => {
    const out = toVisionProviderSettings({ ...SLOT_BASE, provider: "google", geminiModel: "gemini-2.5-flash", geminiApiKey: "gm-x" });
    expect(out.model).toBe("gemini-2.5-flash");
    expect(out.apiKey).toBe("gm-x");
    expect(out.endpoint).toBeNull();
    expect(out.provider).toBe("google");
  });

  test("provider='openai_compatible' → openaiModel·openaiBaseUrl·openaiApiKey", () => {
    const out = toVisionProviderSettings({ ...SLOT_BASE, provider: "openai_compatible" });
    expect(out.model).toBe("qwen3-vl:4b-instruct");
    expect(out.endpoint).toBe("http://127.0.0.1:1234/v1");
    expect(out.apiKey).toBe("");
  });

  test("(12) provider='ollama' → model=ollamaModel + endpoint=ollamaUrl + apiKey=null + timeoutMs 전달", () => {
    const out = toVisionProviderSettings({ ...SLOT_BASE, provider: "ollama" });
    expect(out).toEqual({
      enabled: true,
      provider: "ollama",
      model: "qwen2.5vl:3b",
      endpoint: "http://127.0.0.1:11434",
      apiKey: null,
      tokenCap: 200,
      forceCall: false,
      timeoutMs: 360000,
    });
  });
});

// ── (13)~(16) Phase 11e G2-4 — 캡션 프롬프트 검색용 개정 + settings 우선순위 ───

describe("DEFAULT_CAPTION_PROMPT — 검색용 개정 (G2-4)", () => {
  test("(13) 옛 한 문장 제약이 풀리고 검색 핵심 요소가 들어간다", () => {
    // 옛 "한국어 한 문장으로 묘사" 양식은 폐기 — 한 문장 제약 단어가 없어야 한다.
    expect(DEFAULT_CAPTION_PROMPT).not.toContain("한 문장");
    // 검색 매칭 표면을 넓히는 핵심 요소 — 인물·배경·그림체 + 명사 위주 + 2~3문장.
    expect(DEFAULT_CAPTION_PROMPT).toContain("인물");
    expect(DEFAULT_CAPTION_PROMPT).toContain("배경");
    expect(DEFAULT_CAPTION_PROMPT).toContain("그림체");
    expect(DEFAULT_CAPTION_PROMPT).toContain("명사");
    expect(DEFAULT_CAPTION_PROMPT).toContain("2~3문장");
    // 추측·해석 배제로 캡션 신뢰도 확보.
    expect(DEFAULT_CAPTION_PROMPT).toContain("보이는 것");
  });

  test("(13b) 환각 억제 의도 — 추측·해석·상상 금지 문구가 들어간다", () => {
    // 사용자 지정 문구: 추측·해석·상상을 금지해 환각을 줄인다.
    expect(DEFAULT_CAPTION_PROMPT).toContain("추측");
    expect(DEFAULT_CAPTION_PROMPT).toContain("해석");
    expect(DEFAULT_CAPTION_PROMPT).toContain("상상");
  });
});

describe("resolveCaptionPrompt — settings 우선 vs default 강등", () => {
  test("(14) 비어있지 않은 settings 글 → 그 글 우선", () => {
    expect(resolveCaptionPrompt("만화 캐릭터를 묘사해라")).toBe(
      "만화 캐릭터를 묘사해라",
    );
  });

  test("(15) 미지정(undefined) → default 강등", () => {
    expect(resolveCaptionPrompt(undefined)).toBe(DEFAULT_CAPTION_PROMPT);
  });

  test("(16) 빈 문자열·공백만 → default 강등 (?? 빈 문자열 통과 버그 차단)", () => {
    expect(resolveCaptionPrompt("")).toBe(DEFAULT_CAPTION_PROMPT);
    expect(resolveCaptionPrompt("   ")).toBe(DEFAULT_CAPTION_PROMPT);
  });
});

describe("applyVlmCaptionFlow — 프롬프트 wiring (settings → provider)", () => {
  const fakeDb = {} as unknown as import("bun:sqlite").Database;

  test("(17) settings 프롬프트가 있으면 그 글이 provider 로 넘어간다", async () => {
    const stub = createStoreStub();
    const sink: { value: string | null } = { value: null };
    await applyVlmCaptionFlow({
      store: stub as unknown as import("../../db/store.ts").SqliteMemoryStore,
      db: fakeDb,
      parentNodeId: 7,
      assetSha256: "b".repeat(64),
      imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      visionSettings: DEFAULT_VISION_SETTINGS,
      provider: fixtureVisionProvider("캡션 글", sink),
      hasEmbedding: false,
      prompt: "일러스트 보관소 전용 묘사",
    });
    expect(sink.value).toBe("일러스트 보관소 전용 묘사");
  });

  test("(18) settings 프롬프트가 빈 문자열이면 default 가 provider 로 넘어간다", async () => {
    const stub = createStoreStub();
    const sink: { value: string | null } = { value: null };
    await applyVlmCaptionFlow({
      store: stub as unknown as import("../../db/store.ts").SqliteMemoryStore,
      db: fakeDb,
      parentNodeId: 7,
      assetSha256: "b".repeat(64),
      imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      visionSettings: DEFAULT_VISION_SETTINGS,
      provider: fixtureVisionProvider("캡션 글", sink),
      hasEmbedding: false,
      prompt: "",
    });
    expect(sink.value).toBe(DEFAULT_CAPTION_PROMPT);
  });

  test("(19) prompt 인자 미지정 → default 가 provider 로 넘어간다", async () => {
    const stub = createStoreStub();
    const sink: { value: string | null } = { value: null };
    await applyVlmCaptionFlow({
      store: stub as unknown as import("../../db/store.ts").SqliteMemoryStore,
      db: fakeDb,
      parentNodeId: 7,
      assetSha256: "b".repeat(64),
      imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
      visionSettings: DEFAULT_VISION_SETTINGS,
      provider: fixtureVisionProvider("캡션 글", sink),
      hasEmbedding: false,
    });
    expect(sink.value).toBe(DEFAULT_CAPTION_PROMPT);
  });
});

describe("requestVlmCaption — 저장과 분리한 요청 단계 (WP-B1-07)", () => {
  // 요청 단계 인자에는 store·db 가 없다 — 비전 백필이 이 단계를 쓰기 잠금 밖에서 부른다.
  const requestArgs = {
    parentNodeId: 42,
    assetSha256: "a".repeat(64),
    imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    mimeType: "image/png",
    visionSettings: { ...DEFAULT_VISION_SETTINGS, forceCall: true },
    hasEmbedding: true,
  };

  test("(20) provider 정상 → called=true + 캡션 글, captionNodeId 없음", async () => {
    const request = await requestVlmCaption({
      ...requestArgs,
      provider: fixtureVisionProvider("  책상 위에 놓인 노트북  "),
    });
    expect(request).toEqual({ called: true, caption: "책상 위에 놓인 노트북" });
  });

  test("(21) provider throw → called=true + caption=null", async () => {
    const request = await requestVlmCaption({ ...requestArgs, provider: throwingVisionProvider() });
    expect(request).toEqual({ called: true, caption: null });
  });
});
