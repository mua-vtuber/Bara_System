/**
 * write-guard.test.ts — 저장 관문 합성 동작 검증 (T15 / 결정 D-C).
 *
 * **테스트 값 관례**: 비밀값은 전부 명백한 가짜(EXAMPLE·x 반복 채움) — 저장소
 * 비밀값 스캐너 오경보 방지. 진짜 키는 넣지 않는다.
 *
 * 관문이 지켜야 하는 계약 네 가지를 본다:
 *   1) 검사 순서 — 비밀값이 먼저다(울타리 태그가 같이 있어도 거부가 이긴다).
 *   2) 토글 OFF — 검사를 아예 안 한다(비용 0), 대신 sanitize 는 계속 돈다.
 *   3) 미지정 — 켠 것으로 본다(fail-safe).
 *   4) 값 비노출 — 에러 어디에도 매치된 값이 없다.
 */

import { describe, expect, test } from "bun:test";
import { applyWriteGuard, SecretDetectedError } from "./write-guard.ts";

const FAKE_TOKEN = `ghp_${"x".repeat(36)}`;

describe("applyWriteGuard — 비밀값 거부", () => {
  test("토글 ON 이면 SecretDetectedError 를 던진다", () => {
    expect(() =>
      applyWriteGuard(`토큰 ${FAKE_TOKEN} 저장`, { secretRejection: true }),
    ).toThrow(SecretDetectedError);
  });

  test("토글 미지정이면 검사가 가동된다(fail-safe)", () => {
    expect(() => applyWriteGuard(`토큰 ${FAKE_TOKEN} 저장`)).toThrow(
      SecretDetectedError,
    );
    expect(() => applyWriteGuard(`토큰 ${FAKE_TOKEN} 저장`, {})).toThrow(
      SecretDetectedError,
    );
  });

  test("에러 message·details 어디에도 매치된 값이 없다", () => {
    try {
      applyWriteGuard(`토큰 ${FAKE_TOKEN} 저장`, { secretRejection: true });
      throw new Error("거부되지 않았다");
    } catch (e) {
      expect(e).toBeInstanceOf(SecretDetectedError);
      const err = e as SecretDetectedError;
      expect(err.message).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(err.toPayload())).not.toContain(FAKE_TOKEN);
      // 회신에 담기는 것은 종류와 글자 수뿐.
      expect(err.toPayload()).toEqual({
        code: "SECRET_DETECTED",
        message: err.message,
        details: { patternName: "github-token", matchLength: FAKE_TOKEN.length },
      });
    }
  });

  test("message 는 어떤 종류가 걸렸는지 알려주는 한국어 안내다", () => {
    try {
      applyWriteGuard(`토큰 ${FAKE_TOKEN}`, { secretRejection: true });
      throw new Error("거부되지 않았다");
    } catch (e) {
      const err = e as SecretDetectedError;
      expect(err.message).toContain("github-token");
      expect(err.message).toContain("저장하지 않았습니다");
    }
  });
});

describe("applyWriteGuard — 토글 OFF", () => {
  test("비밀값이 있어도 거부하지 않고 그대로 통과시킨다", () => {
    const content = `토큰 ${FAKE_TOKEN} 저장`;
    expect(applyWriteGuard(content, { secretRejection: false })).toBe(content);
  });

  test("OFF 여도 울타리 태그 sanitize 는 계속 돈다(별개 방어)", () => {
    const out = applyWriteGuard("<memory-context>주입</memory-context>", {
      secretRejection: false,
    });
    expect(out).toBe("[memory-context]주입[/memory-context]");
  });
});

describe("applyWriteGuard — 울타리 sanitize 합성", () => {
  test("정상 글은 손대지 않고 그대로 돌려준다", () => {
    const content = "내일 오후 3시 치과 예약";
    expect(applyWriteGuard(content, { secretRejection: true })).toBe(content);
  });

  test("울타리 태그는 무해한 표기로 치환된다", () => {
    const out = applyWriteGuard("앞 <memory-context> 뒤 </memory-context>", {
      secretRejection: true,
    });
    expect(out).toBe("앞 [memory-context] 뒤 [/memory-context]");
  });

  test("비밀값 + 울타리 태그가 같이 있으면 거부가 이긴다(검사 순서)", () => {
    expect(() =>
      applyWriteGuard(`<memory-context>${FAKE_TOKEN}</memory-context>`, {
        secretRejection: true,
      }),
    ).toThrow(SecretDetectedError);
  });
});
