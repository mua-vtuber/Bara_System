import { describe, test, expect } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadSynonymDictionary, expandTerm } from "./synonym-dictionary";

// import.meta.dir = apps/memory/src/memory → 같은 폴더의 추적 yaml(1.1b DCL-4 이동).
// 옛 경로는 gitignore 된 data/ 를 가리켜 untracked 로컬 의존이던 잠재 결함.
const SEED = join(import.meta.dir, "synonym_dictionary.yaml");

describe("synonym dictionary loader", () => {
  test("시드 yaml 로드 + 동의어 조회", () => {
    const dict = loadSynonymDictionary(SEED);
    expect(dict.get("포근함")).toContain("따뜻함");
    expect(dict.get("회의록")).toContain("미팅노트");
  });

  test("expandTerm — 매치 시 term + 동의어 (중복 제거)", () => {
    const dict = loadSynonymDictionary(SEED);
    const out = expandTerm(dict, "포근함");
    expect(out[0]).toBe("포근함");
    expect(out).toContain("아늑함");
    expect(new Set(out).size).toBe(out.length);
  });

  test("expandTerm — 미스면 [term]만", () => {
    const dict = loadSynonymDictionary(SEED);
    expect(expandTerm(dict, "없는단어")).toEqual(["없는단어"]);
  });

  test("파일 없음 = 구체 에러 (silent fallback X)", () => {
    expect(() => loadSynonymDictionary("/no/such/file.yaml")).toThrow(/파일을 읽지 못함/);
  });

  test("synonyms 키 없는 yaml = 구체 에러", () => {
    const tmp = join(import.meta.dir, "_tmp_bad.yaml");
    writeFileSync(tmp, "other: 1\n");
    try {
      expect(() => loadSynonymDictionary(tmp)).toThrow(/synonyms/);
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});
