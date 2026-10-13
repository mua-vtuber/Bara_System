/**
 * baseline-schema.entities-vocab.test.ts — 기준 스키마 중 엔티티·어휘 묶음(entity_relation_edges ~
 * relation_name_user_entries, 기준 SQL 파일 03-entities-vocab.sql 의 범위)의 동작 시험.
 *
 * 표·칸·색인이 있는지, DDL 글자가 어떤지는 보지 않는다 — schema-snapshot.test.ts 가 글자까지 고정한다.
 * 여기서는 PK·UNIQUE 제약, 외래 키 없는 위계 엣지, 외래 키 CASCADE, entities_fts·entities_vec 동기
 * 트리거, 글 모델 차원과 연동된 entities_vec, 다시 열기 무해를 본다.
 *
 * 옛 migrations.test.ts(1.2·v20·v22·v24·v25·v26 묶음)와 entity-relation-edges-migration.test.ts(PK)에서
 * 옮겼다. 엔티티 정체성 제약(work 4-tuple 등)은 entity-identity-constraints.test.ts 에 있다.
 * 이 파일은 openMemoryDatabase·runMigrations 만 쓰므로 마이그레이션 압축 전후 모두 통과한다.
 *
 * Mock 0: 실제 bun:sqlite + sqlite-vec. 행은 원시 INSERT 데이터 fixture.
 */
import { describe, expect, test } from "bun:test";
import { openMemoryDatabase, runMigrations } from "./migrations.ts";

type CountRow = { c: number };

const TEXT_DIM = 384;

// 384 차원 임베딩 — entities_vec float[384] 로 만든 DB 용 데이터 fixture.
function makeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(TEXT_DIM);
  for (let i = 0; i < v.length; i++) {
    v[i] = Math.sin(seed + i * 0.001);
  }
  return v;
}

describe("entity_relation_edges PK", () => {
  test("PK 다섯 칸 — (source_type, source_id, target_type, target_id, relation)", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    // PRAGMA table_info 의 pk 칸은 PK 안 순서(1-based), 아니면 0.
    const pkOrder = (db.query("PRAGMA table_info(entity_relation_edges)").all() as Array<{
      name: string;
      pk: number;
    }>)
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name);
    expect(pkOrder).toEqual([
      "source_type",
      "source_id",
      "target_type",
      "target_id",
      "relation",
    ]);
    db.close();
  });
});

describe("hierarchy_edges 제약", () => {
  test("복합 PK 중복 거부 + weight default 0.9 + FK 없음(임의 끝점 허용)", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    // FK 0 — 끝점이 실재하지 않아도 INSERT 가 통과한다(애플리케이션 게이트가 실재 보장).
    db.prepare(
      "INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, provenance, source_node_id) VALUES (?,?,?,?,?,'migration',NULL)",
    ).run("concept", "cpt_생물", "creature", "crt_고양이", "parent_of");
    const row = db
      .prepare("SELECT weight FROM hierarchy_edges WHERE source_id='cpt_생물' AND target_id='crt_고양이'")
      .get() as { weight: number };
    expect(row.weight).toBeCloseTo(0.9);
    // 같은 (source_type, source_id, target_type, target_id, relation) 중복은 PK 가 거부.
    expect(() =>
      db.prepare(
        "INSERT INTO hierarchy_edges (source_type, source_id, target_type, target_id, relation, provenance, source_node_id) VALUES (?,?,?,?,?,'migration',NULL)",
      ).run("concept", "cpt_생물", "creature", "crt_고양이", "parent_of"),
    ).toThrow();
    db.close();
  });
});

