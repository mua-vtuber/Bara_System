import { describe, it, expect } from "bun:test";
import { lerpHexColor, parseHex, toHex } from "./color-lerp.ts";

describe("lerpHexColor", () => {
  it("t=0 은 a, t=1 은 b", () => {
    expect(lerpHexColor("#000000", "#ffffff", 0)).toBe("#000000");
    expect(lerpHexColor("#000000", "#ffffff", 1)).toBe("#ffffff");
  });
  it("t=0.5 는 채널 중간값", () => {
    expect(lerpHexColor("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
  it("범위 밖 t 는 clamp", () => {
    expect(lerpHexColor("#000000", "#ffffff", -1)).toBe("#000000");
    expect(lerpHexColor("#000000", "#ffffff", 2)).toBe("#ffffff");
  });
  it("parseHex/toHex 왕복", () => {
    expect(toHex(...parseHex("#1a2b3c"))).toBe("#1a2b3c");
  });
});
