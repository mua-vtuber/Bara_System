import { describe, test, expect } from "bun:test";
import { toNfc } from "./nfc.ts";

describe("toNfc — NFC-only 정규화(trim 없음)", () => {
  test("NFD → NFC 로 정규화된다", () => {
    const composed = "한글".normalize("NFC");
    const decomposed = "한글".normalize("NFD");
    expect(composed).not.toBe(decomposed);
    expect(toNfc(decomposed)).toBe(composed);
  });

  test("이미 NFC 인 입력은 byte 동일(idempotent — NFC(NFC(x)) === NFC(x))", () => {
    const composed = "한글 문장입니다".normalize("NFC");
    expect(toNfc(composed)).toBe(composed);
    expect(toNfc(toNfc(composed))).toBe(composed);
  });

  test("trim 은 하지 않는다 — 앞뒤 공백 보존", () => {
    expect(toNfc("  공백 보존  ")).toBe("  공백 보존  ");
  });

  test("영문 대소문자는 안 건드린다", () => {
    expect(toNfc("Bara")).toBe("Bara");
  });

  test("빈 문자열도 그대로", () => {
    expect(toNfc("")).toBe("");
  });
});
