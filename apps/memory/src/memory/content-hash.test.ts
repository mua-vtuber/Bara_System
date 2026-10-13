import { describe, test, expect } from "bun:test";
import { contentHash } from "./content-hash.ts";

describe("contentHash — 정규화(NFC + trim) 후 sha256 hex", () => {
  test("(a) 같은 내용 → 같은 해시", () => {
    const a = contentHash("오늘 운동했다");
    const b = contentHash("오늘 운동했다");
    expect(a).toBe(b);
  });

  test("(b) NFC 조합형/완성형 한글 → 같은 해시", () => {
    // "한글" 완성형(NFC) vs 조합형(NFD, 자모 분리). 같은 글자를 다른 IME/시스템이
    // 다른 바이트로 만들어도 정규화 후 같은 해시여야 한다.
    const composed = "한글".normalize("NFC");
    const decomposed = "한글".normalize("NFD");
    // 사전 조건: 두 표현의 바이트가 실제로 다른지 확인(테스트 전제).
    expect(composed).not.toBe(decomposed);
    expect(contentHash(composed)).toBe(contentHash(decomposed));
  });

  test("(c) 앞뒤 공백만 다른 두 입력 → 같은 해시", () => {
    expect(contentHash("  회의록  ")).toBe(contentHash("회의록"));
    expect(contentHash("\n\t회의록\n")).toBe(contentHash("회의록"));
  });

  test("(d) 내부 공백 다른 두 입력 → 다른 해시", () => {
    // "노란후드" vs "노란 후드" 는 다른 글이므로 다른 해시여야 한다(과도 정규화 금지).
    expect(contentHash("노란후드")).not.toBe(contentHash("노란 후드"));
  });

  test("(e) 빈 문자열도 유효 해시 반환", () => {
    const h = contentHash("");
    // 빈 문자열의 sha256 은 널리 알려진 상수. 정상 계산됨을 확인.
    expect(h).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    // 앞뒤 공백만 있는 입력도 trim 후 빈 문자열이라 같은 해시.
    expect(contentHash("   ")).toBe(h);
  });

  test("(f) 대소문자 다르면 다른 해시(대소문자 정규화 안 함)", () => {
    expect(contentHash("Bara")).not.toBe(contentHash("bara"));
  });

  test("반환값은 64자 hex 문자열", () => {
    const h = contentHash("임의 내용");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("내부 줄바꿈은 보존(다른 글)", () => {
    expect(contentHash("첫 줄\n둘째 줄")).not.toBe(contentHash("첫 줄 둘째 줄"));
  });
});
