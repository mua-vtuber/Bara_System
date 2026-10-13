/**
 * asset-cleanup-log.test.ts — 코어의 첨부 파일 정리 결과(assetCleanup)를 봇 경고 줄로 만드는 순수 함수(WP-B1-20U 설계
 * 17.17). 데이터 입력 → 출력 줄만 본다(Discord 객체·대체 클라이언트 없음, 설계 17.16).
 */

import { describe, expect, test } from "bun:test";
import { assetCleanupFailureLines } from "./asset-cleanup-log.ts";

const SHA = "a".repeat(64);

describe("assetCleanupFailureLines", () => {
  test("지우지 못한 파일마다 sha·경로·원인을 담은 경고 한 줄", () => {
    const lines = assetCleanupFailureLines("message 123", {
      documentIds: ["doc_1"],
      removedSha256s: [],
      missingSha256s: [],
      failed: [{ sha256: SHA, path: `/data/assets/content/${SHA}.txt`, error: "EPERM: operation not permitted" }],
    });
    expect(lines).toEqual([
      `message 123: 첨부 파일을 지우지 못함(기억 삭제는 끝남, 코어가 서버 시작 때 다시 지움) — ` +
        `${SHA} /data/assets/content/${SHA}.txt: EPERM: operation not permitted`,
    ]);
  });

  test("실패가 없으면 빈 목록(지운 파일·이미 없던 파일은 코어 로그가 맡는다)", () => {
    expect(assetCleanupFailureLines("message 123", {
      documentIds: ["doc_1"], removedSha256s: [SHA], missingSha256s: [], failed: [],
    })).toEqual([]);
  });
});
