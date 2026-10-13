import { test, expect } from "bun:test";
import { workLeafConceptName, workLeafOriginalAlias } from "./work-leaf-concept-key.ts";

test("매체+작가 — 고유 이름", () => {
  expect(workLeafConceptName("괴담", "소설", "백덕수")).toBe("괴담 (소설/백덕수)");
});
test("매체만 — 매체로 갈림", () => {
  expect(workLeafConceptName("괴담", "소설")).toBe("괴담 (소설)");
});
test("작가만 — 작가로 갈림", () => {
  expect(workLeafConceptName("괴담", undefined, "백덕수")).toBe("괴담 (백덕수)");
});
test("둘 다 없음 — 이름 단독(충돌 0·Q3-1)", () => {
  expect(workLeafConceptName("괴담")).toBe("괴담");
  expect(workLeafConceptName("괴담", "", "  ")).toBe("괴담"); // 빈/공백 정규화
});
test("원래 이름 별칭", () => {
  expect(workLeafOriginalAlias("괴담")).toBe("괴담");
});

// 추가 가드 — 정규화·끝점 일관성
test("null 도 없는 것으로(undefined 와 같은 처리)", () => {
  expect(workLeafConceptName("괴담", null, null)).toBe("괴담");
  expect(workLeafConceptName("괴담", null, "백덕수")).toBe("괴담 (백덕수)");
});
test("매체·작가에 앞뒤 공백이 끼면 다듬어 갈라낸다", () => {
  expect(workLeafConceptName("괴담", " 소설 ", " 백덕수 ")).toBe("괴담 (소설/백덕수)");
});
test("이름 앞뒤 공백도 다듬는다", () => {
  expect(workLeafConceptName("  괴담  ", "소설")).toBe("괴담 (소설)");
});
test("별칭은 이름 앞뒤 공백을 다듬은 원래 이름", () => {
  expect(workLeafOriginalAlias("  괴담  ")).toBe("괴담");
});
