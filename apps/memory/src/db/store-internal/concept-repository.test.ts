import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { ConceptRepository } from "./concept-repository.ts";
import { CONCEPT_ALIAS_THRESHOLD } from "../../memory/concept-alias-detect.ts";

const TEST_PROVENANCE = "system" as const;

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("ConceptRepository — concept_nodes 직접 CRUD", () => {
  let db: Database;
  let repo: ConceptRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new ConceptRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("findOrCreateTagConcept — 같은 이름 두 번이면 같은 cpt_ id (중복 X)", async () => {
    const first = await repo.findOrCreateTagConcept("만화");
    const second = await repo.findOrCreateTagConcept("만화");
    expect(first).toBe(second);
    expect(first.startsWith("cpt_")).toBe(true);
    const all = await repo.listConcepts();
    expect(all.length).toBe(1);
    expect(all[0]!.isTag).toBe(true);
  });

  test("findOrCreateTagConcept — 영문 lowercase 정규화", async () => {
    const a = await repo.findOrCreateTagConcept("Manga");
    const b = await repo.findOrCreateTagConcept("manga");
    expect(a).toBe(b);
  });

  test("findOrCreateConcept — 다중 역할 합류(옛 역할 보존)", async () => {
    const id = await repo.findOrCreateTagConcept("만화"); // is_tag=1
    const id2 = await repo.findOrCreateConcept("만화", { isClassificationValue: true });
    expect(id2).toBe(id);
    const c = await repo.getConcept(id);
    expect(c!.isTag).toBe(true);
    expect(c!.isClassificationValue).toBe(true);
  });

  test("findConceptByName — 정확 매칭, 없으면 null", async () => {
    await repo.findOrCreateTagConcept("주술회전");
    expect((await repo.findConceptByName("주술회전"))?.name).toBe("주술회전");
    expect(await repo.findConceptByName("원피스")).toBeNull();
  });

  test("findMentionedConcepts — 본문 부분 문자열 매칭", async () => {
    await repo.findOrCreateTagConcept("만화");
    await repo.findOrCreateTagConcept("게임");
    const hits = await repo.findMentionedConcepts("어제 만화를 봤다");
    expect(hits.map((c) => c.name)).toContain("만화");
    expect(hits.map((c) => c.name)).not.toContain("게임");
  });

  test("findMentionedConcepts — concept_edges has_attribute target 라벨 값 제외", async () => {
    // 직업 라벨 값(사람 has_attribute target)은 본문에 나와도 mention 후보에서 뺀다.
    const labelId = await repo.findOrCreateConcept("2d산골나무꾼", {
      isClassificationValue: true,
    });
    db.prepare(
      `INSERT INTO concept_edges
         (source_concept_id, target_concept_id, relation, provenance, source_node_id, weight)
       VALUES ('psn_test', ?, 'has_attribute', 'system', NULL, 1.0)`,
    ).run(labelId);

    const hits = await repo.findMentionedConcepts("2D산골나무꾼 일을 한다");
    expect(hits.map((c) => c.conceptId)).not.toContain(labelId);
  });

  test("findMentionedConcepts — 작품 값(분류값)은 평문 언급만으로 후보 제외(Task 1 · 2a)", async () => {
    // 의도된 동작 변경(spec 승인) — classification_value 개념은 콜론 태그 명시가
    // 있어야 연결된다. 평문만으로는 mention 후보에서 제외된다.
    const workId = await repo.findOrCreateConcept("주술회전", {
      isClassificationValue: true,
    });
    const hits = await repo.findMentionedConcepts("주술회전 재밌다");
    expect(hits.map((c) => c.conceptId)).not.toContain(workId);
  });

  test("findMentionedConcepts — 엔티티 *_concept_edges has_attribute 라벨 값 제외", async () => {
    // 작품 행 ↔ 장르 라벨(entity_concept_edges role='has_attribute')도 같은 기준으로 뺀다.
    const genreId = await repo.findOrCreateConcept("판타지", {
      isClassificationValue: true,
    });
    // FK(entity_concept_edges.entity_id → entities.entity_id) 충족용 실제 작품 행.
    db.prepare(
      `INSERT INTO entities (entity_id, type_name, name) VALUES ('wrk_test', 'work', '테스트작품')`,
    ).run();
    db.prepare(
      `INSERT INTO entity_concept_edges (entity_id, concept_id, role, provenance, source_node_id)
       VALUES ('wrk_test', ?, 'has_attribute', 'system', NULL)`,
    ).run(genreId);

    const hits = await repo.findMentionedConcepts("판타지 장르를 좋아한다");
    expect(hits.map((c) => c.conceptId)).not.toContain(genreId);
  });

  test("findMentionedConcepts — classification_key 노드('직업')는 mention 후보에서 제외", async () => {
    // 해시태그 #직업:2D산골나무꾼 을 풀어쓴 본문에는 키 단어 '직업'·'사람' 이 그대로
    // 들어간다. 이 키 개념은 입력 양식의 분류 라벨 이름이지 글이 언급한 개념이 아니므로
    // mention 후보에서 빠져야 한다(추가 DB 조회 없이 isClassificationKey 플래그로 거른다).
    const keyId = await repo.findOrCreateConcept("직업", {
      isClassificationKey: true,
    });
    // 같은 이름이 본문에 그대로 들어가도 결과에 안 들어온다.
    const hits = await repo.findMentionedConcepts("직업 라벨이 적힌 글");
    expect(hits.map((c) => c.conceptId)).not.toContain(keyId);
    expect(hits.map((c) => c.name)).not.toContain("직업");
  });

  test("findMentionedConcepts — 키 아닌 일반 개념은 그대로 매칭 (키 가드 대비)", async () => {
    // 키 가드가 일반 개념까지 가리면 안 된다. 같은 본문에 키('직업')와 일반 개념('만화')을
    // 함께 두고, 키만 빠지고 일반 개념은 매칭됨을 한 케이스로 대비 검증한다.
    const keyId = await repo.findOrCreateConcept("직업", {
      isClassificationKey: true,
    });
    const normalId = await repo.findOrCreateTagConcept("만화");
    const hits = await repo.findMentionedConcepts("직업 얘기를 만화로 그렸다");
    expect(hits.map((c) => c.conceptId)).not.toContain(keyId);
    expect(hits.map((c) => c.conceptId)).toContain(normalId);
  });

  test("addNodeConceptEdge — role 별 별 엣지 + 중복 false", async () => {
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES ('글')").run();
    const nodeId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    const cid = await repo.findOrCreateTagConcept("만화");

    expect(await repo.addNodeConceptEdge(nodeId, cid, "tag", TEST_PROVENANCE, nodeId)).toBe(true);
    expect(await repo.addNodeConceptEdge(nodeId, cid, "classification", TEST_PROVENANCE, nodeId)).toBe(true);
    expect(await repo.addNodeConceptEdge(nodeId, cid, "tag", "hashtag", 999)).toBe(false); // 중복

    const tagEdges = await repo.listNodeConceptEdges({ nodeId, role: "tag" });
    expect(tagEdges.length).toBe(1);
    const allEdges = await repo.listNodeConceptEdges({ nodeId });
    expect(allEdges.length).toBe(2);
    const tagRow = db
      .prepare(
        `SELECT provenance, source_node_id FROM node_concept_edges
         WHERE node_id = ? AND concept_id = ? AND role = 'tag'`,
      )
      .get(nodeId, cid) as { provenance: string; source_node_id: number };
    expect(tagRow.provenance).toBe("system");
    expect(tagRow.source_node_id).toBe(nodeId);
  });

  test("빈 태그 = throw (silent fallback 금지)", async () => {
    await expect(repo.findOrCreateTagConcept("")).rejects.toThrow(/non-empty/);
    await expect(repo.findOrCreateTagConcept("   ")).rejects.toThrow(/non-empty/);
  });

  test("findOrCreateConcept — concept_vec 에 1024-dim 임베딩 1행 + embedding_text 합성", async () => {
    const id = await repo.findOrCreateTagConcept("주술회전");
    const rowid = (
      db.prepare("SELECT rowid FROM concept_nodes WHERE concept_id=?").get(id) as {
        rowid: number;
      }
    ).rowid;
    const vrow = db
      .prepare("SELECT COUNT(*) AS c FROM concept_vec WHERE concept_rowid=?")
      .get(rowid) as { c: number };
    expect(vrow.c).toBe(1);
    const et = (
      db.prepare("SELECT embedding_text FROM concept_nodes WHERE concept_id=?").get(id) as {
        embedding_text: string;
      }
    ).embedding_text;
    expect(et).toContain("주술회전");
  });

  test("같은 개념 임베딩 = 검색어와 가장 가까운 개념(KNN 최근접)", async () => {
    await repo.findOrCreateTagConcept("주술회전");
    await repo.findOrCreateTagConcept("날씨");
    const q = await embedder.embed("주술회전");
    const hits = db
      .prepare(
        "SELECT concept_rowid, distance FROM concept_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 2",
      )
      .all(q) as Array<{ concept_rowid: number; distance: number }>;
    expect(hits.length).toBeGreaterThan(0);
    const topName = (
      db.prepare("SELECT name FROM concept_nodes WHERE rowid=?").get(hits[0]!.concept_rowid) as {
        name: string;
      }
    ).name;
    expect(topName).toBe("주술회전");
  });

  test("findOrCreateConcept — 기존 개념 역할 합류 시 concept_vec 중복 생성 X (신규 생성만 embed)", async () => {
    const id = await repo.findOrCreateTagConcept("만화");
    const rowid = (
      db.prepare("SELECT rowid FROM concept_nodes WHERE concept_id=?").get(id) as {
        rowid: number;
      }
    ).rowid;
    // 같은 이름으로 다시 역할 합류 — 신규 생성 아님.
    await repo.findOrCreateConcept("만화", { isClassificationValue: true });
    const vrow = db
      .prepare("SELECT COUNT(*) AS c FROM concept_vec WHERE concept_rowid=?")
      .get(rowid) as { c: number };
    expect(vrow.c).toBe(1); // 1행 유지 — 합류 경로는 임베딩 X
  });
});

