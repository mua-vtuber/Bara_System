/**
 * extractor.prompt-audit.test.ts — 2026-10-20 추출 프롬프트 점검 결과를 실제 추출기로 확인한다.
 *
 *   - importance 가 없는 항목은 기본값으로 살리지 않고 버리며, 경고 한 줄과 filteredOutCount 에 남는다.
 *   - 시스템 프롬프트의 importance 하한 = 추출기가 실제로 버리는 하한(생성자 minImportance).
 *   - 추출 요청은 생각 끄기(think:false)를 싣고, 오늘 날짜를 보내지 않는다.
 *   - memoryType 한 줄 정의와 few-shot 예시가 서로 맞는다.
 *
 * 실제 OllamaClient + 실제 로컬 HTTP 대역 서버(test-utils/provider-stand-in.ts) + 실제 SQLite.
 * 인터페이스를 흉내 내는 객체는 만들지 않는다.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { OllamaClient } from "../llm/ollama-client.ts";
import type { ChatMessage } from "../llm/types.ts";
import { startProviderStandIn, type ProviderStandIn } from "../test-utils/provider-stand-in.ts";
import { inputChildSource } from "../test-utils/extraction-placement.ts";
import { EXTRACTOR_MIN_IMPORTANCE } from "./constants.ts";
import {
  EXTRACTION_SYSTEM_PROMPT,
  MemoryExtractor,
  buildExtractionMessages,
  buildExtractionSystemPrompt,
} from "./extractor.ts";

/** 쪼갤 가치가 있어(절 접속어미 여럿) 짧은 단일 의미 건너뛰기에 걸리지 않는 입력. */
const INPUT_TEXT =
  "어제 서울에서 오랜 친구를 만났고, 그 친구는 곧 부산으로 이사한다고 했으며, 다음 달에는 함께 여행을 가기로 했다.";

let standIn: ProviderStandIn;
let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;

beforeAll(() => {
  standIn = startProviderStandIn();
  // 이 파일의 저장 시험은 항목이 모두 걸러져 임베딩을 하지 않는다 — 차원(1024)만 쓰므로 load() 없이 구성한다.
  embedder = new Bgem3Embedder();
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  standIn.requests.length = 0;
});
afterAll(() => {
  standIn.stop();
  db.close();
});

function replyWith(items: unknown): void {
  standIn.reply = () => ({
    body: {
      message: { role: "assistant", content: JSON.stringify(items) },
      done_reason: "stop",
      eval_count: 20,
    },
  });
}

function extractor(options: { minImportance?: number } = {}): MemoryExtractor {
  const client = new OllamaClient({ baseUrl: standIn.origin, model: "fixture-model", timeoutMs: 5000 });
  return new MemoryExtractor(client, store, embedder, options);
}

function sentMessages(): ChatMessage[] {
  const body = standIn.requests[0]!.body as { messages: ChatMessage[] };
  return body.messages;
}

