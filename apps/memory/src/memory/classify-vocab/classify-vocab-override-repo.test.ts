/**
 * classify-vocab-override-repo.test.ts — ClassifyVocabOverrideRepo CRUD 통합 검증
 * (엔티티 관리 통합 S5 · 가림표 층/tombstone).
 *
 * 실제 :memory: SQLite(openMemoryDatabase — v32 classify_vocab_overrides 보유) 위에서
 * add(끄기) → list → remove(되살리기) 왕복과 UNIQUE(type_name, slot, value) 멱등을
 * 검증한다. mock 객체 안 만든다(실제 구현체만·데이터 fixture·실 DB). ClassifyVocabUserRepo
 * .test 양식 미러 — entry_id 대신 override_id·kind 칸 추가.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { ClassifyVocabOverrideRepo } from "./classify-vocab-override-repo.ts";

describe("ClassifyVocabOverrideRepo — CRUD", () => {
  let db: Database;
  let repo: ClassifyVocabOverrideRepo;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    repo = new ClassifyVocabOverrideRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  test("addOverride 반환 id 는 cvocab_ovr_ 접두 + list 에 kind='tombstone' 으로 보인다", () => {
    const id = repo.addOverride({ typeName: "work", slot: "synonyms", value: "창작물" });
    expect(id.startsWith("cvocab_ovr_")).toBe(true);

    const list = repo.listOverrides();
    expect(list.length).toBe(1);
    const o = list[0]!;
    expect(o.overrideId).toBe(id);
    expect(o.typeName).toBe("work");
    expect(o.slot).toBe("synonyms");
    expect(o.value).toBe("창작물");
    expect(o.kind).toBe("tombstone");
    expect(typeof o.createdAt).toBe("string");
    expect(o.createdAt.length).toBeGreaterThan(0);
  });

  test("UNIQUE(type_name, slot, value) 중복 끄기는 멱등 — 행 1개 + 같은 id 반환", () => {
    const first = repo.addOverride({ typeName: "creature", slot: "attributes", value: "품종" });
    const second = repo.addOverride({ typeName: "creature", slot: "attributes", value: "품종" });
    expect(second).toBe(first);
    expect(repo.listOverrides().length).toBe(1);
  });

  test("같은 (타입, 값) 도 slot 이 다르면 별 행 — 3차원 UNIQUE", () => {
    repo.addOverride({ typeName: "work", slot: "synonyms", value: "x" });
    repo.addOverride({ typeName: "work", slot: "subcategories", value: "x" });
    expect(repo.listOverrides().length).toBe(2);
  });

  test("removeOverride(타입,slot,값) 로 되살리기 — 그 행이 목록에서 사라짐", () => {
    repo.addOverride({ typeName: "work", slot: "synonyms", value: "창작물" });
    repo.addOverride({ typeName: "work", slot: "synonyms", value: "소설" });
    repo.removeOverride("work", "synonyms", "창작물");
    const list = repo.listOverrides();
    expect(list.length).toBe(1);
    expect(list[0]!.value).toBe("소설");
  });

  test("removeOverrideById 로도 되살리기", () => {
    const id = repo.addOverride({ typeName: "thing", slot: "subcategories", value: "가전" });
    repo.removeOverrideById(id);
    expect(repo.listOverrides().length).toBe(0);
  });

  test("없는 행 removeOverride 는 멱등(에러 아님·0 행 변경)", () => {
    expect(() => repo.removeOverride("work", "synonyms", "없는값")).not.toThrow();
    expect(repo.listOverrides().length).toBe(0);
  });

  test("CHECK(slot) — 가림표 대상 아닌 slot('columns') 직접 INSERT 는 거부", () => {
    // repo 타입은 3종만 허용하나, DB CHECK 가 마지막 방어선임을 raw INSERT 로 확인한다.
    expect(() =>
      db
        .prepare(
          "INSERT INTO classify_vocab_overrides (override_id, type_name, slot, value) VALUES (?, ?, ?, ?)",
        )
        .run("cvocab_ovr_x", "work", "columns", "가격"),
    ).toThrow();
  });

  test("classify_vocab_overrides 테이블·인덱스가 v32 로 실재(빈 DB 통로)", () => {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='classify_vocab_overrides'",
      )
      .get() as { name: string } | null;
    expect(table?.name).toBe("classify_vocab_overrides");

    const index = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classify_vocab_overrides_lookup'",
      )
      .get() as { name: string } | null;
    expect(index?.name).toBe("idx_classify_vocab_overrides_lookup");
  });
});
