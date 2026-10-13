/**
 * relation-vocab-loader.test.ts — 관계 어휘 yaml 기본 씨앗 로더 동행 테스트 (분류 단계3 T7a).
 *
 * 핵심 회귀 가드: 운영 relation_vocabulary.yaml 의 씨앗 == 코드 상수 SEED_RELATION_TAG_KEYS
 * 10개를 기계로 대조한다. 동결 해제 후에도 기본 7 관계명·10 태그 키가 안 바뀜을 증명한다.
 *
 * Mock 0 — 실제 yaml 로더를 읽어 코드 상수와 대조만 한다.
 */

import { describe, expect, test } from "bun:test";
import {
  loadRelationVocabularySeed,
  parseRelationVocabulary,
  resetRelationVocabSeedCache,
} from "./relation-vocab-loader.ts";
import {
  SEED_RELATION_TAG_KEYS,
  SEED_RELATION_NAMES,
} from "../entity-relation-vocabulary.ts";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadRelationVocabularySeed — 운영 yaml 씨앗 == 코드 상수(회귀 0)", () => {
  resetRelationVocabSeedCache();
  const seed = loadRelationVocabularySeed();

  test("씨앗 키 == SEED_RELATION_TAG_KEYS 키(10개·창작자 동의어 3 포함)", () => {
    expect([...seed.keys()].sort()).toEqual(Object.keys(SEED_RELATION_TAG_KEYS).sort());
  });

  test("각 씨앗 키의 relation·source·target·defaultTarget 가 코드 상수와 동일", () => {
    for (const [key, codeSpec] of Object.entries(SEED_RELATION_TAG_KEYS)) {
      const yamlSpec = seed.get(key);
      expect(yamlSpec).toBeDefined();
      expect(yamlSpec!.relation).toBe(codeSpec.relation);
      expect([...yamlSpec!.sourceTypes].sort()).toEqual([...codeSpec.sourceTypes].sort());
      expect([...yamlSpec!.targetTypes].sort()).toEqual([...codeSpec.targetTypes].sort());
      expect(yamlSpec!.defaultTargetType).toBe(codeSpec.defaultTargetType);
    }
  });

  test("씨앗이 만드는 관계명 == SEED_RELATION_NAMES 7개", () => {
    const relNames = new Set([...seed.values()].map((s) => s.relation));
    expect([...relNames].sort()).toEqual([...SEED_RELATION_NAMES].sort());
  });

  test("창작자 동의어 네 키가 모두 created_by work→person", () => {
    for (const key of ["창작자", "제작자", "작가", "만든사람"]) {
      const spec = seed.get(key);
      expect(spec?.relation).toBe("created_by");
      expect([...(spec?.sourceTypes ?? [])]).toEqual(["work"]);
      expect([...(spec?.targetTypes ?? [])]).toEqual(["person"]);
    }
  });
});

describe("parseRelationVocabulary — 형식 검증(silent fallback 0)", () => {
  function withTempYaml(body: string, fn: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "relvocab-"));
    const path = join(dir, "relation_vocabulary.yaml");
    try {
      writeFileSync(path, body, "utf8");
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("relations 절 없으면 throw", () => {
    withTempYaml("tag_keys: {}\n", (path) => {
      expect(() => parseRelationVocabulary(path)).toThrow(/relations/);
    });
  });

  test("tag_keys 절 없으면 throw", () => {
    withTempYaml("relations: {}\n", (path) => {
      expect(() => parseRelationVocabulary(path)).toThrow(/tag_keys/);
    });
  });

  test("tag_keys 가 relations 에 없는 관계명을 가리키면 throw(식별자 담음)", () => {
    withTempYaml(
      "relations:\n  created_by:\n    sourceTypes: [work]\n    targetTypes: [person]\n    defaultTargetType: person\n" +
        "tag_keys:\n  창작자: nonexistent_relation\n",
      (path) => {
        expect(() => parseRelationVocabulary(path)).toThrow(/nonexistent_relation/);
      },
    );
  });

  test("defaultTargetType 가 targetTypes 밖이면 throw(거짓 기본 타입)", () => {
    withTempYaml(
      "relations:\n  x:\n    sourceTypes: [work]\n    targetTypes: [person]\n    defaultTargetType: place\n" +
        "tag_keys:\n  키: x\n",
      (path) => {
        expect(() => parseRelationVocabulary(path)).toThrow(/defaultTargetType/);
      },
    );
  });

  test("sourceTypes 가 문자열 배열 아니면 throw", () => {
    withTempYaml(
      "relations:\n  x:\n    sourceTypes: notarray\n    targetTypes: [person]\n    defaultTargetType: person\n" +
        "tag_keys:\n  키: x\n",
      (path) => {
        expect(() => parseRelationVocabulary(path)).toThrow(/sourceTypes/);
      },
    );
  });
});
