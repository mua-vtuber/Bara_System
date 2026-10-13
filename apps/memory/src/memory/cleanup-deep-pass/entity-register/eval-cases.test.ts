import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadEvalFixture } from "./eval-scoring.ts";
import { normalizeName } from "./name-match.ts";

const fixture = loadEvalFixture(join(import.meta.dir, "../../../../test-fixtures/entity-register/cases.json"));

test("the 40 memos of the 2026-10-10 spike are all here, 19 real and 21 synthetic", () => {
  expect(fixture.cases.map((c) => c.id)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  expect(fixture.cases.filter((c) => c.src === "real")).toHaveLength(19);
});

test("every expected name and date phrase is written in its memo (so the judge can accept it)", () => {
  for (const c of fixture.cases) {
    const text = normalizeName(c.text);
    for (const e of c.expect.entities) expect(e.names.some((n) => text.includes(normalizeName(n)))).toBe(true);
    for (const t of c.expect.schedule?.dateTexts ?? []) expect(text).toContain(normalizeName(t));
    expect(c.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  }
});

test("case 16 carries the user-confirmed answer: person 몽룡, whose real name is 이몽룡", () => {
  const c16 = fixture.cases.find((c) => c.id === 16)!;
  expect(c16.expect.entities).toEqual([{ types: ["person"], names: ["몽룡"] }]);
  expect(fixture.existing.some((e) => e.typeName === "person" && e.name === "이몽룡")).toBe(true);
});
