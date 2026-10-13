/**
 * unzipWithinLimits — zip 목록의 크기·개수로 풀기 전에 상한을 걸고, 크기를 속인 엔트리는
 * 적힌 크기를 넘는 순간 멈추는지 검증한다.
 * 실제 zip 을 fflate 로 만들어 넣는다(mock 없음).
 */

import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { unzipWithinLimits, ZipLimitExceededError } from "./bounded-unzip.ts";

const limits = { maxEntries: 3, maxEntryUncompressedBytes: 1000, maxTotalUncompressedBytes: 1500 };
/** 크기를 속인 엔트리를 거절하는 데 허용하는 시간. 끝까지 풀면 이보다 훨씬 오래 걸린다. */
const MAX_LIE_REJECT_MS = 1000;
/** zip 끝 표시(end of central directory) 고정 길이. */
const EOCD_BYTES = 22;
/** 가짜 끝 표시 뒤에 붙이는 주석 바이트 수. */
const COMMENT_TAIL_BYTES = 10;

function caught(fn: () => unknown): ZipLimitExceededError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ZipLimitExceededError) return err;
    throw err;
  }
  throw new Error("상한 초과 에러가 나지 않았다");
}

/** central directory 의 풀린 크기 칸(offset 24)을 거짓 값으로 바꾼다. */
function lieAboutSizes(zip: Uint8Array, declared: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i + 4 <= out.length; i++) {
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, declared, true);
  }
  return out;
}

describe("unzipWithinLimits", () => {
  test("상한 안의 zip 은 그대로 푼다", () => {
    const zip = zipSync({ "a.txt": new Uint8Array(500), "b.txt": new Uint8Array(500) });
    const entries = unzipWithinLimits(zip, limits);
    expect(Object.keys(entries).sort()).toEqual(["a.txt", "b.txt"]);
    expect(entries["a.txt"]!.length).toBe(500);
  });

  test("엔트리 수 상한", () => {
    const zip = zipSync({ a: new Uint8Array(1), b: new Uint8Array(1), c: new Uint8Array(1), d: new Uint8Array(1) });
    const err = caught(() => unzipWithinLimits(zip, limits));
    expect(err.limit).toBe("maxEntries");
    expect(err.message).toContain("maxEntries=3");
  });

  test("엔트리 하나의 풀린 크기 상한 — 잘 압축되는 큰 엔트리(zip bomb 꼴)", () => {
    const zip = zipSync({ "bomb.xml": new Uint8Array(1001) }, { level: 9 });
    expect(zip.length).toBeLessThan(1001);
    const err = caught(() => unzipWithinLimits(zip, limits));
    expect(err.limit).toBe("maxEntryUncompressedBytes");
    expect(err.message).toContain("bomb.xml");
  });

  test("풀린 크기 합계 상한", () => {
    const zip = zipSync({ a: new Uint8Array(800), b: new Uint8Array(800) });
    const err = caught(() => unzipWithinLimits(zip, limits));
    expect(err.limit).toBe("maxTotalUncompressedBytes");
    expect(err.limitValue).toBe(1500);
  });

  test("목록에 작은 크기를 거짓으로 적은 압축 엔트리는 적힌 크기를 넘는 순간 바로 거절한다", () => {
    // 실제로는 64 MiB 로 부푸는 엔트리를 10 바이트라고 속인 zip (압축본은 수십 KB).
    const zip = lieAboutSizes(zipSync({ "liar.xml": new Uint8Array(64 * 1024 * 1024) }, { level: 9 }), 10);
    expect(zip.length).toBeLessThan(1024 * 1024);
    const startedAt = performance.now();
    const err = caught(() => unzipWithinLimits(zip, limits));
    const elapsedMs = performance.now() - startedAt;
    expect(err.limit).toBe("declaredEntrySize");
    expect(err.limitValue).toBe(10);
    expect(err.message).toContain("liar.xml");
    // 끝까지 풀지 않고 적힌 크기에서 멈춘다 — 64 MiB 를 다 푸는 시간보다 훨씬 짧다.
    expect(elapsedMs).toBeLessThan(MAX_LIE_REJECT_MS);
  });

  test("실제 크기가 목록보다 작아도 손상된 zip 으로 거절한다", () => {
    const zip = lieAboutSizes(zipSync({ "short.xml": new Uint8Array(100) }), 200);
    expect(() => unzipWithinLimits(zip, limits)).toThrow(/zip 형식 오류/);
  });

  test("무압축 엔트리의 크기가 목록과 다르면 거절한다", () => {
    const zip = lieAboutSizes(zipSync({ "stored.bin": new Uint8Array(100) }, { level: 0 }), 50);
    expect(() => unzipWithinLimits(zip, limits)).toThrow(/zip 형식 오류/);
  });

  test("빈 엔트리와 폴더 엔트리도 그대로 푼다", () => {
    const entries = unzipWithinLimits(zipSync({ "empty.txt": new Uint8Array(0), "dir/": new Uint8Array(0) }), limits);
    expect(entries["empty.txt"]!.length).toBe(0);
    expect(entries["dir/"]!.length).toBe(0);
  });

  test("주석 안의 가짜 끝 표시 서명은 무시하고 진짜 끝 표시로 푼다", () => {
    const zip = zipSync({ "real.txt": new Uint8Array([1, 2, 3]) });
    // 주석 안에 끝 표시 서명 + 엉뚱한 목록 위치를 넣고, 그 뒤에 주석 바이트를 더 붙인다(가짜
    // 끝 표시가 말하는 파일 끝과 실제 파일 끝이 어긋난다). 주석 길이는 진짜 끝 표시에 적어 둔다.
    const fake = new Uint8Array(EOCD_BYTES + COMMENT_TAIL_BYTES);
    const fakeView = new DataView(fake.buffer);
    fakeView.setUint32(0, 0x06054b50, true);
    fakeView.setUint16(10, 1, true);
    fakeView.setUint32(16, 0, true);
    const withComment = new Uint8Array(zip.length + fake.length);
    withComment.set(zip);
    withComment.set(fake, zip.length);
    new DataView(withComment.buffer).setUint16(zip.length - EOCD_BYTES + 20, fake.length, true);

    const entries = unzipWithinLimits(withComment, limits);
    expect(Object.keys(entries)).toEqual(["real.txt"]);
    expect(Array.from(entries["real.txt"]!)).toEqual([1, 2, 3]);
  });

  test("결과 객체는 원형이 없어 __proto__ 이름 엔트리도 일반 칸으로 담긴다", () => {
    const entries = unzipWithinLimits(zipSync({ __proto__: new Uint8Array([7]) } as unknown as Record<string, Uint8Array>), limits);
    expect(Object.getPrototypeOf(entries)).toBeNull();
  });

  test("깨진 zip 은 zip 형식 오류로 던진다(상한 초과와 구분)", () => {
    expect(() => unzipWithinLimits(new Uint8Array([1, 2, 3, 4]), limits)).toThrow(/zip 형식 오류/);
    expect(() => unzipWithinLimits(new Uint8Array([1, 2, 3, 4]), limits)).not.toThrow(ZipLimitExceededError);
  });
});
