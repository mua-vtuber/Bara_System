/**
 * Pure formatting tests. No Discord client, no HTTP.
 */

import { describe, expect, test } from "bun:test";
import {
  chunkForDiscord,
  DISCORD_MESSAGE_LIMIT,
  formatExtractionResult,
  formatForgetReply,
  formatMemoryDetail,
  formatRecent,
  formatSearchResults,
  formatStats,
  summarizeExtractionInline,
} from "./formatting.ts";
import type {
  ExtractFromTextResult,
  MemoryRow,
  SearchResult,
} from "../../memory/src/api-client.ts";

function makeExtractionResult(
  overrides: Partial<ExtractFromTextResult> = {},
): ExtractFromTextResult {
  return {
    extractor: { provider: "ollama-qwen3:8b" },
    stored: [],
    bumped: [],
    filteredOut: 0,
    conflicts: 0,
    items: [],
    raw: null,
    ...overrides,
  };
}

function makeRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: 1,
    content: "샘플 메모",
    memoryType: "fact",
    importance: 0.5,
    confidence: 0.7,
    createdAt: "2026-05-15 12:00:00",
    lastAccessedAt: "2026-05-15 12:00:00",
    mentionCount: 0,
    ...overrides,
  };
}

function makeHit(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 1,
    content: "검색용 메모",
    memoryType: "fact",
    importance: 0.5,
    confidence: 0.7,
    score: 0.8,
    sources: ["vector"],
    ...overrides,
  };
}

describe("formatSearchResults", () => {
  test("empty list → 결과 없음 메시지", () => {
    expect(formatSearchResults("커피", [])).toBe('🔍 "커피" 결과 없음.');
  });

  test("결과 헤더와 항목 라인", () => {
    const out = formatSearchResults("커피", [makeHit({ id: 42, content: "철수는 커피를 좋아한다" })]);
    expect(out).toContain('🔍 "커피" 검색 — 1건');
    expect(out).toContain("#42");
    expect(out).toContain("점수 0.80");
    expect(out).toContain("(vector)");
    expect(out).toContain("철수는 커피를 좋아한다");
  });

  test("[중요] 태그가 importance >= 0.8 에서 붙음", () => {
    const out = formatSearchResults("x", [makeHit({ importance: 0.9 })]);
    expect(out).toContain("[중요]");
  });

  test("[미확인] 태그가 confidence < 0.6 에서 붙음", () => {
    const out = formatSearchResults("x", [makeHit({ confidence: 0.4 })]);
    expect(out).toContain("[미확인]");
  });

  test("두 source 합쳐서 표시", () => {
    const out = formatSearchResults("x", [
      makeHit({ sources: ["vector", "fts"] }),
    ]);
    expect(out).toContain("(vector+fts)");
  });
});

describe("formatRecent", () => {
  test("빈 입력 → 안내 메시지", () => {
    expect(formatRecent([])).toBe("📭 저장된 메모리가 없습니다.");
  });

  test("헤더와 각 항목 표시", () => {
    const out = formatRecent([
      makeRow({ id: 1, content: "첫째" }),
      makeRow({ id: 2, content: "둘째" }),
    ]);
    expect(out).toContain("📋 최근 2개");
    expect(out).toContain("#1");
    expect(out).toContain("첫째");
    expect(out).toContain("#2");
    expect(out).toContain("둘째");
  });
});

describe("formatMemoryDetail", () => {
  test("모든 핵심 필드 표시", () => {
    const out = formatMemoryDetail(
      makeRow({
        id: 7,
        content: "본문 내용",
        memoryType: "preference",
        importance: 0.85,
        confidence: 0.4,
        mentionCount: 3,
      }),
    );
    expect(out).toContain("#7");
    expect(out).toContain("중요");
    expect(out).toContain("미확인");
    expect(out).toContain("preference");
    expect(out).toContain("본문 내용");
    expect(out).toContain("반복 언급: 3회");
  });
});

describe("formatStats", () => {
  test("3개 카운터 출력", () => {
    const out = formatStats({
      totalMemories: 42,
      memoriesLast7Days: 7,
      totalEdges: 13,
    });
    expect(out).toContain("총 메모리: 42개");
    expect(out).toContain("최근 7일: 7개");
    expect(out).toContain("연결(엣지): 13개");
  });
});