describe("ConceptRepository.findSimilarConcepts — D2 ANN 검출 (실 bge-m3)", () => {
  let db: Database;
  let repo: ConceptRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new ConceptRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  function rowidOf(conceptId: string): number {
    return (
      db.prepare("SELECT rowid FROM concept_nodes WHERE concept_id=?").get(conceptId) as {
        rowid: number;
      }
    ).rowid;
  }

  test("self 는 후보에서 제외된다", async () => {
    const id = await repo.findOrCreateTagConcept("주술회전");
    const out = await repo.findSimilarConcepts(rowidOf(id), CONCEPT_ALIAS_THRESHOLD, 10);
    expect(out.find((c) => c.conceptId === id)).toBeUndefined();
  });

  test("무관 개념은 검출 안 됨 (cosine < 임계)", async () => {
    // '자동차' ↔ '김치' 무관쌍 — 실 bge-m3 측정 0.39~0.40 (2026-07-10 본 PC),
    // 임계 0.68 대비 여유 0.28 이상인 음성 fixture.
    const car = await repo.findOrCreateTagConcept("자동차");
    await repo.findOrCreateTagConcept("김치");
    const out = await repo.findSimilarConcepts(rowidOf(car), CONCEPT_ALIAS_THRESHOLD, 10);
    expect(out.length).toBe(0);
  });

  test("관련 있으나 별칭 아닌 쌍(자동차↔트럭)은 임계 미달 — 후보 아님", async () => {
    // 실 bge-m3 측정 0.57~0.60 (2026-07-10, 실행 간 ±0.04 변동 포함) — 임계
    // 0.68 아래의 관련-비별칭 경계 fixture. 의미가 관련돼도 같은 개념이 아니면
    // 후보로 잡지 않는다.
    const car = await repo.findOrCreateTagConcept("자동차");
    await repo.findOrCreateTagConcept("트럭");
    const out = await repo.findSimilarConcepts(rowidOf(car), CONCEPT_ALIAS_THRESHOLD, 10);
    expect(out.length).toBe(0);
  });

  test("같은 이름은 name UNIQUE 로 자동 합류 — 검출 0건", async () => {
    // 같은 이름 두 번 = 같은 노드(findOrCreate 가 자동 합류). 검출 대상 자체가 안 생긴다.
    const a = await repo.findOrCreateTagConcept("주술회전");
    const b = await repo.findOrCreateTagConcept("주술회전");
    expect(a).toBe(b);
    const out = await repo.findSimilarConcepts(rowidOf(a), CONCEPT_ALIAS_THRESHOLD, 10);
    expect(out.length).toBe(0);
  });

  test("임계값 미달이면 빈 배열", async () => {
    const weather = await repo.findOrCreateTagConcept("날씨");
    await repo.findOrCreateTagConcept("주술회전");
    // 임계값을 0.99 로 올리면 무관 개념은 당연히 미달.
    const out = await repo.findSimilarConcepts(rowidOf(weather), 0.99, 10);
    expect(out.length).toBe(0);
  });

  test("의미 가까운 한↔영 개념은 임계 이상 검출 (다른 이름·같은 의미)", async () => {
    // 실 bge-m3 1024-dim 측정 (2026-07-10 본 PC) — '자동차' ↔ 'automobile' =
    // 0.8774, 임계 0.68 대비 여유 0.19. 출처 정정: 옛 주석의 0.9600(2026-05-27)은
    // Granite 384-dim 측정값인데 c9401687 이 embedder 교체 때 문구만 bge-m3 로
    // 치환해 출처가 왜곡돼 있었다. 단일 짧은 토큰 한↔영 참 별칭은 bge-m3 에서
    // 0.71~0.89 (고양이↔cat 0.7106 / 인공지능↔artificial intelligence 0.7969).
    // 0 LLM 호출 — concept_vec 에 적재된 임베딩을 그대로 읽어 KNN.
    const ko = await repo.findOrCreateTagConcept("자동차");
    const en = await repo.findOrCreateTagConcept("automobile");

    const out = await repo.findSimilarConcepts(rowidOf(en), CONCEPT_ALIAS_THRESHOLD, 10);
    expect(out.length).toBeGreaterThan(0);
    const hit = out.find((c) => c.conceptId === ko);
    expect(hit).toBeDefined();
    expect(hit!.cosine).toBeGreaterThanOrEqual(CONCEPT_ALIAS_THRESHOLD);
    expect(hit!.name).toBe("자동차");
    // self(en) 는 절대 후보에 안 들어간다.
    expect(out.find((c) => c.conceptId === en)).toBeUndefined();
  });

  test("같은 언어 표기 변형(머신러닝↔머신 러닝)도 임계 이상 검출", async () => {
    // 실 bge-m3 측정 0.9275 (2026-07-10) — 참 별칭 중 최대 여유 쌍(임계 0.68
    // 대비 +0.25). 띄어쓰기만 다른 이름은 normalizeName(lowercase+trim)으로도
    // 같은 이름이 아니라서 자동 합류가 아닌 별칭 후보 경로로 온다.
    const compact = await repo.findOrCreateTagConcept("머신러닝");
    const spaced = await repo.findOrCreateTagConcept("머신 러닝");
    const out = await repo.findSimilarConcepts(rowidOf(spaced), CONCEPT_ALIAS_THRESHOLD, 10);
    const hit = out.find((c) => c.conceptId === compact);
    expect(hit).toBeDefined();
    expect(hit!.cosine).toBeGreaterThanOrEqual(CONCEPT_ALIAS_THRESHOLD);
  });

  test("결과는 cosine 내림차순 정렬", async () => {
    // 의미가 비슷한 동의어 세 개를 넣고, 한 기준 개념의 후보가 내림차순인지 확인.
    await repo.findOrCreateTagConcept("자동차");
    await repo.findOrCreateTagConcept("automobile");
    await repo.findOrCreateTagConcept("car");
    const base = await repo.findOrCreateTagConcept("vehicle");
    const out = await repo.findSimilarConcepts(rowidOf(base), 0.5, 10);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1]!.cosine).toBeGreaterThanOrEqual(out[i]!.cosine);
    }
  });

  test("concept_vec 에 임베딩 없는 rowid 면 throw (silent fallback 금지)", async () => {
    await expect(
      repo.findSimilarConcepts(999999, CONCEPT_ALIAS_THRESHOLD, 10),
    ).rejects.toThrow(/embedding/);
  });
});

