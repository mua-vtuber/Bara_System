/**
 * patterns-loader.test.ts — regex L0 yaml 로더 검증 (Phase 6a T2).
 *
 * loadPatterns / loadBoosters 의 동작을 실제 임시 yaml 파일(Bun.write) + 실제
 * `parse` 로 검증한다. mock 객체·MockFS 류는 만들지 않는다 (프로젝트 규칙).
 *
 * 케이스 가족:
 *   (a) 없는 경로     → builtin 만 (graceful Level 0)
 *   (b) 정상 yaml     → 합집합 (새 id 추가 + 같은 id 덮어쓰기)
 *   (c) 깨진 regex     → 구체 에러 throw (어느 id·어느 문자열인지 명시)
 *   (d) 최상위 배열/스칼라 → 구체 에러 throw
 *   (e) yaml↔ts 동기화 가드 (builtin yaml ↔ BUILTIN_PATTERNS 일치)
 *   booster 동형 케이스 포함.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_BOOSTERS } from "./builtin-boosters.ts";
import { BUILTIN_PATTERNS } from "./builtin-patterns.ts";
import { loadBoosters } from "./booster-loader.ts";
import { loadPatterns } from "./patterns-loader.ts";

/** 임시 작업 디렉토리 — 각 케이스가 자기 yaml 파일을 여기 쓴다. */
let tmpDir: string;

/** builtin yaml 의 실제 경로 (동기화 가드·정상 합집합 케이스에서 로드). */
const here = fileURLToPath(new URL(".", import.meta.url));
const BUILTIN_PATTERNS_YAML = join(here, "regex-patterns.yaml");
const BUILTIN_BOOSTERS_YAML = join(here, "booster-dictionary.yaml");

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "regex-l0-loader-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 임시 yaml 파일 한 장을 쓰고 그 경로를 돌려준다. */
async function writeTmp(name: string, content: string): Promise<string> {
  const path = join(tmpDir, name);
  await Bun.write(path, content);
  return path;
}

