import { describe, expect, test } from "bun:test";
import {
  createInstallProgress,
  formatProgressLine,
  PROGRESS_ENV,
  PROGRESS_THROTTLE_MS,
  progressLinesEnabled,
} from "./install-progress.ts";

function harness(parts: number) {
  const lines: string[] = [];
  let clock = 1_000;
  const progress = createInstallProgress({
    parts,
    write: (line) => lines.push(line),
    now: () => clock,
  });
  return {
    lines,
    progress,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function parsed(line: string): Record<string, number> {
  expect(line.startsWith("@@bara-progress ")).toBe(true);
  return JSON.parse(line.slice("@@bara-progress ".length));
}

describe("formatProgressLine", () => {
  test("정확한 바이트 형식", () => {
    expect(formatProgressLine({ part: 2, parts: 4, loaded: 10, total: 100 })).toBe(
      '@@bara-progress {"part":2,"parts":4,"loaded":10,"total":100}',
    );
  });

  test("한 줄이며 개행을 포함하지 않는다", () => {
    expect(formatProgressLine({ part: 1, parts: 1, loaded: 0, total: 0 })).not.toContain("\n");
  });
});

describe("throttle", () => {
  test("500ms 안의 갱신은 건너뛰고 지나면 다시 낸다", () => {
    const h = harness(1);
    const part = h.progress.startPart(1);
    part.setFile("a", 10, 100);
    expect(h.lines).toHaveLength(1);
    h.advance(PROGRESS_THROTTLE_MS - 1);
    part.setFile("a", 20, 100);
    expect(h.lines).toHaveLength(1);
    h.advance(1);
    part.setFile("a", 30, 100);
    expect(h.lines).toHaveLength(2);
    expect(parsed(h.lines[1]!).loaded).toBe(30);
  });

  test("새 단계의 첫 줄은 앞 단계의 마지막 줄 직후라도 바로 나가고, 그 뒤로 다시 500ms 를 지킨다", () => {
    const h = harness(2);
    const p1 = h.progress.startPart(1);
    p1.setFile("a", 5, 10);
    p1.finish();
    const p2 = h.progress.startPart(2);
    p2.setFile("b", 1, 10);
    // p1 의 마지막 줄과 같은 시각이어도 새 단계의 첫 줄은 나간다(화면이 앞 단계에 머물지 않게).
    expect(h.lines.map((line) => parsed(line).part)).toEqual([1, 1, 2]);
    p2.setFile("b", 2, 10);
    expect(h.lines).toHaveLength(3);
    h.advance(PROGRESS_THROTTLE_MS);
    p2.setFile("b", 3, 10);
    expect(h.lines).toHaveLength(4);
  });
});

describe("켜기", () => {
  test("Pet 설치 프로그램이 BARA_INSTALL_PROGRESS=1 을 줄 때만 진행 줄을 낸다", () => {
    expect(PROGRESS_ENV).toBe("BARA_INSTALL_PROGRESS");
    expect(progressLinesEnabled({ BARA_INSTALL_PROGRESS: "1" })).toBe(true);
    for (const env of [{}, { BARA_INSTALL_PROGRESS: "0" }, { BARA_INSTALL_PROGRESS: "true" }, { BARA_INSTALL_PROGRESS: "" }]) {
      expect(progressLinesEnabled(env)).toBe(false);
    }
  });
});

describe("final line", () => {
  test("throttle 창 안이어도 마지막 줄은 항상 나가고 L == T 이다", () => {
    const h = harness(1);
    const part = h.progress.startPart(1);
    part.setFile("a", 40, 100);
    h.advance(10);
    part.setFile("a", 99, 100);
    expect(h.lines).toHaveLength(1);
    part.finish();
    expect(h.lines).toHaveLength(2);
    expect(parsed(h.lines[1]!)).toEqual({ part: 1, parts: 1, loaded: 100, total: 100 });
  });

  test("진행 보고가 전혀 없던(캐시된) 단계는 L=T=0 마지막 줄 하나만 낸다", () => {
    const h = harness(4);
    h.progress.startPart(3).finish();
    expect(h.lines).toEqual(['@@bara-progress {"part":3,"parts":4,"loaded":0,"total":0}']);
  });

  test("done 이벤트는 총량을 아는 파일을 가득 찬 것으로 맞춘다", () => {
    const h = harness(1);
    const part = h.progress.startPart(1);
    part.onProgress({ status: "progress", name: "m", file: "w.onnx", loaded: 50, total: 100 });
    h.advance(PROGRESS_THROTTLE_MS);
    part.onProgress({ status: "done", name: "m", file: "w.onnx" });
    expect(parsed(h.lines.at(-1)!)).toMatchObject({ loaded: 100, total: 100 });
  });
});

describe("합산", () => {
  test("여러 파일의 loaded/total 을 더한다", () => {
    const h = harness(2);
    const part = h.progress.startPart(2);
    part.onProgress({ status: "progress", name: "m", file: "a", loaded: 10, total: 100 });
    h.advance(PROGRESS_THROTTLE_MS);
    part.onProgress({ status: "progress", name: "m", file: "b", loaded: 5, total: 50 });
    expect(parsed(h.lines.at(-1)!)).toEqual({ part: 2, parts: 2, loaded: 15, total: 150 });
    h.advance(PROGRESS_THROTTLE_MS);
    // 같은 파일의 갱신은 더하지 않고 덮어쓴다.
    part.onProgress({ status: "progress", name: "m", file: "a", loaded: 60, total: 100 });
    expect(parsed(h.lines.at(-1)!)).toMatchObject({ loaded: 65, total: 150 });
  });

  test("progress 가 아닌 상태와 파일명이 없는 이벤트는 무시한다", () => {
    const h = harness(1);
    const part = h.progress.startPart(1);
    part.onProgress({ status: "initiate", name: "m", file: "a" });
    part.onProgress({ status: "download", name: "m", file: "a" });
    part.onProgress({ status: "progress_total", name: "m", loaded: 9, total: 9 });
    part.onProgress({ status: "ready" });
    expect(h.lines).toHaveLength(0);
  });
});

describe("총량을 모를 때와 값 정리", () => {
  test("total 이 0 이면 L 은 받은 만큼 보고한다(L 이 T 를 넘을 수 있음)", () => {
    const h = harness(1);
    const part = h.progress.startPart(1);
    part.setFile("a", 1234, 0);
    expect(parsed(h.lines[0]!)).toEqual({ part: 1, parts: 1, loaded: 1234, total: 0 });
    part.finish();
    expect(parsed(h.lines[1]!)).toEqual({ part: 1, parts: 1, loaded: 1234, total: 0 });
  });

  test("총량을 아는 동안에는 L 이 T 를 넘지 않는다", () => {
    const h = harness(1);
    const part = h.progress.startPart(1);
    part.setFile("a", 150, 100);
    part.setFile("unknown", 40, 0);
    h.advance(PROGRESS_THROTTLE_MS);
    part.setFile("a", 150, 100);
    expect(parsed(h.lines.at(-1)!)).toEqual({ part: 1, parts: 1, loaded: 100, total: 100 });
    part.finish();
    expect(parsed(h.lines.at(-1)!)).toEqual({ part: 1, parts: 1, loaded: 100, total: 100 });
  });

  test("음수·NaN·Infinity·소수는 안전 정수로 정리한다", () => {
    const h = harness(1);
    const part = h.progress.startPart(1);
    part.setFile("a", Number.NaN, Number.POSITIVE_INFINITY);
    part.setFile("b", -5, -1);
    part.setFile("c", 7.9, 10.2);
    h.advance(PROGRESS_THROTTLE_MS);
    part.setFile("c", 7.9, 10.2);
    const last = parsed(h.lines.at(-1)!);
    expect(last).toEqual({ part: 1, parts: 1, loaded: 7, total: 10 });
    expect(Number.isSafeInteger(last.loaded)).toBe(true);
    expect(Number.isSafeInteger(last.total)).toBe(true);
  });
});

describe("인자 검증", () => {
  test("parts 는 1..10 정수여야 한다", () => {
    const write = () => {};
    expect(() => createInstallProgress({ parts: 0, write })).toThrow(RangeError);
    expect(() => createInstallProgress({ parts: 11, write })).toThrow(RangeError);
    expect(() => createInstallProgress({ parts: 1.5, write })).toThrow(RangeError);
    expect(() => createInstallProgress({ parts: 10, write })).not.toThrow();
  });

  test("part 는 1..parts 범위여야 한다", () => {
    const h = harness(2);
    expect(() => h.progress.startPart(0)).toThrow(RangeError);
    expect(() => h.progress.startPart(3)).toThrow(RangeError);
  });
});