describe("ConceptRepository — D2 검출 wiring + 별칭 합류 (실 bge-m3)", () => {
  let db: Database;
  let repo: ConceptRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new ConceptRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  function rowidOf(conceptId: string): number {
    return (
      db.prepare("SELECT rowid FROM concept_nodes WHERE concept_id=?").get(conceptId) as {
        rowid: number;
      }
    ).rowid;
  }

  function suggestionRows(): Array<{
    suggestion_id: string;
    new_concept_id: string;
    candidate_concept_id: string;
    cosine: number;
    status: string;
    resolved_at: string | null;
  }> {
    return db
      .prepare("SELECT * FROM concept_alias_suggestions ORDER BY created_at, suggestion_id")
      .all() as Array<{
      suggestion_id: string;
      new_concept_id: string;
      candidate_concept_id: string;
      cosine: number;
      status: string;
      resolved_at: string | null;
    }>;
  }

  test("새 개념 생성 시 임계 이상 후보를 pending 으로 저장한다 (자동 합류 0)", async () => {
    // '자동차' ↔ 'automobile' = 0.8774 (2026-07-10 실 bge-m3 측정, 임계 0.68
    // 대비 여유 0.19). 두 번째 신규 개념을 만들 때 첫 개념이 임계 이상 후보로
    // 잡혀 suggestions 에 적재돼야 한다 — 합류는 안 한다.
    const ko = await repo.findOrCreateTagConcept("자동차");
    const en = await repo.findOrCreateTagConcept("automobile");

    const rows = suggestionRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.new_concept_id).toBe(en); // 방금 만들어진 개념
    expect(rows[0]!.candidate_concept_id).toBe(ko); // 의미가 가까운 기존 개념
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.cosine).toBeGreaterThanOrEqual(CONCEPT_ALIAS_THRESHOLD);
    expect(rows[0]!.resolved_at).toBeNull();

    // 자동 합류 절대 금지 — 두 개념 노드 모두 그대로 살아있어야 한다.
    expect(await repo.getConcept(ko)).not.toBeNull();
    expect(await repo.getConcept(en)).not.toBeNull();
    const all = await repo.listConcepts();
    expect(all.length).toBe(2);
  });

  test("무관 개념은 후보 저장 0건 (cosine < 임계)", async () => {
    // '자동차' ↔ '김치' 실 bge-m3 측정 0.39~0.40 (2026-07-10) — 임계 0.68 미달.
    await repo.findOrCreateTagConcept("자동차");
    await repo.findOrCreateTagConcept("김치");
    expect(suggestionRows().length).toBe(0);
  });

  test("같은 이름 = name UNIQUE 자동 합류 → 신규 생성 경로 미진입 → 후보 0건", async () => {
    const a = await repo.findOrCreateTagConcept("자동차");
    const b = await repo.findOrCreateTagConcept("자동차");
    expect(a).toBe(b);
    expect(suggestionRows().length).toBe(0);
  });

  test("기존 개념 역할 합류 경로는 검출 안 함 (재임베딩 X)", async () => {
    await repo.findOrCreateTagConcept("자동차");
    await repo.findOrCreateTagConcept("automobile");
    const before = suggestionRows().length;
    // 같은 이름으로 역할만 추가 — 신규 생성 아님 → 검출 미진입.
    await repo.findOrCreateConcept("automobile", { isClassificationValue: true });
    expect(suggestionRows().length).toBe(before);
  });

  test("검출 실패해도 개념 생성은 성공한다 (검출은 보조 — 코어 차단 금지)", async () => {
    // findSimilarConcepts 를 일시 실패로 갈아끼운다(임베딩 일시 오류 모사).
    // 검출은 best-effort 라 개념 생성 자체는 그대로 성공해야 한다 + 가짜 후보 0건.
    const original = repo.findSimilarConcepts.bind(repo);
    (repo as unknown as { findSimilarConcepts: unknown }).findSimilarConcepts = async () => {
      throw new Error("transient embedding error (test)");
    };
    let id: string;
    try {
      id = await repo.findOrCreateTagConcept("주술회전");
    } finally {
      (repo as unknown as { findSimilarConcepts: unknown }).findSimilarConcepts = original;
    }
    // 개념은 정상 생성 — concept_vec 1행 적재 + 후보는 0건(가짜 후보 금지).
    expect(id.startsWith("cpt_")).toBe(true);
    expect((await repo.getConcept(id))).not.toBeNull();
    const vrow = db
      .prepare("SELECT COUNT(*) AS c FROM concept_vec WHERE concept_rowid=?")
      .get(rowidOf(id)) as { c: number };
    expect(vrow.c).toBe(1);
    expect(suggestionRows().length).toBe(0);
  });

  test("mergeConceptAlias — source name 을 target 별칭 JSON 에 추가 + usage count 합산", async () => {
    // 한글 source → ko_aliases, 영문 source → en_aliases 갈래 둘 다 검증.
    const target = await repo.findOrCreateConcept("자동차", { isTag: true }); // tag_usage_count=1
    const source = await repo.findOrCreateConcept("automobile", {
      isClassificationValue: true,
    }); // classification_usage_count=1

    await repo.mergeConceptAlias(target, source);

    const merged = await repo.getConcept(target);
    expect(merged).not.toBeNull();
    // 영문 source → en_aliases 에 추가.
    expect(merged!.enAliases).toContain("automobile");
    // usage count 둘 다 합산 (1 + 1 각 칸).
    expect(merged!.tagUsageCount).toBe(1);
    expect(merged!.classificationUsageCount).toBe(1);
    // 역할 플래그 OR 합류.
    expect(merged!.isTag).toBe(true);
    expect(merged!.isClassificationValue).toBe(true);

    // source 흡수 — 노드 제거 + 후보 정리.
    expect(await repo.getConcept(source)).toBeNull();

    // embedding_text 재합성 + concept_vec 갱신 (1행 유지).
    const vrow = db
      .prepare("SELECT COUNT(*) AS c FROM concept_vec WHERE concept_rowid=?")
      .get(rowidOf(target)) as { c: number };
    expect(vrow.c).toBe(1);
    const et = (
      db.prepare("SELECT embedding_text FROM concept_nodes WHERE concept_id=?").get(target) as {
        embedding_text: string;
      }
    ).embedding_text;
    expect(et).toContain("automobile");
  });

  test("mergeConceptAlias — 한글 source 는 ko_aliases 로 들어간다", async () => {
    const target = await repo.findOrCreateTagConcept("automobile");
    const source = await repo.findOrCreateTagConcept("자동차");
    await repo.mergeConceptAlias(target, source);
    const merged = await repo.getConcept(target);
    expect(merged!.koAliases).toContain("자동차");
    expect(merged!.enAliases).not.toContain("자동차");
  });

  test("mergeConceptAlias — source node_concept_edges 가 target 으로 재연결된다", async () => {
    db.prepare("INSERT INTO knowledge_nodes (content) VALUES ('자동차 글')").run();
    const nodeId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    const target = await repo.findOrCreateTagConcept("automobile");
    const source = await repo.findOrCreateTagConcept("자동차");
    await repo.addNodeConceptEdge(nodeId, source, "mention", TEST_PROVENANCE, nodeId);

    await repo.mergeConceptAlias(target, source);

    // source 엣지가 target 으로 옮겨졌다.
    const onTarget = await repo.listNodeConceptEdges({ nodeId, conceptId: target });
    expect(onTarget.length).toBe(1);
    expect(onTarget[0]!.role).toBe("mention");
    // source 는 흡수돼 더 이상 없다(FK CASCADE 로 잔존 엣지도 없음).
    const onSource = await repo.listNodeConceptEdges({ nodeId, conceptId: source });
    expect(onSource.length).toBe(0);
  });

  test("mergeConceptAlias — source concept_edges 가 target 으로 재연결된다 (Task 18 FK 제거 후 불변)", async () => {
    // concept_edges 양 끝 FK 를 뺀 뒤에도 mergeConceptAlias 의 명시 재연결
    // (UPDATE OR IGNORE source/target + 자기 루프 DELETE) 가 그대로 동작해야 한다.
    // 옛 동작은 FK ON DELETE CASCADE 에 의존하지 않았으므로(명시 UPDATE 가 먼저
    // 옮긴다) FK 제거 후에도 결과가 같다 — 그 불변을 고정하는 회귀 가드.
    const other = await repo.findOrCreateTagConcept("만화");
    const target = await repo.findOrCreateTagConcept("automobile");
    const source = await repo.findOrCreateTagConcept("자동차");
    // source → other 위계 엣지를 만든다.
    db.prepare(
      `INSERT INTO concept_edges
         (source_concept_id, target_concept_id, relation, provenance, source_node_id, weight)
       VALUES (?, ?, 'parent_of', 'system', NULL, 0.3)`,
    ).run(source, other);

    await repo.mergeConceptAlias(target, source);

    // 엣지가 target → other 로 옮겨졌다 — source 끝은 사라진다.
    const onTarget = db
      .prepare(
        "SELECT COUNT(*) AS c FROM concept_edges WHERE source_concept_id=? AND target_concept_id=?",
      )
      .get(target, other) as { c: number };
    expect(onTarget.c).toBe(1);
    const onSource = db
      .prepare(
        "SELECT COUNT(*) AS c FROM concept_edges WHERE source_concept_id=? OR target_concept_id=?",
      )
      .get(source, source) as { c: number };
    expect(onSource.c).toBe(0);
  });

  test("mergeConceptAlias — hierarchy_edges 개념 끝점이 target 으로 재연결 (dangling 0)", async () => {
    // 위계 단일 출처(hierarchy_edges)는 FK 0 다형 끝점이라 source 삭제 CASCADE 가
    // 안 닿는다. 합치기 후 사라진 source 를 가리키는 위계 엣지가 0 임을 실 DB 로 검증.
    const parent = await repo.findOrCreateTagConcept("탈것"); // 부모 개념
    const child = await repo.findOrCreateTagConcept("자동차"); // 자식(이 글에서 손자)
    const target = await repo.findOrCreateTagConcept("automobile"); // 합류 canonical
    const source = await repo.findOrCreateTagConcept("승용차"); // 흡수될 source

    // 위계 사슬: 탈것 → 승용차(source) → 자동차. 중간(source)을 합쳐도
    // 사슬이 target 으로 이어져야 한다(탈것 → automobile → 자동차).
    db.prepare(
      `INSERT INTO hierarchy_edges
         (source_type, source_id, target_type, target_id, relation, provenance, source_node_id, weight)
       VALUES ('concept', ?, 'concept', ?, 'parent_of', 'system', NULL, 0.9)`,
    ).run(parent, source);
    db.prepare(
      `INSERT INTO hierarchy_edges
         (source_type, source_id, target_type, target_id, relation, provenance, source_node_id, weight)
       VALUES ('concept', ?, 'concept', ?, 'parent_of', 'system', NULL, 0.9)`,
    ).run(source, child);

    await repo.mergeConceptAlias(target, source);

    // source 를 가리키는 위계 엣지(양 끝)는 0 — 끊긴 끝점 없음.
    const dangling = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE (source_type='concept' AND source_id=?)
            OR (target_type='concept' AND target_id=?)`,
      )
      .get(source, source) as { c: number };
    expect(dangling.c).toBe(0);

    // 사슬이 target 으로 이어진다: 탈것 → automobile, automobile → 자동차.
    const parentToTarget = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE source_type='concept' AND source_id=? AND target_type='concept' AND target_id=?`,
      )
      .get(parent, target) as { c: number };
    expect(parentToTarget.c).toBe(1);
    const targetToChild = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE source_type='concept' AND source_id=? AND target_type='concept' AND target_id=?`,
      )
      .get(target, child) as { c: number };
    expect(targetToChild.c).toBe(1);
  });

  test("mergeConceptAlias — hierarchy_edges PK 충돌·자기 루프는 정리 (중복·끊김 0)", async () => {
    // target 이 이미 child 의 부모인데 source 도 child 의 부모면, source→child 를
    // target→child 로 옮기려다 PK 충돌(이미 존재) → OR IGNORE 가 건너뛴다. 그
    // 잔존 source 행은 DELETE 로 정리돼야 한다(중복·끊김 0). 또 source↔target 직접
    // 위계가 있으면 합류 후 target↔target 자기 루프가 되어 무의미 — 함께 제거.
    const child = await repo.findOrCreateTagConcept("자동차");
    const target = await repo.findOrCreateTagConcept("automobile");
    const source = await repo.findOrCreateTagConcept("승용차");

    // target → child (먼저 존재) + source → child (합류 시 충돌) + source ↔ target 직접.
    db.prepare(
      `INSERT INTO hierarchy_edges
         (source_type, source_id, target_type, target_id, relation, provenance, source_node_id, weight)
       VALUES ('concept', ?, 'concept', ?, 'parent_of', 'system', NULL, 0.9)`,
    ).run(target, child);
    db.prepare(
      `INSERT INTO hierarchy_edges
         (source_type, source_id, target_type, target_id, relation, provenance, source_node_id, weight)
       VALUES ('concept', ?, 'concept', ?, 'parent_of', 'system', NULL, 0.9)`,
    ).run(source, child);
    db.prepare(
      `INSERT INTO hierarchy_edges
         (source_type, source_id, target_type, target_id, relation, provenance, source_node_id, weight)
       VALUES ('concept', ?, 'concept', ?, 'parent_of', 'system', NULL, 0.9)`,
    ).run(target, source);

    await repo.mergeConceptAlias(target, source);

    // source 끝점 0 — 끊김 없음.
    const dangling = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE (source_type='concept' AND source_id=?)
            OR (target_type='concept' AND target_id=?)`,
      )
      .get(source, source) as { c: number };
    expect(dangling.c).toBe(0);
    // target → child 한 행만 남는다(충돌난 source→child 흡수·자기 루프 제거).
    const total = db
      .prepare(`SELECT COUNT(*) AS c FROM hierarchy_edges`)
      .get() as { c: number };
    expect(total.c).toBe(1);
    // 자기 루프(target↔target)는 없다.
    const selfLoop = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE source_type='concept' AND target_type='concept' AND source_id=target_id`,
      )
      .get() as { c: number };
    expect(selfLoop.c).toBe(0);
  });

  test("mergeConceptAlias — entity_relation_edges 개념 끝점이 target 으로 재연결 (dangling 0)", async () => {
    // cross-type 관계 단일 출처(entity_relation_edges)도 FK 0 다형 끝점이다. 개념을
    // 끝점으로 담은 관계 엣지가 source 를 가리키면, 합류 후 target 으로 옮겨져야 하고
    // source 를 가리키는 행은 0 이어야 한다. (created_at INTEGER epoch ms 양식.)
    const target = await repo.findOrCreateTagConcept("automobile");
    const source = await repo.findOrCreateTagConcept("승용차");
    // 관계명은 schema TEXT 자유 — 양 끝이 'concept' 인 행을 직접 적재해 끝점 종류
    // 필터(source_type/target_type='concept')가 정확히 골라내는지 검증한다.
    db.prepare(
      `INSERT INTO entity_relation_edges
         (source_type, source_id, target_type, target_id, relation, provenance, source_node_id,
          weight, created_at)
       VALUES ('concept', ?, 'concept', ?, 'created_by', 'system', NULL, NULL, ?)`,
    ).run(source, target, Date.now());
    // source 가 target 끝인 행도 하나(역방향 끝점 필터 검증).
    const other = await repo.findOrCreateTagConcept("자동차");
    db.prepare(
      `INSERT INTO entity_relation_edges
         (source_type, source_id, target_type, target_id, relation, provenance, source_node_id,
          weight, created_at)
       VALUES ('concept', ?, 'concept', ?, 'created_by', 'system', NULL, NULL, ?)`,
    ).run(other, source, Date.now());

    await repo.mergeConceptAlias(target, source);

    const dangling = db
      .prepare(
        `SELECT COUNT(*) AS c FROM entity_relation_edges
         WHERE (source_type='concept' AND source_id=?)
            OR (target_type='concept' AND target_id=?)`,
      )
      .get(source, source) as { c: number };
    expect(dangling.c).toBe(0);
    // other → source 행은 other → target 으로 옮겨진다(역방향 끝점 재연결).
    const moved = db
      .prepare(
        `SELECT COUNT(*) AS c FROM entity_relation_edges
         WHERE source_type='concept' AND source_id=? AND target_type='concept' AND target_id=?`,
      )
      .get(other, target) as { c: number };
    expect(moved.c).toBe(1);
  });

  test("mergeConceptAlias — 비개념(person) 끝점은 건드리지 않는다 (끝점 종류 필터)", async () => {
    // 두 FK 0 테이블은 person·8 타입 행도 끝점으로 담는다. bare id 칸이 같아도
    // *_type='concept' 필터가 비개념 끝점을 건드리면 안 된다. person 끝점이 우연히
    // source 와 같은 문자열이어도(현실엔 prefix 로 안 겹치나 종류 필터 자체 검증)
    // person 행은 그대로 보존돼야 한다.
    const target = await repo.findOrCreateTagConcept("automobile");
    const source = await repo.findOrCreateTagConcept("승용차");
    // person 끝점 — source 와 다른 id(psn_) 지만, 합류가 person 위계를 망가뜨리지
    // 않음을 고정한다. source(개념) 끝점만 옮기고 person 행은 불변.
    db.prepare(
      `INSERT INTO hierarchy_edges
         (source_type, source_id, target_type, target_id, relation, provenance, source_node_id, weight)
       VALUES ('person', 'psn_keep', 'concept', ?, 'parent_of', 'system', NULL, 0.9)`,
    ).run(source);

    await repo.mergeConceptAlias(target, source);

    // person 끝점은 그대로(source_type 불변) + concept target 만 옮겨졌다.
    const personRow = db
      .prepare(
        `SELECT source_type, source_id, target_type, target_id FROM hierarchy_edges
         WHERE source_type='person' AND source_id='psn_keep'`,
      )
      .get() as
      | { source_type: string; source_id: string; target_type: string; target_id: string }
      | null;
    expect(personRow).not.toBeNull();
    expect(personRow!.target_id).toBe(target); // concept 자식만 target 으로 이동
    // source 를 가리키는 끝점 0.
    const dangling = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE (source_type='concept' AND source_id=?)
            OR (target_type='concept' AND target_id=?)`,
      )
      .get(source, source) as { c: number };
    expect(dangling.c).toBe(0);
  });

  test("mergeConceptAlias — 합치기와 무관한 기존 자기루프(Z↔Z)는 보존된다 (자기루프 절 좁힘)", async () => {
    // 자기루프 DELETE 절이 oldId·newId 한정이라야 한다. 이번 합치기와 무관한 다른
    // 개념의 기존 자기루프(Z→Z)가 합치기 부수효과로 사라지면 안 된다(데이터 무결성).
    // hierarchy_edges·entity_relation_edges 두 테이블 모두에 무관 자기루프를 두고,
    // source/target 과 전혀 무관한 그 자기루프가 합치기 후에도 그대로 남는지 본다.
    const target = await repo.findOrCreateTagConcept("automobile");
    const source = await repo.findOrCreateTagConcept("승용차");
    const z = await repo.findOrCreateTagConcept("무관개념"); // 합치기와 무관한 제3 개념

    // 무관한 자기루프 두 개(Z↔Z) — 비정상 데이터지만 이번 합치기가 건드리면 안 됨.
    db.prepare(
      `INSERT INTO hierarchy_edges
         (source_type, source_id, target_type, target_id, relation, provenance, source_node_id, weight)
       VALUES ('concept', ?, 'concept', ?, 'parent_of', 'system', NULL, 0.9)`,
    ).run(z, z);
    db.prepare(
      `INSERT INTO entity_relation_edges
         (source_type, source_id, target_type, target_id, relation, provenance, source_node_id,
          weight, created_at)
       VALUES ('concept', ?, 'concept', ?, 'created_by', 'system', NULL, NULL, ?)`,
    ).run(z, z, Date.now());

    // 합치기와 무관한 source→target 끝점도 하나 둬서 합치기가 실제로 일어나게 한다.
    db.prepare(
      `INSERT INTO hierarchy_edges
         (source_type, source_id, target_type, target_id, relation, provenance, source_node_id, weight)
       VALUES ('concept', ?, 'concept', ?, 'parent_of', 'system', NULL, 0.9)`,
    ).run(source, z);

    await repo.mergeConceptAlias(target, source);

    // 무관 Z↔Z 자기루프는 두 테이블 모두 그대로 보존.
    const hierZLoop = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE source_type='concept' AND source_id=? AND target_type='concept' AND target_id=?`,
      )
      .get(z, z) as { c: number };
    expect(hierZLoop.c).toBe(1);
    const relZLoop = db
      .prepare(
        `SELECT COUNT(*) AS c FROM entity_relation_edges
         WHERE source_type='concept' AND source_id=? AND target_type='concept' AND target_id=?`,
      )
      .get(z, z) as { c: number };
    expect(relZLoop.c).toBe(1);

    // source 끝점은 0(정상 재연결) — source→z 가 target→z 로 옮겨졌다.
    const dangling = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE (source_type='concept' AND source_id=?)
            OR (target_type='concept' AND target_id=?)`,
      )
      .get(source, source) as { c: number };
    expect(dangling.c).toBe(0);
    const movedToTarget = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE source_type='concept' AND source_id=? AND target_type='concept' AND target_id=?`,
      )
      .get(target, z) as { c: number };
    expect(movedToTarget.c).toBe(1);
  });

  test("mergeConceptAlias — source↔target 직접 위계는 합치기 후 자기루프로 정리된다 (좁힌 절이 newId 자기루프는 지움)", async () => {
    // 자기루프 절을 oldId·newId 로 좁혀도, 이번 합치기로 *생긴* newId↔newId 자기루프는
    // 여전히 지워져야 한다. source→target 직접 위계가 UPDATE 후 target↔target 이 되는데
    // 그 행은 좁힌 절(source_id IN (oldId,newId))에 잡혀 제거된다.
    const target = await repo.findOrCreateTagConcept("automobile");
    const source = await repo.findOrCreateTagConcept("승용차");
    db.prepare(
      `INSERT INTO hierarchy_edges
         (source_type, source_id, target_type, target_id, relation, provenance, source_node_id, weight)
       VALUES ('concept', ?, 'concept', ?, 'parent_of', 'system', NULL, 0.9)`,
    ).run(source, target); // source → target 직접 — 합치기 후 target↔target 자기루프

    await repo.mergeConceptAlias(target, source);

    const selfLoop = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hierarchy_edges
         WHERE source_type='concept' AND target_type='concept' AND source_id=target_id`,
      )
      .get() as { c: number };
    expect(selfLoop.c).toBe(0); // 이번 합치기로 생긴 newId 자기루프는 제거.
    const total = db
      .prepare(`SELECT COUNT(*) AS c FROM hierarchy_edges`)
      .get() as { c: number };
    expect(total.c).toBe(0); // 유일했던 행이 자기루프가 돼 사라짐.
  });

  test("mergeConceptAlias — 미존재 개념이면 throw (silent fallback 금지)", async () => {
    const target = await repo.findOrCreateTagConcept("자동차");
    await expect(repo.mergeConceptAlias(target, "cpt_nope")).rejects.toThrow(/cpt_nope/);
    await expect(repo.mergeConceptAlias("cpt_nope", target)).rejects.toThrow(/cpt_nope/);
  });

  test("listAliasSuggestions — status 필터", async () => {
    const ko = await repo.findOrCreateTagConcept("자동차");
    const en = await repo.findOrCreateTagConcept("automobile");
    void ko;
    const pending = await repo.listAliasSuggestions("pending");
    expect(pending.length).toBe(1);
    expect(pending[0]!.newConceptId).toBe(en);
    expect(pending[0]!.status).toBe("pending");
    // status 미지정 = 전체.
    expect((await repo.listAliasSuggestions()).length).toBe(1);
    // 없는 status = 빈 목록.
    expect((await repo.listAliasSuggestions("merged")).length).toBe(0);
  });

  test("resolveAliasSuggestion('merged') — 합류 실행 + status merged", async () => {
    const ko = await repo.findOrCreateTagConcept("자동차");
    const en = await repo.findOrCreateTagConcept("automobile");
    const sug = (await repo.listAliasSuggestions("pending"))[0]!;
    // new=en, candidate=ko. 합류는 candidate(기존)를 target 으로, new 를 source 로
    // 흡수한다(기존 개념을 canonical 로 보존 — 결정).
    await repo.resolveAliasSuggestion(sug.suggestionId, "merged");

    // candidate(ko)가 살아남고 new(en)는 흡수된다.
    expect(await repo.getConcept(ko)).not.toBeNull();
    expect(await repo.getConcept(en)).toBeNull();
    const target = await repo.getConcept(ko);
    expect(target!.enAliases).toContain("automobile");

    // suggestion 은 FK CASCADE(en 삭제) 로 사라지거나 merged 상태가 된다 — 어느
    // 경우든 pending 으로는 남으면 안 된다.
    expect((await repo.listAliasSuggestions("pending")).length).toBe(0);
  });

  test("resolveAliasSuggestion('rejected') — 합류 없이 status 만 rejected", async () => {
    const ko = await repo.findOrCreateTagConcept("자동차");
    const en = await repo.findOrCreateTagConcept("automobile");
    const sug = (await repo.listAliasSuggestions("pending"))[0]!;
    await repo.resolveAliasSuggestion(sug.suggestionId, "rejected");

    // 두 개념 모두 그대로 — 합류 안 함.
    expect(await repo.getConcept(ko)).not.toBeNull();
    expect(await repo.getConcept(en)).not.toBeNull();
    const rejected = await repo.listAliasSuggestions("rejected");
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.resolvedAt).not.toBeNull();
  });

  test("resolveAliasSuggestion — 미존재 id 면 throw", async () => {
    await expect(repo.resolveAliasSuggestion("casug_nope", "rejected")).rejects.toThrow(
      /casug_nope/,
    );
  });

  test("개념 합류는 db_revision 을 bump 한다 (검색 캐시 무효화 신호)", async () => {
    let bumped = 0;
    const repo2 = new ConceptRepository(db, embedder, () => {
      bumped += 1;
    });
    const target = await repo2.findOrCreateTagConcept("자동차");
    const source = await repo2.findOrCreateTagConcept("automobile");
    const before = bumped;
    await repo2.mergeConceptAlias(target, source);
    expect(bumped).toBeGreaterThan(before);
  });
});

