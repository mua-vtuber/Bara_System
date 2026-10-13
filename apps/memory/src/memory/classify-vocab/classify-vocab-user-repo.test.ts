/**
 * classify-vocab-user-repo.test.ts — ClassifyVocabUserRepo CRUD 통합 검증
 * (분류 어휘 DB 단계1 Task 1).
 *
 * 실제 :memory: SQLite(openMemoryDatabase — v24 classify_vocab_user_entries 보유)
 * 위에서 add → list → delete 왕복과 UNIQUE(type_name, slot, value) 멱등을 검증한다.
 * mock 객체 안 만든다(실제 구현체만·데이터 fixture·실 DB). 멱등 add = 같은
 * (type_name, slot, value) 두 번 추가 시 행 1개 유지 + 기존 id 반환.
 *
 * SynonymUserRepo.test 양식 그대로 미러 — 단지 키가 (term,synonym,lang) 대신
 * (type_name,slot,value) 3차원이다.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { ClassifyVocabUserRepo } from "./classify-vocab-user-repo.ts";

describe("ClassifyVocabUserRepo — CRUD", () => {
  let db: Database;
  let repo: ClassifyVocabUserRepo;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    repo = new ClassifyVocabUserRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  test("addEntry 반환 id 는 cvocab_user_ 접두 + list 에 보인다", () => {
    const id = repo.addEntry({ typeName: "work", slot: "synonyms", value: "창작물" });
    expect(id.startsWith("cvocab_user_")).toBe(true);

    const list = repo.listEntries();
    expect(list.length).toBe(1);
    const e = list[0]!;
    expect(e.entryId).toBe(id);
    expect(e.typeName).toBe("work");
    expect(e.slot).toBe("synonyms");
    expect(e.value).toBe("창작물");
    expect(typeof e.createdAt).toBe("string");
  });

  test("UNIQUE(type_name, slot, value) 중복 add 는 멱등 — 행 1개 + 같은 id 반환", () => {
    const first = repo.addEntry({ typeName: "work", slot: "synonyms", value: "창작물" });
    const second = repo.addEntry({ typeName: "work", slot: "synonyms", value: "창작물" });
    expect(second).toBe(first);
    expect(repo.listEntries().length).toBe(1);
  });

  test("같은 타입·값이라도 slot 다르면 별개 행", () => {
    repo.addEntry({ typeName: "work", slot: "synonyms", value: "소설" });
    repo.addEntry({ typeName: "work", slot: "subcategories", value: "소설" });
    expect(repo.listEntries().length).toBe(2);
  });

  test("같은 slot·값이라도 타입 다르면 별개 행", () => {
    repo.addEntry({ typeName: "work", slot: "subcategories", value: "도구" });
    repo.addEntry({ typeName: "thing", slot: "subcategories", value: "도구" });
    expect(repo.listEntries().length).toBe(2);
  });

  // (2026-06-27 콜론 사슬 구조 배치 spec §6-B·단계1 D2) 옛 seeds slot 은 제거됐다 —
  // add→list 왕복·UNIQUE 멱등 검증은 살아남은 subcategories·attributes slot 으로 옮긴다.
  test("subcategories·attributes slot 도 add → list 왕복(단계2 다중 slot)", () => {
    const sId = repo.addEntry({ typeName: "intake", slot: "subcategories", value: "사과" });
    const aId = repo.addEntry({ typeName: "work", slot: "attributes", value: "장르" });
    const list = repo.listEntries();
    expect(list.length).toBe(2);
    const byId = new Map(list.map((e) => [e.entryId, e]));
    expect(byId.get(sId)!.slot).toBe("subcategories");
    expect(byId.get(sId)!.value).toBe("사과");
    expect(byId.get(aId)!.slot).toBe("attributes");
    expect(byId.get(aId)!.value).toBe("장르");
  });

  test("attributes slot 도 UNIQUE 멱등 — 같은 (타입,slot,값) 두 번 add → 행 1개", () => {
    const first = repo.addEntry({ typeName: "intake", slot: "attributes", value: "사과" });
    const second = repo.addEntry({ typeName: "intake", slot: "attributes", value: "사과" });
    expect(second).toBe(first);
    expect(repo.listEntries().length).toBe(1);
  });

  test("item_synonym slot — '대표키\\t동의어' value add → list 왕복", () => {
    const id = repo.addEntry({ typeName: "person", slot: "item_synonym", value: "별명\t닉네임" });
    expect(id.startsWith("cvocab_user_")).toBe(true);
    const e = repo.listEntries()[0]!;
    expect(e.slot).toBe("item_synonym");
    expect(e.value).toBe("별명\t닉네임");
  });

  test("item_synonym 멱등 — 같은 대표키·동의어 쌍 두 번 add → 행 1개", () => {
    const a = repo.addEntry({ typeName: "person", slot: "item_synonym", value: "별명\t닉네임" });
    const b = repo.addEntry({ typeName: "person", slot: "item_synonym", value: "별명\t닉네임" });
    expect(b).toBe(a);
    expect(repo.listEntries().length).toBe(1);
  });

  test("item_synonym — tab 구분자 없는 value 는 명시 에러 throw(silent skip 금지)", () => {
    expect(() =>
      repo.addEntry({ typeName: "person", slot: "item_synonym", value: "별명닉네임" }),
    ).toThrow(/item_synonym|대표키|동의어|tab/i);
  });

  test("item_synonym — 빈 토큰(대표키 또는 동의어)은 명시 에러 throw", () => {
    expect(() =>
      repo.addEntry({ typeName: "person", slot: "item_synonym", value: "별명\t" }),
    ).toThrow(/item_synonym|빈|토큰/);
    expect(() =>
      repo.addEntry({ typeName: "person", slot: "item_synonym", value: "\t닉네임" }),
    ).toThrow(/item_synonym|빈|토큰/);
  });

  test("non-item_synonym slot 은 tab 검증 안 함 — 값 그대로 보존", () => {
    expect(() =>
      repo.addEntry({ typeName: "work", slot: "synonyms", value: "탭없는값" }),
    ).not.toThrow();
  });

  test("deleteEntry 가 행을 제거", () => {
    const id = repo.addEntry({ typeName: "work", slot: "synonyms", value: "지움" });
    expect(repo.listEntries().length).toBe(1);
    repo.deleteEntry(id);
    expect(repo.listEntries().length).toBe(0);
  });

  test("없는 id 삭제는 멱등(에러 아님)", () => {
    expect(() => repo.deleteEntry("cvocab_user_does_not_exist")).not.toThrow();
  });

  test("listEntries 는 created_at 오름차순 정렬", () => {
    const a = repo.addEntry({ typeName: "work", slot: "synonyms", value: "가" });
    const b = repo.addEntry({ typeName: "work", slot: "synonyms", value: "나" });
    const c = repo.addEntry({ typeName: "work", slot: "synonyms", value: "다" });
    const ids = repo.listEntries().map((e) => e.entryId);
    // lexicographic created_at 비교가 곧 시간 순서 — 추가 순서 보존.
    expect(ids).toEqual([a, b, c]);
  });
});

describe("classify_vocab_user_entries 스키마", () => {
  test("빈 DB 의 기준 스키마가 classify_vocab_user_entries 칸을 만든다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    const cols = (db.prepare("PRAGMA table_info(classify_vocab_user_entries)").all() as Array<{
      name: string;
    }>).map((c) => c.name).sort();
    expect(cols).toEqual(["created_at", "entry_id", "slot", "type_name", "value"]);
    db.close();
  });
});
