import { test, expect } from "bun:test";
import { canonicalKinship } from "./kinship-synonyms.ts";

test("친족 호칭 동의어는 표준형으로 모인다", () => {
  expect(canonicalKinship("어머니")).toBe("엄마");
  expect(canonicalKinship("모친")).toBe("엄마");
  expect(canonicalKinship("아버지")).toBe("아빠");
  expect(canonicalKinship("부친")).toBe("아빠");
});

test("조부모 호칭도 표준형으로 모인다", () => {
  expect(canonicalKinship("조모")).toBe("할머니");
  expect(canonicalKinship("조부")).toBe("할아버지");
});

test("표준형 자기 자신은 그대로 유지된다", () => {
  expect(canonicalKinship("엄마")).toBe("엄마");
  expect(canonicalKinship("아빠")).toBe("아빠");
  expect(canonicalKinship("할머니")).toBe("할머니");
  expect(canonicalKinship("할아버지")).toBe("할아버지");
});

test("사전에 없는 호칭·이름은 그대로", () => {
  expect(canonicalKinship("이모")).toBe("이모");
  expect(canonicalKinship("박대웅")).toBe("박대웅");
});

test("서로 다른 그룹의 호칭은 섞이지 않는다", () => {
  // 엄마 그룹과 아빠 그룹이 같은 표준형으로 합쳐지면 안 된다.
  expect(canonicalKinship("어머니")).not.toBe(canonicalKinship("아버지"));
});

test("앞뒤 공백은 다듬어 사전을 거친다", () => {
  expect(canonicalKinship("  어머니  ")).toBe("엄마");
});

test("빈 문자열·공백만은 빈 문자열로 정직하게 반환한다", () => {
  expect(canonicalKinship("")).toBe("");
  expect(canonicalKinship("   ")).toBe("");
});
