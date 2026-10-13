/**
 * person-link-prefilter.test.ts — 결정적 top-K 사전 필터 검증 (spec 4.A-7).
 *
 * 순수 함수 데이터 fixture — DB·mock 0. LLM 호출 전 노드별 후보 사람을 이름/별칭/라벨
 * 문자열 매칭으로 소수(top-K)로 좁히는지, 결정성(같은 입력이면 같은 결과·같은 순서),
 * K 상한 준수, 매칭 0 인 노드의 빈 후보를 검증한다.
 */

import { expect, test } from "bun:test";
import {
  prefilterPersonCandidates,
  type PrefilterNode,
  type PrefilterPerson,
} from "./person-link-prefilter.ts";

function person(
  personId: string,
  displayName: string,
  aliases: string[] = [],
  labels: string[] = [],
): PrefilterPerson {
  return { personId, displayName, aliases, labels };
}

function node(id: number, content: string, personCandidates: string[] = []): PrefilterNode {
  return { id, content, personCandidates };
}

test("이름이 후보 문자열과 일치하면 그 사람을 top-K 에 넣는다", () => {
  const people = [person("psn_a", "민수"), person("psn_b", "지현")];
  const result = prefilterPersonCandidates([node(1, "회의 메모", ["민수"])], people, 5);
  expect(result.get(1)).toEqual(["psn_a"]);
});

test("별칭·라벨 매칭도 후보로 잡는다", () => {
  const people = [
    person("psn_a", "김민수", ["민수"]),
    person("psn_b", "박지현", [], ["디자이너"]),
  ];
  const result = prefilterPersonCandidates(
    [
      node(1, "본문", ["민수"]),
      node(2, "디자이너와 논의", []),
    ],
    people,
    5,
  );
  expect(result.get(1)).toEqual(["psn_a"]);
  expect(result.get(2)).toEqual(["psn_b"]);
});

test("본문(content)에 이름이 등장하면 후보 매칭 없이도 잡는다", () => {
  const people = [person("psn_a", "민수")];
  const result = prefilterPersonCandidates([node(1, "오늘 민수를 만났다", [])], people, 5);
  expect(result.get(1)).toEqual(["psn_a"]);
});

test("매칭되는 사람이 없으면 그 노드는 빈 후보", () => {
  const people = [person("psn_a", "민수")];
  const result = prefilterPersonCandidates([node(1, "아무도 없는 메모", ["철수"])], people, 5);
  expect(result.get(1)).toEqual([]);
});

test("후보가 K 를 넘으면 top-K 로 자른다(결정적 순서)", () => {
  // 다섯 사람이 모두 '민' 별칭을 공유 — 후보 문자열 '민' 하나에 다섯이 매칭.
  const people = [
    person("psn_5", "민오", ["민"]),
    person("psn_1", "민일", ["민"]),
    person("psn_3", "민삼", ["민"]),
    person("psn_2", "민이", ["민"]),
    person("psn_4", "민사", ["민"]),
  ];
  const result = prefilterPersonCandidates([node(1, "본문", ["민"])], people, 3);
  const top = result.get(1)!;
  expect(top).toHaveLength(3);
  // 결정적 — personId 오름차순 상위 K.
  expect(top).toEqual(["psn_1", "psn_2", "psn_3"]);
});

test("같은 입력이면 같은 결과·같은 순서(결정성)", () => {
  const people = [person("psn_a", "민수"), person("psn_b", "민수", ["민수"])];
  const nodes = [node(1, "민수 이야기", ["민수"])];
  const a = prefilterPersonCandidates(nodes, people, 5);
  const b = prefilterPersonCandidates(nodes, people, 5);
  expect([...a.get(1)!]).toEqual([...b.get(1)!]);
});

test("여러 노드 각각 독립적으로 좁힌다", () => {
  const people = [person("psn_a", "민수"), person("psn_b", "지현")];
  const result = prefilterPersonCandidates(
    [
      node(1, "민수 메모", ["민수"]),
      node(2, "지현 메모", ["지현"]),
      node(3, "무관", ["누구"]),
    ],
    people,
    5,
  );
  expect(result.get(1)).toEqual(["psn_a"]);
  expect(result.get(2)).toEqual(["psn_b"]);
  expect(result.get(3)).toEqual([]);
});

test("한 노드에 여러 사람이 매칭되면 전원(K 이내)을 후보로 남긴다", () => {
  const people = [
    person("psn_a", "민수 A", ["민수"]),
    person("psn_b", "민수 B", ["민수"]),
  ];
  const result = prefilterPersonCandidates([node(1, "민수 이야기", ["민수"])], people, 5);
  expect(result.get(1)!.sort()).toEqual(["psn_a", "psn_b"]);
});
