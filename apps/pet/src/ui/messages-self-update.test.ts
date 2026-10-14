import { expect, test } from "bun:test";
import { messages } from "./messages.ts";
import { withDirection, withSubject } from "./messages-self-update.ts";

test("the subject particle follows how the version's last digit is read", () => {
  expect(withSubject("0.1.9")).toBe("0.1.9가");
  expect(withSubject("0.1.10")).toBe("0.1.10이");
  expect(withSubject("0.2.3")).toBe("0.2.3이");
  expect(withSubject("1.0.4")).toBe("1.0.4가");
});

test("the direction particle is 으로 only after 영, 삼, 육", () => {
  expect(withDirection("0.1.9")).toBe("0.1.9로");
  expect(withDirection("0.1.1")).toBe("0.1.1로");
  expect(withDirection("0.2.0")).toBe("0.2.0으로");
  expect(withDirection("0.1.3")).toBe("0.1.3으로");
  expect(withDirection("0.1.6")).toBe("0.1.6으로");
});

test("the notice and the question read as the spec writes them", () => {
  expect(messages.selfUpdate.notice("0.1.9")).toBe("새 버전 0.1.9가 있어요");
  expect(messages.selfUpdate.confirm("0.1.9")).toBe("0.1.9로 지금 설치하시겠습니까?");
  expect(messages.selfUpdate.buttonLabel).toBe("지금 업데이트하기");
  expect(messages.selfUpdate.checkFailed("연결 실패")).toBe("업데이트 확인 실패: 연결 실패");
});

test("a mismatch names the expected and the actual value", () => {
  const text = messages.selfUpdateErrors.SELF_UPDATE_DIGEST_MISMATCH("a".repeat(64), "b".repeat(64));
  expect(text).toContain("파일이 손상됐거나 바뀌었습니다");
  expect(text).toContain("a".repeat(64));
  expect(text).toContain("b".repeat(64));
});
