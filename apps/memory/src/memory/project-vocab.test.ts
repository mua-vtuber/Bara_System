import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openMemoryDatabase } from "../db/migrations.ts";
import type { Database } from "bun:sqlite";
import { loadProjectVocab, expandQueryWithProjectVocab } from "./project-vocab.ts";

let db: Database;
beforeAll(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  db.prepare("INSERT INTO project_vocabularies(project_id, term, expanded_meaning, added_by) VALUES(?,?,?,?)")
    .run("bara_system", "cleanup", "메모리 정리 AI", "user-banjjagi");
});
afterAll(() => db.close());

describe("project_vocabularies expansion (D8)", () => {
  test("loadProjectVocab — 프로젝트 어휘 매핑 읽기", () => {
    const vocab = loadProjectVocab(db, "bara_system");
    expect(vocab.get("cleanup")).toBe("메모리 정리 AI");
  });
  test("expandQueryWithProjectVocab — 매치 토큰의 의미를 더한다", () => {
    const vocab = loadProjectVocab(db, "bara_system");
    expect(expandQueryWithProjectVocab("cleanup 작업", vocab)).toContain("메모리 정리 AI");
  });
  test("미존재 project → 빈 Map → 원본 query(자연 degrade)", () => {
    const vocab = loadProjectVocab(db, "unknown");
    expect(vocab.size).toBe(0);
    expect(expandQueryWithProjectVocab("cleanup 작업", vocab)).toBe("cleanup 작업");
  });
});