describe("사용자 사전·어휘 표의 UNIQUE", () => {
  test("synonym_user_entries UNIQUE(term, synonym, lang) 중복 거부 + 다른 lang/synonym 허용", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    const insert = db.prepare(
      "INSERT INTO synonym_user_entries (entry_id, term, synonym, lang, created_at) VALUES (?,?,?,?,?)",
    );
    insert.run("syn_user_1", "고양이", "냥이", "ko", "2026-06-17 00:00:00");
    // 같은 (term, synonym, lang) 중복은 UNIQUE 가 거부.
    expect(() => insert.run("syn_user_2", "고양이", "냥이", "ko", "2026-06-17 00:01:00")).toThrow();
    // 같은 term+synonym 라도 lang 다르면 통과.
    insert.run("syn_user_3", "고양이", "냥이", "en", "2026-06-17 00:02:00");
    // 같은 term+lang 라도 synonym 다르면 통과.
    insert.run("syn_user_4", "고양이", "야옹이", "ko", "2026-06-17 00:03:00");
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM synonym_user_entries").get() as CountRow).c;
    expect(cnt).toBe(3);
    db.close();
  });

  test("classify_vocab_user_entries UNIQUE(type_name, slot, value) — 같은 3쌍 두 번 삽입 차단", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare(
      "INSERT INTO classify_vocab_user_entries (entry_id, type_name, slot, value, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("cvocab_user_a", "work", "synonyms", "창작물", "2026-06-22T00:00:00");
    expect(() =>
      db.prepare(
        "INSERT INTO classify_vocab_user_entries (entry_id, type_name, slot, value, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("cvocab_user_b", "work", "synonyms", "창작물", "2026-06-22T00:00:01"),
    ).toThrow();
    db.close();
  });

  test("relation_name_user_entries relation_key UNIQUE — 같은 관계 키 두 번째 삽입 거부", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    const insert = db.prepare(
      `INSERT INTO relation_name_user_entries
         (entry_id, relation_key, relation_name, source_types, target_types, default_target_type, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    insert.run("rel_a", "구독처", "subscribed_to", "usable", "person", "person", "2026-06-24 00:00:00");
    expect(() =>
      insert.run("rel_b", "구독처", "follows", "usable", "person", "person", "2026-06-24 00:01:00"),
    ).toThrow();
    db.close();
  });
});

describe("entity_types · entities · entity_attributes 제약", () => {
  test("entity_types type_name UNIQUE 중복 거부", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare(
      "INSERT INTO entity_types (type_name, ko_name, id_prefix, created_at) VALUES (?,?,?,?)",
    ).run("vehicle", "탈것", "veh_", "2026-06-24 00:00:00");
    // 같은 type_name 두 번째 삽입은 UNIQUE 가 거부.
    expect(() =>
      db.prepare(
        "INSERT INTO entity_types (type_name, ko_name, id_prefix, created_at) VALUES (?,?,?,?)",
      ).run("vehicle", "차량", "veh2_", "2026-06-24 00:01:00"),
    ).toThrow();
    db.close();
  });

  test("entities — 비-work UNIQUE(type_name, name) 중복 거부 + 다른 종류 같은 이름 허용", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    const insert = db.prepare(
      "INSERT INTO entities (entity_id, type_name, name, ko_name) VALUES (?,?,?,?)",
    );
    insert.run("ent_a", "vehicle", "Sonata", "소나타");
    // vehicle 은 비-work 라 비-work partial UNIQUE(type_name, name)가 둘째 삽입을 거부.
    expect(() => insert.run("ent_b", "vehicle", "Sonata", "소나타2")).toThrow();
    // 같은 이름이라도 종류가 다르면 별개 엔티티로 산다.
    insert.run("ent_c", "color", "Sonata", "소나타색");
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM entities").get() as CountRow).c;
    expect(cnt).toBe(2);
    db.close();
  });

  test("프로젝트 본체는 entities 에 산다 — 같은 이름 둘째 프로젝트 거부", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    // name UNIQUE 가 type_name 안에서 살아 같은 이름 두 번째 입력을 거부("같은 이름 = 같은 프로젝트").
    db.prepare("INSERT INTO entities (entity_id, type_name, name) VALUES ('prj_a', 'project', '바라')").run();
    expect(() =>
      db.prepare("INSERT INTO entities (entity_id, type_name, name) VALUES ('prj_b', 'project', '바라')").run(),
    ).toThrow();
    db.close();
  });

  test("entity_attributes — UNIQUE(entity_id, attr_key) + is_column 구분", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO entities (entity_id, type_name, name) VALUES ('ent_x', 'vehicle', 'Model3')").run();
    const insert = db.prepare(
      "INSERT INTO entity_attributes (entity_id, attr_key, attr_value, is_column) VALUES (?,?,?,?)",
    );
    insert.run("ent_x", "제조사", "테슬라", 1); // 칸
    insert.run("ent_x", "색상", "흰색", 0); // 라벨
    // 같은 (entity_id, attr_key) 두 번째 삽입은 UNIQUE 가 거부.
    expect(() => insert.run("ent_x", "제조사", "현대", 1)).toThrow();
    const colVal = db
      .prepare("SELECT attr_value, is_column FROM entity_attributes WHERE entity_id='ent_x' AND attr_key='제조사'")
      .get() as { attr_value: string; is_column: number };
    expect(colVal.attr_value).toBe("테슬라");
    expect(colVal.is_column).toBe(1);
    db.close();
  });
});

describe("entities 외래 키 CASCADE", () => {
  test("entity_attributes FK CASCADE — entities 행 삭제 시 속성 동반 삭제", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO entities (entity_id, type_name, name) VALUES ('ent_d', 'vehicle', '카니발')").run();
    db.prepare(
      "INSERT INTO entity_attributes (entity_id, attr_key, attr_value, is_column) VALUES ('ent_d', '제조사', '기아', 1)",
    ).run();
    db.prepare("DELETE FROM entities WHERE entity_id='ent_d'").run();
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM entity_attributes").get() as CountRow).c;
    expect(cnt).toBe(0);
    db.close();
  });

  test("entity_concept_edges FK CASCADE — entities(project) 삭제 시 프로젝트 라벨 엣지 동반 삭제", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO entities (entity_id, type_name, name) VALUES ('prj_c', 'project', '바라시스템')").run();
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES ('cpt_p', '메모리모듈')").run();
    db.prepare("INSERT INTO entity_concept_edges (entity_id, concept_id, role, provenance, source_node_id) VALUES ('prj_c', 'cpt_p', 'classification', 'user_input', NULL)").run();
    db.prepare("DELETE FROM entities WHERE entity_id = 'prj_c'").run();
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM entity_concept_edges WHERE entity_id = 'prj_c'").get() as { c: number }).c;
    expect(cnt).toBe(0);
    db.close();
  });
});

describe("entities_fts · entities_vec 동기 트리거", () => {
  test("entities_fts 트리거 — INSERT 시 이름 + ko_name 합성 색인", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    // trigram(3-gram) 색인이라 검색어는 3글자 이상이라야 매치된다(다른 *_fts 정합).
    db.prepare("INSERT INTO entities (entity_id, type_name, name, ko_name) VALUES ('ent_f', 'vehicle', 'Avante', '아반떼')").run();
    const byKo = db
      .prepare("SELECT entity_id FROM entities_fts WHERE entities_fts MATCH '아반떼'")
      .get() as { entity_id: string } | null;
    expect(byKo?.entity_id).toBe("ent_f");
    db.close();
  });

  test("entities_fts 트리거 — 칸값(is_column=1)이 합성 색인에 든다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO entities (entity_id, type_name, name, ko_name) VALUES ('ent_g', 'vehicle', 'GV80', '지브이팔공')").run();
    // 칸값(is_column=1)은 합성 색인에 들어가 검색에 잡힌다.
    db.prepare(
      "INSERT INTO entity_attributes (entity_id, attr_key, attr_value, is_column) VALUES ('ent_g', '제조사', '제네시스', 1)",
    ).run();
    const byCol = db
      .prepare("SELECT entity_id FROM entities_fts WHERE entities_fts MATCH '제네시스'")
      .get() as { entity_id: string } | null;
    expect(byCol?.entity_id).toBe("ent_g");

    // 라벨값(is_column=0)은 합성 색인에 들지 않는다(칸값만 색인 — AC 의 "칸값 한 덩이").
    db.prepare(
      "INSERT INTO entity_attributes (entity_id, attr_key, attr_value, is_column) VALUES ('ent_g', '색상', '검정', 0)",
    ).run();
    const byLabel = db
      .prepare("SELECT entity_id FROM entities_fts WHERE entities_fts MATCH '검정'")
      .get() as { entity_id: string } | null;
    expect(byLabel).toBeNull();
    db.close();
  });

  test("entities DELETE — entities_fts · entities_vec 미러가 트리거로 정리된다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO entities (entity_id, type_name, name) VALUES ('ent_h', 'vehicle', 'Tucson')").run();
    const rowid = (db.prepare("SELECT rowid FROM entities WHERE entity_id='ent_h'").get() as { rowid: number }).rowid;
    db.prepare("INSERT INTO entities_vec (entity_rowid, embedding) VALUES (?, ?)").run(rowid, new Float32Array(TEXT_DIM));

    db.prepare("DELETE FROM entities WHERE entity_id='ent_h'").run();
    const ftsLeft = (db.prepare("SELECT COUNT(*) AS c FROM entities_fts").get() as CountRow).c;
    const vecLeft = (db.prepare("SELECT COUNT(*) AS c FROM entities_vec").get() as CountRow).c;
    expect(ftsLeft).toBe(0);
    expect(vecLeft).toBe(0);
    db.close();
  });

  test("entities_vec — KNN 검색 + 차원이 글 모델(384) 연동이다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    // 차원이 384로 명시 치환됐다 — 380 길이면 삽입이 실패한다(연동 증명).
    const vecSql = (db
      .prepare("SELECT sql FROM sqlite_master WHERE name='entities_vec'")
      .get() as { sql: string }).sql;
    expect(vecSql).toContain("float[384]");

    db.prepare("INSERT INTO entities (entity_id, type_name, name) VALUES ('ent_v1', 'vehicle', 'A')").run();
    db.prepare("INSERT INTO entities (entity_id, type_name, name) VALUES ('ent_v2', 'vehicle', 'B')").run();
    const r1 = (db.prepare("SELECT rowid FROM entities WHERE entity_id='ent_v1'").get() as { rowid: number }).rowid;
    const r2 = (db.prepare("SELECT rowid FROM entities WHERE entity_id='ent_v2'").get() as { rowid: number }).rowid;
    db.prepare("INSERT INTO entities_vec (entity_rowid, embedding) VALUES (?, ?)").run(r1, makeEmbedding(1));
    db.prepare("INSERT INTO entities_vec (entity_rowid, embedding) VALUES (?, ?)").run(r2, makeEmbedding(500));
    const rows = db
      .prepare("SELECT entity_rowid, distance FROM entities_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 1")
      .all(makeEmbedding(1)) as Array<{ entity_rowid: number; distance: number }>;
    expect(rows[0]!.entity_rowid).toBe(r1);
    db.close();
  });

  test("기본 글 모델(1024)일 때 entities_vec 차원은 1024 다(하드코딩 아닌 연동)", () => {
    const db = openMemoryDatabase(":memory:"); // embeddingDim 미지정 → DEFAULT 1024
    const vecSql = (db
      .prepare("SELECT sql FROM sqlite_master WHERE name='entities_vec'")
      .get() as { sql: string }).sql;
    expect(vecSql).toContain("float[1024]");
    db.close();
  });
});

describe("다시 열기 무해", () => {
  test("runMigrations 를 다시 돌려도 entities 행이 그대로다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare("INSERT INTO entities (entity_id, type_name, name) VALUES ('ent_keep', 'vehicle', '보존')").run();
    runMigrations(db); // 다시 실행 — 새로 할 일이 없다.
    const row = db.prepare("SELECT name FROM entities WHERE entity_id='ent_keep'").get() as { name: string } | null;
    expect(row?.name).toBe("보존");
    db.close();
  });

  test("runMigrations 를 다시 돌려도 relation_name_user_entries 행이 그대로다", () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: TEXT_DIM });
    db.prepare(
      `INSERT INTO relation_name_user_entries
         (entry_id, relation_key, relation_name, source_types, target_types, default_target_type, created_at)
       VALUES ('rel_keep','구독처','subscribed_to','usable','person','person','2026-06-24 00:00:00')`,
    ).run();
    runMigrations(db); // 다시 실행 — 새로 할 일이 없다.
    const row = db
      .prepare("SELECT relation_name FROM relation_name_user_entries WHERE relation_key='구독처'")
      .get() as { relation_name: string } | null;
    expect(row?.relation_name).toBe("subscribed_to");
    db.close();
  });
});