describe("formatExtractionResult — 수동 /extract 모드", () => {
  test("빈 추출 → 안내 메시지", () => {
    const out = formatExtractionResult(makeExtractionResult());
    expect(out).toContain("못 찾았음");
  });

  test("저장 + 재언급 + 필터아웃 + 충돌 한 번에 표시", () => {
    const out = formatExtractionResult(
      makeExtractionResult({
        stored: [101, 102],
        bumped: [50],
        filteredOut: 1,
        conflicts: 2,
        items: [
          {
            content: "사용자는 Bun을 선호한다",
            memoryType: "preference",
            importance: 0.7,
          },
          {
            content: "RTX 4080S 사용 중",
            memoryType: "fact",
            importance: 0.85,
          },
          {
            content: "이미 알던 사실 (재언급)",
            memoryType: "fact",
            importance: 0.6,
          },
        ],
      }),
    );
    expect(out).toContain("ollama-qwen3:8b");
    expect(out).toContain("저장 2");
    expect(out).toContain("재언급 1");
    expect(out).toContain("✨ #101");
    expect(out).toContain("✨ #102");
    expect(out).toContain("🔁 (재언급)");
    expect(out).toContain("[중요]");
    expect(out).toContain("preference");
    expect(out).toContain("fact");
    expect(out).toContain("importance 하한 미달로 버린 항목: 1개");
    expect(out).toContain("충돌(supersedes) 감지: 2건");
  });

  test("auto 모드 헤더는 다르게", () => {
    const out = formatExtractionResult(
      makeExtractionResult({
        stored: [1],
        items: [
          {
            content: "단편 메모",
            memoryType: "fact",
            importance: 0.5,
          },
        ],
      }),
      { source: "auto" },
    );
    expect(out).toContain("🪄 자동 추출");
    expect(out).toContain("새 1개");
  });

  test("preserveRaw로 받은 원문 노드 ID가 노출됨", () => {
    const out = formatExtractionResult(
      makeExtractionResult({
        stored: [10],
        items: [
          {
            content: "분해 자식",
            memoryType: "fact",
            importance: 0.5,
          },
        ],
        raw: { id: 9 },
      }),
    );
    expect(out).toContain("원문 보존: #9");
  });
});

describe("summarizeExtractionInline", () => {
  test("저장만 있으면 +N", () => {
    expect(
      summarizeExtractionInline(makeExtractionResult({ stored: [1, 2, 3] })),
    ).toBe("🧠 +3");
  });

  test("저장 + 재언급 분리", () => {
    expect(
      summarizeExtractionInline(
        makeExtractionResult({ stored: [1], bumped: [9, 10] }),
      ),
    ).toBe("🧠 +1 · 재언급 2");
  });

  test("원문 보존된 경우 원문 #N도 노출", () => {
    expect(
      summarizeExtractionInline(
        makeExtractionResult({ stored: [5], raw: { id: 4 } }),
      ),
    ).toBe("🧠 +1 · 원문 #4");
  });

  test("저장 0 + 원문만 있으면 원문 #N", () => {
    expect(
      summarizeExtractionInline(makeExtractionResult({ raw: { id: 7 } })),
    ).toBe("🧠 원문 #7");
  });

  test("아무것도 없으면 추출 0", () => {
    expect(summarizeExtractionInline(makeExtractionResult())).toBe("🤔 추출 0");
  });
});

describe("formatForgetReply — /forget 응답 (WP-B1-20U 설계 17.3)", () => {
  /** WP-B1-20U 설계 17.17 — 해제한 첨부가 없는 응답의 assetCleanup(응답 문장은 첨부 정리를 말하지 않는다). */
  const NO_ASSET_CLEANUP = { documentIds: [], removedSha256s: [], missingSha256s: [], failed: [] };

  test("함께 지운 파생 기억이 없으면 지금 문장 그대로", () => {
    expect(formatForgetReply(7, { deleted: 7, derivedDeletedIds: [], archivePurgedIds: [], assetCleanup: NO_ASSET_CLEANUP }))
      .toBe("🗑️ 메모리 #7 삭제됨.");
  });

  test("함께 지운 파생 기억 수를 붙인다(휴지통 정리 수는 붙이지 않는다)", () => {
    expect(formatForgetReply(7, { deleted: 7, derivedDeletedIds: [8, 9], archivePurgedIds: [10], assetCleanup: NO_ASSET_CLEANUP }))
      .toBe("🗑️ 메모리 #7 삭제됨. 이 메모리에서 나온 파생 메모리 2개도 함께 삭제됨.");
  });

  test("없는 기억이면 옛 '없음' 문장", () => {
    expect(formatForgetReply(99, null)).toBe("메모리 #99 없음.");
  });
});

describe("chunkForDiscord", () => {
  test("짧은 텍스트는 그대로 한 덩어리", () => {
    expect(chunkForDiscord("짧음")).toEqual(["짧음"]);
  });

  test("정확히 limit 길이는 한 덩어리", () => {
    const text = "a".repeat(DISCORD_MESSAGE_LIMIT);
    expect(chunkForDiscord(text)).toEqual([text]);
  });

  test("limit 초과 시 줄 단위로 분할", () => {
    const line = "x".repeat(500);
    const text = Array(10).fill(line).join("\n");
    const chunks = chunkForDiscord(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
  });

  test("한 줄이 limit보다 길면 강제 분할", () => {
    const text = "y".repeat(DISCORD_MESSAGE_LIMIT * 2 + 100);
    const chunks = chunkForDiscord(text);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
  });
});
