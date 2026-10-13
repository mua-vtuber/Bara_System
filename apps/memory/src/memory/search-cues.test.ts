/**
 * search-cues.test.ts — 정규식 cue 검출 순수 함수 + yaml 로더 (공통 인프라 1.1c T2).
 *
 * 순수 함수 검증(데이터 입력→출력) — mock 0. cue 가중치 상수는 search-tuning.ts
 * 에서 가져와 리터럴 직접 기재를 피한다(검출 결과가 그 상수와 같은지 단언).
 *
 * 로더는 임시 yaml 파일을 써서 검증한다(파일 없음 → builtin 만 / 형식 어긋남
 * → 구체 에러 / 추가 어휘 합집합). 실제 운영 search-cues.yaml(빈 추가 어휘)도 로드.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCues, type SearchCues } from "./search-cues.ts";
import { loadSearchCues } from "./search-cues-loader.ts";
import {
  RELATION_CUE_GRAPH_BOOST,
  TOPIC_CUE_GRAPH_BOOST,
} from "./search-tuning.ts";

const SEED = join(import.meta.dir, "search-cues.yaml");

describe("detectCues — 정규식 cue 검출 순수 함수", () => {
  test("관계 cue 검출 → graph 가중치 RELATION_CUE_GRAPH_BOOST", () => {
    const r = detectCues("그 테마로 왜 바꿨더라");
    expect(r.relation).toBe(true);
    expect(r.topic).toBe(false);
    expect(r.graphBoost).toBe(RELATION_CUE_GRAPH_BOOST);
  });

  test("관계 cue 어휘 각각 검출(이유·의도·변경·결정·바꾼·어떻게)", () => {
    for (const q of [
      "그렇게 한 이유",
      "그 의도가 뭐였지",
      "설정 변경 내역",
      "최종 결정 사항",
      "이름을 바꾼 노드",
      "어떻게 처리했더라",
    ]) {
      expect(detectCues(q).relation).toBe(true);
    }
  });

  test("주제 cue 검출 → graph 가중치 TOPIC_CUE_GRAPH_BOOST", () => {
    const r = detectCues("디자인 관련 자산 전체");
    expect(r.topic).toBe(true);
    expect(r.relation).toBe(false);
    expect(r.graphBoost).toBe(TOPIC_CUE_GRAPH_BOOST);
  });

  test("주제 cue 어휘 각각 검출(모두·전부·모든)", () => {
    for (const q of ["모두 보여줘", "전부 정리", "모든 결과"]) {
      // "정리"·"결과" 등에 관계 cue 가 없으면 주제 cue 만 매치.
      const r = detectCues(q);
      expect(r.topic).toBe(true);
    }
  });

  test("관계·주제 둘 다 매치 → 관계 cue 값 우선", () => {
    // "왜"(관계) + "전체"(주제) — 관계 cue 가 더 강한 신호라 그 값을 택한다.
    // 2026-07-10 둘 다 한 결정으로 묶어 중립 1.0 으로 중립화돼 값은 같지만,
    // 우선순위 규칙 자체는 유지된다(≥ — search-tuning.ts 이력 주석).
    const r = detectCues("그 결정 전체를 왜 바꿨더라");
    expect(r.relation).toBe(true);
    expect(r.topic).toBe(true);
    expect(r.graphBoost).toBe(RELATION_CUE_GRAPH_BOOST);
    expect(RELATION_CUE_GRAPH_BOOST).toBeGreaterThanOrEqual(TOPIC_CUE_GRAPH_BOOST);
  });

  test("cue 없음 → 중립 1.0(현행 동작)", () => {
    const r = detectCues("주술회전 최강자의 필살기 이름");
    expect(r.relation).toBe(false);
    expect(r.topic).toBe(false);
    expect(r.graphBoost).toBe(1.0);
  });

  test("yaml 추가 어휘가 검출에 합류(builtin 외)", () => {
    const extra: SearchCues = {
      relation: [/수정한/],
      topic: [/싹/],
    };
    // builtin 에 없는 "수정한" 이 추가 관계 cue 로 매치.
    expect(detectCues("그 코드 수정한 부분", extra).relation).toBe(true);
    // builtin 에 없는 "싹" 이 추가 주제 cue 로 매치.
    expect(detectCues("싹 정리해줘", extra).topic).toBe(true);
    // 추가 어휘에도 없는 query 는 여전히 중립.
    expect(detectCues("그냥 평범한 검색어", extra).graphBoost).toBe(1.0);
  });

  test("순수 함수 — query 토큰 불변(query 문자열을 안 건드린다)", () => {
    const q = "그 테마로 왜 바꿨더라";
    detectCues(q);
    // detectCues 는 query 를 반환·변형하지 않는다 — 원본 그대로 보존.
    expect(q).toBe("그 테마로 왜 바꿨더라");
  });
});

describe("loadSearchCues — yaml 로더(synonym 로더 패턴)", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  test("운영 search-cues.yaml 로드 — 빈 추가 어휘(builtin 만 가동)", () => {
    const cues = loadSearchCues(SEED);
    expect(cues.relation).toEqual([]);
    expect(cues.topic).toEqual([]);
  });

  test("파일 없음 → builtin 만(빈 SearchCues / 에러 아님 — 자연 degrade)", () => {
    const cues = loadSearchCues(join(tmpdir(), "search-cues-does-not-exist-xyz.yaml"));
    expect(cues.relation).toEqual([]);
    expect(cues.topic).toEqual([]);
  });

  test("추가 어휘 yaml 로드 → 합집합 정규식 컴파일", () => {
    tmp = mkdtempSync(join(tmpdir(), "search-cues-"));
    const p = join(tmp, "cues.yaml");
    writeFileSync(p, "relation:\n  - 수정한\n  - 고쳤\ntopic:\n  - 통째로\n", "utf8");
    const cues = loadSearchCues(p);
    expect(cues.relation.length).toBe(2);
    expect(cues.topic.length).toBe(1);
    expect(cues.relation[0]!.test("수정한 코드")).toBe(true);
    expect(cues.topic[0]!.test("통째로 정리")).toBe(true);
  });

  test("형식 어긋남(relation 이 목록 아님) → 구체 에러 throw", () => {
    tmp = mkdtempSync(join(tmpdir(), "search-cues-"));
    const p = join(tmp, "bad.yaml");
    writeFileSync(p, "relation: 수정한\n", "utf8"); // 목록이 아님
    expect(() => loadSearchCues(p)).toThrow(/relation.*목록이 아님/);
  });

  test("형식 어긋남(정규식 컴파일 실패) → 구체 에러 throw", () => {
    tmp = mkdtempSync(join(tmpdir(), "search-cues-"));
    const p = join(tmp, "badregex.yaml");
    writeFileSync(p, "relation:\n  - \"[\"\n", "utf8"); // 깨진 정규식
    expect(() => loadSearchCues(p)).toThrow(/정규식 컴파일 실패/);
  });

  test("빈 파일(null) → builtin 만(빈 SearchCues)", () => {
    tmp = mkdtempSync(join(tmpdir(), "search-cues-"));
    const p = join(tmp, "empty.yaml");
    writeFileSync(p, "", "utf8");
    const cues = loadSearchCues(p);
    expect(cues.relation).toEqual([]);
    expect(cues.topic).toEqual([]);
  });
});
