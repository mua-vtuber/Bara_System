/**
 * synonym-user-repo.test.ts — SynonymUserRepo CRUD 통합 검증 (웨이브3 항목12 B1).
 *
 * 실제 :memory: SQLite(openMemoryDatabase — v22 synonym_user_entries 보유) 위에서
 * add → list → delete 왕복과 UNIQUE(term, synonym, lang) 멱등을 검증한다. mock 객체
 * 안 만든다(실제 구현체만·데이터 fixture·실 DB). 멱등 add = 같은 (term, synonym,
 * lang) 두 번 추가 시 행 1개 유지 + 기존 id 반환.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SynonymUserRepo } from "./synonym-user-repo.ts";

describe("SynonymUserRepo — CRUD", () => {
  let db: Database;
  let repo: SynonymUserRepo;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    repo = new SynonymUserRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  test("addEntry 반환 id 는 syn_user_ 접두 + list 에 보임", () => {
    const id = repo.addEntry({ term: "고양이", synonym: "냥이", lang: "ko" });
    expect(id.startsWith("syn_user_")).toBe(true);

    const list = repo.listEntries();
    expect(list.length).toBe(1);
    const e = list[0]!;
    expect(e.entryId).toBe(id);
    expect(e.term).toBe("고양이");
    expect(e.synonym).toBe("냥이");
    expect(e.lang).toBe("ko");
    expect(typeof e.createdAt).toBe("string");
  });

  test("lang 미지정 시 'ko' default", () => {
    const id = repo.addEntry({ term: "강아지", synonym: "멍멍이" });
    const e = repo.listEntries().find((x) => x.entryId === id)!;
    expect(e.lang).toBe("ko");
  });

  test("UNIQUE(term, synonym, lang) 중복 add 는 멱등 — 행 1개 + 같은 id 반환", () => {
    const first = repo.addEntry({ term: "고양이", synonym: "냥이", lang: "ko" });
    const second = repo.addEntry({ term: "고양이", synonym: "냥이", lang: "ko" });
    expect(second).toBe(first);
    expect(repo.listEntries().length).toBe(1);
  });

  test("같은 term+synonym 라도 lang 다르면 별개 행", () => {
    repo.addEntry({ term: "cat", synonym: "kitty", lang: "en" });
    repo.addEntry({ term: "cat", synonym: "kitty", lang: "ko" });
    expect(repo.listEntries().length).toBe(2);
  });

  test("같은 term 라도 synonym 다르면 별개 행", () => {
    repo.addEntry({ term: "고양이", synonym: "냥이", lang: "ko" });
    repo.addEntry({ term: "고양이", synonym: "야옹이", lang: "ko" });
    expect(repo.listEntries().length).toBe(2);
  });

  test("deleteEntry 가 행을 제거", () => {
    const id = repo.addEntry({ term: "삭제대상", synonym: "지움", lang: "ko" });
    expect(repo.listEntries().length).toBe(1);
    repo.deleteEntry(id);
    expect(repo.listEntries().length).toBe(0);
  });

  test("없는 id 삭제는 멱등(에러 아님)", () => {
    expect(() => repo.deleteEntry("syn_user_does_not_exist")).not.toThrow();
  });

  test("listEntries 는 created_at 오름차순 정렬", () => {
    const a = repo.addEntry({ term: "가", synonym: "ga", lang: "ko" });
    const b = repo.addEntry({ term: "나", synonym: "na", lang: "ko" });
    const c = repo.addEntry({ term: "다", synonym: "da", lang: "ko" });
    const ids = repo.listEntries().map((e) => e.entryId);
    // lexicographic created_at 비교가 곧 시간 순서 — 추가 순서 보존.
    expect(ids).toEqual([a, b, c]);
  });
});
