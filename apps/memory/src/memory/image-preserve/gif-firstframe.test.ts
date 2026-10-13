/**
 * gif-firstframe.test.ts — Phase 11a T4 GIF 첫 프레임 추출 검증.
 *
 * 실제 GIF 바이트 → PNG 변환 + PNG magic 헤더 확인 + 실패 갈래 명시 에러.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractFirstFramePng } from "./gif-firstframe.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");

describe("extractFirstFramePng", () => {
  test("작은 animated GIF → PNG 바이트 + PNG magic 헤더", async () => {
    const buffer = readFileSync(join(FIXTURES, "animated-small.gif"));
    const png = await extractFirstFramePng(buffer);
    expect(png.byteLength).toBeGreaterThan(0);
    // PNG magic: 89 50 4E 47
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);
  });

  test("큰 animated GIF → PNG 바이트 + 입력보다 작음 (첫 프레임만)", async () => {
    const buffer = readFileSync(join(FIXTURES, "animated-big.gif"));
    const png = await extractFirstFramePng(buffer);
    expect(png.byteLength).toBeGreaterThan(0);
    // 첫 프레임만 추출했으므로 입력 (18MB+) 보다 작아야 한다.
    expect(png.byteLength).toBeLessThan(buffer.byteLength);
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
  });

  test("디코드 불가 바이트 → 명시 에러 throw", async () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    await expect(extractFirstFramePng(garbage)).rejects.toThrow(
      /첫 프레임 추출 실패/,
    );
  });
});
