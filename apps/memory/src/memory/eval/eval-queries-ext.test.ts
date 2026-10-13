/**
 * memory/eval/eval-queries-ext.test.ts — 확장 손 정답 셋 무결성 (T2 / spec 5-1).
 *
 * 모델·DB 없이 fixture 데이터만 검사하는 순수 테스트다. 임베딩을 안 부르므로
 * default 스위트에 속한다(scripts/test-suite.ts PURE_EVAL_TESTS 등재).
 *
 * 여기서 잡으려는 것은 "정답이 코퍼스를 벗어나는" 조용한 부패다. 줄번호로 라벨링한
 * 정답은 코퍼스에 줄을 넣거나 빼면 아무 소리 없이 엉뚱한 줄을 가리키게 되고,
 * 그러면 baseline 수치는 멀쩡해 보이는데 측정 대상이 딴 데로 가 있게 된다.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVAL_QUERIES_EXT,
  type EvalQueryKind,
} from "../../../test-fixtures/sandbox/eval-queries-ext.ts";
import { EVAL_QUERIES } from "../../../test-fixtures/sandbox/eval-queries.ts";
import { EXT_CORPUS_PATH } from "./harness.ts";

/** 코퍼스를 harness 와 동일 규칙으로 읽는다(공백 줄 제거 후 1-based). */
function readCorpusLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 동결분 코퍼스 — 정답 줄번호가 범위를 벗어나지 않는지만 확인(내용 불변경). */
const BASE_CORPUS_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "test-fixtures",
  "sandbox",
  "embedding-corpus.txt",
);

const extLines = readCorpusLines(EXT_CORPUS_PATH);

describe("확장 손 정답 셋 — 무결성", () => {
  test("전체 손 정답 문항 수가 50건 이상 (기존 10 + 확장 42)", () => {
    expect(EVAL_QUERIES.length).toBe(10); // 동결분
    expect(EVAL_QUERIES_EXT.length).toBe(42);
    expect(EVAL_QUERIES.length + EVAL_QUERIES_EXT.length).toBeGreaterThanOrEqual(50);
  });

  test("모든 정답 줄번호가 확장 코퍼스에 실재 (dangling 참조 0건)", () => {
    const dangling: string[] = [];
    for (const q of EVAL_QUERIES_EXT) {
      for (const group of q.groups) {
        for (const line of group) {
          if (!Number.isInteger(line) || line < 1 || line > extLines.length) {
            dangling.push(`${q.id}: 줄 ${line} (코퍼스 ${extLines.length}줄)`);
          }
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  test("기존 Q1~Q10 정답 줄번호도 원본 코퍼스 범위 안 (동결분 dangling 검사)", () => {
    const baseLines = readCorpusLines(BASE_CORPUS_PATH);
    const dangling: string[] = [];
    for (const q of EVAL_QUERIES) {
      for (const line of q.answers) {
        if (line < 1 || line > baseLines.length) {
          dangling.push(`${q.id}: 줄 ${line} (코퍼스 ${baseLines.length}줄)`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  test("문항 id 중복 없음", () => {
    const ids = EVAL_QUERIES_EXT.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("확장 코퍼스에 중복 줄 없음 (content_hash 흡수로 줄→노드 매핑이 어긋나는 것 차단)", () => {
    // harness-flat.ts loadCorpus 주석 참조 — 같은 정규화 content 는 한 노드로
    // 흡수돼 여러 줄이 같은 노드 id 를 갖게 되고, 그러면 정답 매핑이 뒤틀린다.
    const seen = new Map<string, number>();
    const dups: string[] = [];
    extLines.forEach((line, i) => {
      const prev = seen.get(line);
      if (prev !== undefined) dups.push(`줄 ${prev + 1} == 줄 ${i + 1}: ${line}`);
      else seen.set(line, i);
    });
    expect(dups).toEqual([]);
  });

  test("정답 있는 문항은 그룹이 비지 않음 / unanswerable 은 그룹 0개", () => {
    for (const q of EVAL_QUERIES_EXT) {
      if (q.kind === "unanswerable") {
        expect(q.groups).toEqual([]);
      } else {
        expect(q.groups.length).toBeGreaterThan(0);
        for (const group of q.groups) expect(group.length).toBeGreaterThan(0);
      }
    }
  });

  test("질의 성질 7종이 모두 대표되고 어느 하나로 쏠리지 않음", () => {
    const kinds: EvalQueryKind[] = [
      "exact-keyword",
      "semantic-paraphrase",
      "entity-centric",
      "temporal",
      "preference-decision",
      "mixed-script-technical",
      "unanswerable",
    ];
    const counts = new Map<EvalQueryKind, number>();
    for (const q of EVAL_QUERIES_EXT) {
      counts.set(q.kind, (counts.get(q.kind) ?? 0) + 1);
    }
    for (const kind of kinds) {
      // 성질마다 최소 3문항 — 1~2문항이면 그 성질의 평균이 잡음에 좌우된다.
      expect(counts.get(kind) ?? 0).toBeGreaterThanOrEqual(3);
    }
    // 한 성질이 전체의 절반을 넘으면 baseline 이 그 성질만 대변하게 된다.
    for (const [, count] of counts) {
      expect(count).toBeLessThan(EVAL_QUERIES_EXT.length / 2);
    }
  });

  test("semantic-paraphrase 문항은 정답 줄과 겹치는 글자 토큰이 없음 (벡터 채널 몫임을 보장)", () => {
    // 글자가 겹치면 FTS 채널이 잡아버려서 '의미 환언' 측정이 아니게 된다.
    const leaked: string[] = [];
    for (const q of EVAL_QUERIES_EXT.filter((x) => x.kind === "semantic-paraphrase")) {
      const queryTokens = new Set(
        q.query.split(/\s+/).map((t) => t.replace(/[?!.,]/g, "")).filter((t) => t.length >= 2),
      );
      for (const group of q.groups) {
        for (const line of group) {
          const lineText = extLines[line - 1]!;
          for (const token of queryTokens) {
            if (lineText.includes(token)) {
              leaked.push(`${q.id}: "${token}" 가 정답 줄 ${line} 에 그대로 있음`);
            }
          }
        }
      }
    }
    expect(leaked).toEqual([]);
  });
});