describe("ConceptRepository.addConceptAlias — 분리 잎 개념 검색 보강 (E2)", () => {
  let db: Database;
  let repo: ConceptRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new ConceptRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  /** 개념 ko_aliases JSON array 를 파싱해 돌려준다(없으면 빈 배열). */
  function koAliasesOf(conceptId: string): string[] {
    const row = db
      .prepare("SELECT ko_aliases FROM concept_nodes WHERE concept_id = ?")
      .get(conceptId) as { ko_aliases: string | null } | null;
    if (!row || !row.ko_aliases) return [];
    return JSON.parse(row.ko_aliases) as string[];
  }

  test("addConceptAlias — 별칭 추가·합집합 멱등", async () => {
    const cid = await repo.findOrCreateConcept("괴담 (소설/백덕수)", {
      isClassificationValue: true,
    });
    await repo.addConceptAlias(cid, "괴담");
    expect(koAliasesOf(cid)).toContain("괴담");

    // 다시 호출해도 중복 0 — 멱등.
    await repo.addConceptAlias(cid, "괴담");
    const aliases = koAliasesOf(cid);
    expect(aliases.filter((a) => a === "괴담").length).toBe(1);
  });

  test("addConceptAlias — NFD 별칭은 같은 NFC 별칭의 중복으로 판정(사본 0)", async () => {
    const cid = await repo.findOrCreateConcept("괴담 (소설/백덕수)", {
      isClassificationValue: true,
    });
    await repo.addConceptAlias(cid, "괴담");
    // 같은 별칭을 조합형(NFD)으로 다시 넣어도 배열이 늘지 않는다.
    await repo.addConceptAlias(cid, "괴담".normalize("NFD"));
    const aliases = koAliasesOf(cid);
    expect(aliases.filter((a) => a.normalize("NFC") === "괴담")).toHaveLength(1);

    // 언어 판정(aliasLangOf)은 함수 내부에서 NFC 정규화 후 판정한다(호출자 선행
    // 정규화와 이중 방어) — 조합형 한글 별칭이 en_aliases 로 새면 안 된다.
    const enRow = db
      .prepare("SELECT en_aliases FROM concept_nodes WHERE concept_id = ?")
      .get(cid) as { en_aliases: string | null };
    const en = enRow.en_aliases ? (JSON.parse(enRow.en_aliases) as string[]) : [];
    expect(en).toHaveLength(0);
  });

  test("addConceptAlias — NFD 로 저장된 옛 별칭도 NFC 재입력이 중복 판정", async () => {
    const cid = await repo.findOrCreateConcept("괴담 (소설/백덕수)", {
      isClassificationValue: true,
    });
    // 옛 저장분이 조합형인 경우를 재현 — DB 에 직접 NFD 별칭을 넣는다.
    db.prepare("UPDATE concept_nodes SET ko_aliases = ? WHERE concept_id = ?").run(
      JSON.stringify(["괴담".normalize("NFD")]),
      cid,
    );
    await repo.addConceptAlias(cid, "괴담");
    expect(koAliasesOf(cid)).toHaveLength(1);
  });

  test("addConceptAlias — 소문자 키로 중복 판정(원본 표기 보존, 멱등)", async () => {
    const cid = await repo.findOrCreateConcept("괴담 (소설/백덕수)", {
      isClassificationValue: true,
    });
    // 영문 별칭은 en_aliases 로 간다 — 대소문자만 다른 재호출은 추가 안 함.
    await repo.addConceptAlias(cid, "GhostStory");
    await repo.addConceptAlias(cid, "ghoststory");
    const enRow = db
      .prepare("SELECT en_aliases FROM concept_nodes WHERE concept_id = ?")
      .get(cid) as { en_aliases: string | null };
    const en = enRow.en_aliases ? (JSON.parse(enRow.en_aliases) as string[]) : [];
    // 원본 표기("GhostStory") 1개만 — 소문자 키 비교로 중복 차단.
    expect(en.length).toBe(1);
    expect(en[0]).toBe("GhostStory");
  });

  test("addConceptAlias — 별칭으로 개념 FTS 검색 매칭(분리 후 보강)", async () => {
    // 정체성 키로 분리한 이름("백설공주 (동화/그림형제)")에 원래 이름("백설공주")을
    // 별칭으로 더하면, concept_nodes_fts 가 ko_aliases UPDATE 트리거로 자동 재동기해
    // 원래 이름 trigram 검색이 이 개념을 다시 잡는다(검색 보강). 3글자+ 라야 trigram
    // 매치가 안정적이라 "백설공주"(4글자) 로 검증한다.
    const cid = await repo.findOrCreateConcept("백설공주 (동화/그림형제)", {
      isClassificationValue: true,
    });
    await repo.addConceptAlias(cid, "백설공주");

    const hit = db
      .prepare(
        "SELECT concept_id FROM concept_nodes_fts WHERE concept_nodes_fts MATCH ?",
      )
      .get("백설공주") as { concept_id: string } | null;
    expect(hit).not.toBeNull();
    expect(hit!.concept_id).toBe(cid);
  });

  test("addConceptAlias — 빈 별칭·없는 개념 loud throw", async () => {
    const cid = await repo.findOrCreateConcept("괴담 (소설/백덕수)", {
      isClassificationValue: true,
    });
    // 없는 개념 — conceptId 를 담아 throw.
    await expect(repo.addConceptAlias("cpt_없음", "x")).rejects.toThrow(/cpt_없음/);
    // 빈 별칭(공백뿐) — conceptId 를 담아 throw.
    await expect(repo.addConceptAlias(cid, "   ")).rejects.toThrow(/non-empty/);
    await expect(repo.addConceptAlias(cid, "")).rejects.toThrow(/non-empty/);
  });

  test("addConceptAlias — DB 변경 시 db_revision bump, 멱등 no-op 은 무관", async () => {
    let bumped = 0;
    const repo2 = new ConceptRepository(db, embedder, () => {
      bumped += 1;
    });
    const cid = await repo2.findOrCreateConcept("괴담 (소설/백덕수)", {
      isClassificationValue: true,
    });
    const before = bumped;
    await repo2.addConceptAlias(cid, "괴담");
    expect(bumped).toBeGreaterThan(before);
  });
});