describe("importance 가 없는 항목 — 버리고 센다", () => {
  const ITEMS = [
    { content: "친구가 부산으로 이사한다", memoryType: "fact", importance: 0.8 },
    { content: "다음 달에 함께 여행을 간다", memoryType: "episode" },
    { content: "오랜 친구를 만났다", memoryType: "episode", importance: "high" },
  ];

  test("extract() 는 importance 없는 두 항목을 버리고 경고 한 줄을 남긴다", async () => {
    replyWith(ITEMS);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { items } = await extractor().extract({ text: INPUT_TEXT });
      expect(items.map((i) => i.content)).toEqual(["친구가 부산으로 이사한다"]);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("[extractor]") && l.includes("2개를 버렸다"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("저장 결과 filteredOutCount 에 importance 없는 항목과 하한 미달 항목이 함께 들어간다", async () => {
    replyWith([
      { content: "다음 달에 함께 여행을 간다", memoryType: "episode" },
      { content: "오랜 친구를 만났다", memoryType: "episode", importance: null },
      { content: "사소한 내용입니다", memoryType: "fact", importance: 0.01 },
    ]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ex = extractor();
      const input = { text: INPUT_TEXT, platform: "manual", skipHashtagWiring: true };
      const prepared = await ex.prepareExtraction(input);
      expect(prepared.items).toEqual([]);
      const result = await ex.storeExtraction(prepared, input, inputChildSource(input));
      expect(result.filteredOutCount).toBe(3);
      expect(result.storedNodeIds).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("요청 모양 — 하한·생각 끄기·날짜", () => {
  test("시스템 프롬프트의 importance 하한은 생성자 minImportance 와 같다", async () => {
    replyWith([]);
    await extractor({ minImportance: 0.4 }).extract({ text: INPUT_TEXT });
    const system = sentMessages()[0]!;
    expect(system.role).toBe("system");
    expect(system.content).toBe(buildExtractionSystemPrompt(0.4));
    expect(system.content).toContain("0.4 미만은 저장하지 않고");
  });

  test("하한 미지정이면 EXTRACTOR_MIN_IMPORTANCE 로 만든 기본 프롬프트", async () => {
    replyWith([]);
    await extractor().extract({ text: INPUT_TEXT });
    expect(sentMessages()[0]!.content).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(EXTRACTION_SYSTEM_PROMPT).toContain(`${EXTRACTOR_MIN_IMPORTANCE} 미만은 저장하지 않고`);
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("숫자가 없는 항목은 버린다");
  });

  test("추출 요청은 think:false 를 싣고, 어느 메시지에도 오늘 날짜가 없다", async () => {
    replyWith([]);
    await extractor().extract({ text: INPUT_TEXT }, { now: new Date(2026, 9, 20) });
    const body = standIn.requests[0]!.body as { think?: unknown; messages: ChatMessage[] };
    expect(body.think).toBe(false);
    for (const m of body.messages) {
      expect(m.content).not.toContain("오늘 날짜");
      expect(m.content).not.toContain("2026-10-20");
    }
  });

  test("subject/predicate/object 칸은 프롬프트에서 빠졌다", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).not.toContain("subject");
    expect(EXTRACTION_SYSTEM_PROMPT).not.toContain("predicate");
  });
});

describe("memoryType 정의와 few-shot 예시", () => {
  const TYPES = ["fact", "preference", "episode", "insight", "triple"] as const;

  function fewShotItems(): Array<{ content: string; memoryType: string }> {
    return buildExtractionMessages("최종 입력")
      .filter((m) => m.role === "assistant")
      .flatMap((m) => JSON.parse(m.content) as Array<{ content: string; memoryType: string }>);
  }

  test("다섯 종류 모두 한 줄 정의가 있다", () => {
    for (const type of TYPES) {
      expect(EXTRACTION_SYSTEM_PROMPT).toMatch(new RegExp(`^- ${type}: .+\\.$`, "m"));
    }
  });

  test("few-shot 예시가 다섯 종류를 모두 한 번 이상 보여 준다", () => {
    const shown = new Set(fewShotItems().map((i) => i.memoryType));
    for (const type of TYPES) expect(shown.has(type)).toBe(true);
  });

  test("같은 인과 예시 안의 겪은 일은 모두 episode (옛 '시끄러웠다.'=fact 불일치 제거)", () => {
    const byContent = new Map(fewShotItems().map((i) => [i.content, i.memoryType]));
    expect(byContent.get("옆집이 새벽부터 공사했다.")).toBe("episode");
    expect(byContent.get("시끄러웠다.")).toBe("episode");
    expect(byContent.get("집중을 못 했다.")).toBe("episode");
    expect(byContent.get("영수증은 버렸다.")).toBe("episode");
  });

  test("노바 예시의 조사 변경·꾸밈 절은 프롬프트 규칙이 허용한다(규칙 3·6·7)", () => {
    expect(fewShotItems().map((i) => i.content)).toContain(
      "말이 막히는 부분을 보조하기 위해 노바를 계획했다.",
    );
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("프로젝트명은 조사만 바꿔 목적어로 둔다");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('"~하기 위해" 같은 꾸밈 절은 따로 세지 않는다');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("규칙 3의 조사 변경만 허용한다");
  });
});
