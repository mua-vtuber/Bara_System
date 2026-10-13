import { expect, test } from "bun:test";
import { exactMatches, hasFinalConsonant, similarMatches, splitHonorific } from "./name-match.ts";
import type { NameIndexEntry } from "./types.ts";

const PROFILE = {
  honorificSuffixes: ["오빠", "누나", "언니", "선배", "형", "씨", "님", "쌤", "이"],
  finalConsonantSuffixes: ["이"],
};
const person = (id: string, name: string, aliases: string[] = []): NameIndexEntry => ({ typeName: "person", id, name, aliases });

test("final consonant check reads the Hangul syllable", () => {
  expect(hasFinalConsonant("명")).toBe(true);
  expect(hasFinalConsonant("수")).toBe(false);
  expect(hasFinalConsonant("A")).toBe(false);
});

test("honorific split needs a base of two or more letters and a final consonant before 이", () => {
  expect(splitHonorific("민수형", PROFILE, 2)).toEqual({ base: "민수", suffix: "형" });
  expect(splitHonorific("몽룡이", PROFILE, 2)).toEqual({ base: "몽룡", suffix: "이" });
  expect(splitHonorific("민수이", PROFILE, 2)).toBeNull();
  expect(splitHonorific("콩이", PROFILE, 2)).toBeNull();
  expect(splitHonorific("지은", PROFILE, 2)).toBeNull();
});

test("exact match looks at names and aliases after NFC", () => {
  const entries = [person("p1", "이몽룡", ["몽룡"]), person("p2", "민수")];
  expect(exactMatches(entries, "몽룡").map((e) => e.id)).toEqual(["p1"]);
  expect(exactMatches(entries, "민수".normalize("NFD")).map((e) => e.id)).toEqual(["p2"]);
});

test("similar names: prefix or suffix of two letters or more, or an honorific suffix added or removed", () => {
  const entries = [person("p1", "이몽룡"), person("p2", "콩"), person("p3", "민수"), person("p4", "오")];
  expect(similarMatches(entries, "몽룡", PROFILE, 2).map((e) => e.id)).toEqual(["p1"]);
  expect(similarMatches(entries, "몽룡이", PROFILE, 2).map((e) => e.id)).toEqual(["p1"]);
  expect(similarMatches(entries, "콩이", PROFILE, 2).map((e) => e.id)).toEqual(["p2"]);
  expect(similarMatches(entries, "민수형", PROFILE, 2).map((e) => e.id)).toEqual(["p3"]);
  expect(similarMatches(entries, "오리", PROFILE, 2)).toEqual([]);
});