describe("loadPatterns", () => {
  test("(a) 없는 경로 → builtin 양식만 반환 (graceful degrade)", () => {
    const result = loadPatterns([join(tmpDir, "does-not-exist.yaml")]);
    const enabledBuiltin = BUILTIN_PATTERNS.filter((p) => p.enabled);
    expect(result.length).toBe(enabledBuiltin.length);
    // builtin id 가 전부 들어 있다.
    const ids = new Set(result.map((p) => p.id));
    for (const b of enabledBuiltin) expect(ids.has(b.id)).toBe(true);
  });

  test("(b) 정상 yaml → 새 id 추가 + 같은 id 덮어쓰기", async () => {
    const yaml = [
      "version: 1",
      "lang: ko",
      "patterns:",
      // 새 id 추가.
      '  - id: "custom_ko_999"',
      '    pattern: "(.{2,40})\\\\s+추가양식"',
      "    score: 2",
      "    category: fact",
      "    polarity: neutral",
      '    description: "사용자 추가 양식"',
      "    enabled: true",
      // 기존 builtin id 덮어쓰기 (score 3 → 1, category decision → status).
      '  - id: "decision_ko_001"',
      '    pattern: "(.{2,40})\\\\s*하기로\\\\s*(?:했|함)"',
      "    score: 1",
      "    category: status",
      "    polarity: neutral",
      '    description: "덮어쓴 양식"',
      "    enabled: true",
    ].join("\n");
    const path = await writeTmp("ok-patterns.yaml", yaml);
    const result = loadPatterns([path]);

    const byId = new Map(result.map((p) => [p.id, p]));
    // 새 id 가 추가됐다.
    expect(byId.has("custom_ko_999")).toBe(true);
    expect(byId.get("custom_ko_999")?.score).toBe(2);
    // 같은 id 는 yaml 이 덮어썼다 (사용자 갱신 우선).
    const overwritten = byId.get("decision_ko_001");
    expect(overwritten?.score).toBe(1);
    expect(overwritten?.category).toBe("status");
    // 합집합 크기 = enabled builtin + 새 id 1 (덮어쓴 건 카운트 안 늘림).
    const enabledBuiltin = BUILTIN_PATTERNS.filter((p) => p.enabled);
    expect(result.length).toBe(enabledBuiltin.length + 1);
  });

  test("(b-2) 더블 백슬래시 정규식이 정상 컴파일된다", async () => {
    const yaml = [
      "patterns:",
      '  - id: "bs_ko_001"',
      '    pattern: "(.{2,40})\\\\s*완료"',
      "    score: 1",
      "    category: status",
      "    enabled: true",
    ].join("\n");
    const path = await writeTmp("backslash-patterns.yaml", yaml);
    const result = loadPatterns([path]);
    const def = result.find((p) => p.id === "bs_ko_001");
    expect(def).toBeDefined();
    // parse 후 \s 단일로 환원된 정규식 문자열.
    expect(def?.pattern).toBe("(.{2,40})\\s*완료");
    // 실제 매치까지 실증. greedy `.{2,40}` 라 첫 그룹이 공백 앞까지 먹는다
    // (`\s*` 가 0개 매치 가능 — 추출 trim 은 후속 T3 매치 단계 책임).
    const m = def?.regex.exec("작업 완료");
    expect(m).not.toBeNull();
    expect(m?.[1]?.trim()).toBe("작업");
  });

  test("(c) 깨진 regex 문자열 → 구체 에러 (id·문자열 명시)", async () => {
    const yaml = [
      "patterns:",
      '  - id: "broken_ko_001"',
      '    pattern: "(미닫힌괄호"',
      "    score: 1",
      "    category: fact",
      "    enabled: true",
    ].join("\n");
    const path = await writeTmp("broken-regex.yaml", yaml);
    expect(() => loadPatterns([path])).toThrow(/broken_ko_001/);
    expect(() => loadPatterns([path])).toThrow(/\(미닫힌괄호/);
  });

  test("(d-1) 최상위가 배열 → 구체 에러", async () => {
    const path = await writeTmp("toplevel-array.yaml", "- a\n- b\n");
    expect(() => loadPatterns([path])).toThrow(/최상위가 매핑이 아님/);
  });

  test("(d-2) 최상위가 스칼라 → 구체 에러", async () => {
    const path = await writeTmp("toplevel-scalar.yaml", "그냥문자열\n");
    expect(() => loadPatterns([path])).toThrow(/최상위가 매핑이 아님/);
  });

  test("(d-3) patterns 가 목록이 아님 → 구체 에러", async () => {
    const path = await writeTmp("patterns-not-list.yaml", "patterns: 그냥값\n");
    expect(() => loadPatterns([path])).toThrow(/'patterns' 값이 목록이 아님/);
  });

  test("(d-4) 필수 칸(pattern) 누락 → 구체 에러", async () => {
    const yaml = [
      "patterns:",
      '  - id: "nopat_ko_001"',
      "    score: 1",
      "    category: fact",
      "    enabled: true",
    ].join("\n");
    const path = await writeTmp("missing-pattern.yaml", yaml);
    expect(() => loadPatterns([path])).toThrow(/nopat_ko_001/);
    expect(() => loadPatterns([path])).toThrow(/pattern/);
  });

  test("enabled: false 양식은 결과에서 제외", async () => {
    const yaml = [
      "patterns:",
      '  - id: "off_ko_001"',
      '    pattern: "(.{2,40})\\\\s+꺼짐"',
      "    score: 1",
      "    category: status",
      "    enabled: false",
    ].join("\n");
    const path = await writeTmp("disabled-pattern.yaml", yaml);
    const result = loadPatterns([path]);
    expect(result.find((p) => p.id === "off_ko_001")).toBeUndefined();
  });

  test("yaml 이 builtin id 를 enabled:false 로 덮으면 builtin 도 빠진다", async () => {
    const yaml = [
      "patterns:",
      '  - id: "decision_ko_001"',
      '    pattern: "(.{2,40})\\\\s*하기로"',
      "    score: 3",
      "    category: decision",
      "    enabled: false",
    ].join("\n");
    const path = await writeTmp("disable-builtin.yaml", yaml);
    const result = loadPatterns([path]);
    expect(result.find((p) => p.id === "decision_ko_001")).toBeUndefined();
  });

  test("(e) 동기화 가드 — builtin yaml ↔ BUILTIN_PATTERNS 일치", () => {
    // 실제 builtin yaml 을 로드. tmp builtin 후보가 없으므로 결과 = builtin
    // 자체(yaml 이 같은 id 를 같은 값으로 덮어쓰니 동일해야 한다).
    const fromYaml = loadPatterns([BUILTIN_PATTERNS_YAML]);
    const byId = new Map(fromYaml.map((p) => [p.id, p]));
    const enabledBuiltin = BUILTIN_PATTERNS.filter((p) => p.enabled);
    // 같은 데이터를 두 곳에 둔 설계 — drift 를 큰 소리로 잡는다.
    expect(fromYaml.length).toBe(enabledBuiltin.length);
    for (const b of enabledBuiltin) {
      const y = byId.get(b.id);
      expect(y, `builtin id "${b.id}" 가 yaml 에 없음 (drift)`).toBeDefined();
      expect(y?.pattern, `id "${b.id}" pattern drift`).toBe(b.pattern);
      expect(y?.score, `id "${b.id}" score drift`).toBe(b.score);
      expect(y?.category, `id "${b.id}" category drift`).toBe(b.category);
      expect(y?.polarity, `id "${b.id}" polarity drift`).toBe(b.polarity);
    }
  });
});

describe("loadBoosters", () => {
  test("(a) 없는 경로 → builtin booster 만 반환 (graceful degrade)", () => {
    const result = loadBoosters([join(tmpDir, "does-not-exist.yaml")]);
    const enabledBuiltin = BUILTIN_BOOSTERS.filter((b) => b.enabled);
    expect(result.length).toBe(enabledBuiltin.length);
  });

  test("(b) 정상 yaml → 새 word 추가 + 같은 word+lang 덮어쓰기", async () => {
    const yaml = [
      "version: 1",
      "lang: ko",
      "boosters:",
      // 새 word 추가.
      '  - word: "꼭"',
      "    score: +2",
      '    description: "사용자 추가 booster"',
      "    enabled: true",
      // 기존 builtin word 덮어쓰기 (앞으로 +3 → +1).
      '  - word: "앞으로"',
      "    score: +1",
      '    description: "덮어쓴 booster"',
      "    enabled: true",
    ].join("\n");
    const path = await writeTmp("ok-boosters.yaml", yaml);
    const result = loadBoosters([path]);
    const byWord = new Map(result.map((b) => [b.word, b]));
    expect(byWord.has("꼭")).toBe(true);
    expect(byWord.get("꼭")?.score).toBe(2);
    // 같은 word+lang 은 yaml 이 덮어썼다.
    expect(byWord.get("앞으로")?.score).toBe(1);
    const enabledBuiltin = BUILTIN_BOOSTERS.filter((b) => b.enabled);
    expect(result.length).toBe(enabledBuiltin.length + 1);
  });

  test("(b-2) +3 / -2 점수가 정수로 읽힌다", async () => {
    const yaml = [
      "boosters:",
      '  - word: "꼭반드시"',
      "    score: +3",
      "    enabled: true",
      '  - word: "대충"',
      "    score: -2",
      "    enabled: true",
    ].join("\n");
    const path = await writeTmp("signed-boosters.yaml", yaml);
    const result = loadBoosters([path]);
    const byWord = new Map(result.map((b) => [b.word, b]));
    expect(byWord.get("꼭반드시")?.score).toBe(3);
    expect(byWord.get("대충")?.score).toBe(-2);
  });

  test("(c) booster 는 RegExp 컴파일 안 함 — 특수문자 word 도 통과", async () => {
    const yaml = [
      "boosters:",
      '  - word: "(미닫힌괄호"',
      "    score: -1",
      "    enabled: true",
    ].join("\n");
    const path = await writeTmp("special-booster.yaml", yaml);
    const result = loadBoosters([path]);
    expect(result.find((b) => b.word === "(미닫힌괄호")).toBeDefined();
  });

  test("(d-1) 최상위가 배열 → 구체 에러", async () => {
    const path = await writeTmp("b-toplevel-array.yaml", "- a\n- b\n");
    expect(() => loadBoosters([path])).toThrow(/최상위가 매핑이 아님/);
  });

  test("(d-2) boosters 가 목록이 아님 → 구체 에러", async () => {
    const path = await writeTmp("b-not-list.yaml", "boosters: 그냥값\n");
    expect(() => loadBoosters([path])).toThrow(/'boosters' 값이 목록이 아님/);
  });

  test("(d-3) 필수 칸(word) 누락 → 구체 에러", async () => {
    const yaml = ["boosters:", "  - score: +1", "    enabled: true"].join("\n");
    const path = await writeTmp("b-missing-word.yaml", yaml);
    expect(() => loadBoosters([path])).toThrow(/word/);
  });

  test("(d-4) score 가 숫자 아님 → 구체 에러", async () => {
    const yaml = [
      "boosters:",
      '  - word: "나쁜점수"',
      '    score: "정수아님"',
      "    enabled: true",
    ].join("\n");
    const path = await writeTmp("b-bad-score.yaml", yaml);
    expect(() => loadBoosters([path])).toThrow(/나쁜점수/);
    expect(() => loadBoosters([path])).toThrow(/score/);
  });

  test("enabled: false booster 는 결과에서 제외", async () => {
    const yaml = [
      "boosters:",
      '  - word: "꺼진단어"',
      "    score: +1",
      "    enabled: false",
    ].join("\n");
    const path = await writeTmp("b-disabled.yaml", yaml);
    const result = loadBoosters([path]);
    expect(result.find((b) => b.word === "꺼진단어")).toBeUndefined();
  });

  test("(e) 동기화 가드 — builtin yaml ↔ BUILTIN_BOOSTERS 일치", () => {
    const fromYaml = loadBoosters([BUILTIN_BOOSTERS_YAML]);
    const byKey = new Map(fromYaml.map((b) => [`${b.word} ${b.lang}`, b]));
    const enabledBuiltin = BUILTIN_BOOSTERS.filter((b) => b.enabled);
    expect(fromYaml.length).toBe(enabledBuiltin.length);
    for (const b of enabledBuiltin) {
      const y = byKey.get(`${b.word} ${b.lang}`);
      expect(y, `builtin booster "${b.word}" 가 yaml 에 없음 (drift)`).toBeDefined();
      expect(y?.score, `booster "${b.word}" score drift`).toBe(b.score);
    }
  });
});