// ── NFD 재입력 회귀(정규화 전수 점검 T6) ──────────────────────────────────────
// concept_nodes.name 은 조회 키와 INSERT 값이 같은 문자열에서 나와야 한다. 한글
// 조합형(NFD)으로 들어온 같은 개념이 완성형(NFC) 기존 행을 못 찾으면 재입력마다
// 개념 사본이 쌓인다(LightRAG #3367 계열 결함).
describe("ConceptRepository — NFD 재입력 정규화", () => {
  let db: Database;
  let repo: ConceptRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new ConceptRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("findOrCreateConcept — NFD 재입력이 NFC 기존 개념으로 수렴(사본 0)", async () => {
    const nfc = "주술회전";
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);

    const first = await repo.findOrCreateConcept(nfc, { isTag: true });
    const second = await repo.findOrCreateConcept(nfd, { isTag: true });

    expect(second).toBe(first);
    const cnt = db
      .query("SELECT COUNT(*) AS c FROM concept_nodes")
      .get() as { c: number };
    expect(cnt.c).toBe(1);
  });

  test("findConceptByName — NFD 질의가 NFC 저장 개념을 찾는다", async () => {
    const nfc = "주술회전";
    const conceptId = await repo.findOrCreateConcept(nfc, { isTag: true });

    const found = await repo.findConceptByName(nfc.normalize("NFD"));
    expect(found?.conceptId).toBe(conceptId);
  });
});
