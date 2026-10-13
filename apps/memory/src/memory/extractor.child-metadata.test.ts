/**
 * extractor.child-metadata.test.ts — 추출 자식 metadata 가 원문의 추출 기록을 옮기지 않는다(WP-B1-06, SL-2).
 *
 * extractor.test.ts 가 800줄을 넘어, WP-B1-06 이 그 파일에 더했던 테스트를 옮겨 왔다(WP-B1-31).
 * buildChildMetadata 는 순수 함수라 데이터 입력만으로 검증한다.
 */

import { describe, expect, test } from "bun:test";
import { buildChildMetadata } from "./extractor.ts";

describe("MemoryExtractor — buildChildMetadata 추출 기록 칸", () => {
  test("원문의 추출 기록(extracted·extractedTo)은 자식 metadata 로 옮기지 않는다 (SL-2)", () => {
    // 백필은 편집으로 추출 대기가 된 원문·자식이 모두 무효화된 원문의 metadata 를 그대로 넘긴다.
    for (const record of [{ extracted: 0 }, { extracted: 1, extractedTo: [3, 4] }]) {
      const meta = buildChildMetadata(
        { content: "롤백 담당은 운영팀이 맡는다", memoryType: "episode", importance: 0.8 },
        { author: "owner", metadata: { messageId: "msg-321", ...record } },
        "ollama:qwen3:8b",
      );
      expect(meta.messageId).toBe("msg-321");
      expect(meta).not.toHaveProperty("extracted");
      expect(meta).not.toHaveProperty("extractedTo");
    }
  });
});
