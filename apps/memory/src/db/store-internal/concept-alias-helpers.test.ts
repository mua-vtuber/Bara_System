/**
 * concept-alias-helpers.test.ts — 별칭 순수 헬퍼 단위 검증.
 *
 * DB·임베딩 의존이 없는 순수 문자열 함수만 다룬다(통합 동작은
 * concept-repository.test.ts 가 실 SQLite 로 검증). 핵심은 aliasLangOf 의
 * NFD 방어(T6 잔여 우려 2 마감) — 호출자가 NFC 정규화를 빠뜨려도 조합형
 * 한글이 en 으로 새지 않는 것을 함수 자체 계약으로 고정한다.
 */
import { test, expect } from "bun:test";
import { aliasLangOf } from "./concept-alias-helpers.ts";

test("aliasLangOf — 완성형(NFC) 한글은 ko", () => {
  expect(aliasLangOf("괴담")).toBe("ko");
});

test("aliasLangOf — 영문은 en", () => {
  expect(aliasLangOf("Banjjagi")).toBe("en");
});

test("aliasLangOf — 한글이 하나라도 섞이면 ko(한국어 우선 프로필)", () => {
  expect(aliasLangOf("괴담 season2")).toBe("ko");
});

test("aliasLangOf — 조합형(NFD) 한글도 ko(함수 내부 NFC 방어)", () => {
  // 호출자가 NFC 정규화 없이 넘겨도 en 오판이 없어야 한다 — T6 잔여 우려 2:
  // 기존 호출처는 전부 NFC 선행이라 실동작이 정상이었지만, 정규화 없는 새
  // 호출처가 생기면 조합형 한글 별칭이 en_aliases 로 새는 버그가 재발한다.
  const nfd = "괴담".normalize("NFD");
  expect(nfd).not.toBe("괴담"); // 전제 확인 — 정말 분해된 문자열이다.
  expect(aliasLangOf(nfd)).toBe("ko");
});
