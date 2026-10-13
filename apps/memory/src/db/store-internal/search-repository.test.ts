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
import { SqliteMemoryStore } from "../store.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("SearchRepository — 자산 글 검색 + 개념 펼침", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => db.close());

  test("자산 글 벡터 검색 안 깨짐 (개념 분리 후에도)", async () => {
    await store.addNode({ content: "주술회전 고죠가 좋다" });
    const hits = await store.searchByVector("주술회전", 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  test("hasImageVecRows — image_vec 비었으면 false, row 있으면 true", () => {
    expect(store.hasImageVecRows()).toBe(false);

    db.prepare("INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)").run(
      999,
      new Float32Array(768),
    );

    expect(store.hasImageVecRows()).toBe(true);
  });

  test("getNodeConcepts — 한 글에 붙은 개념 + role", async () => {
    const nodeId = await store.addNode({ content: "어제 만화를 봤다" });
    const cid = await store.findOrCreateTagConcept("만화");
    await store.addNodeConceptEdge(nodeId, cid, "tag", "user_input", nodeId);
    const concepts = await store.getNodeConcepts(nodeId);
    expect(concepts.length).toBe(1);
    expect(concepts[0]!.concept.name).toBe("만화");
    expect(concepts[0]!.role).toBe("tag");
  });

  test("getConceptDirectNeighbors — 직접 이웃 1단계만 (2단계 생략)", async () => {
    const jjk = await store.findOrCreateTagConcept("주술회전");
    const manga = await store.findOrCreateTagConcept("만화");
    const onepiece = await store.findOrCreateTagConcept("원피스");
    // 주술회전 → 만화, 원피스 → 만화 (2단계: 주술회전에서 보면 원피스는 직접 이웃 아님)
    await store.addConceptEdge({ sourceConceptId: jjk, targetConceptId: manga, relation: "parent_of" ,
    provenance: "user_input",
    sourceNodeId: null,
});
    await store.addConceptEdge({ sourceConceptId: onepiece, targetConceptId: manga, relation: "parent_of" ,
    provenance: "user_input",
    sourceNodeId: null,
});
    const neighbors = await store.getConceptDirectNeighbors(jjk);
    const names = neighbors.map((n) => n.concept.name);
    expect(names).toContain("만화");        // 1단계
    expect(names).not.toContain("원피스");   // 2단계 — 생략
  });

  test("getNodeConceptExpansion — 직접 개념 + 이웃 1단계, 2단계 생략", async () => {
    // A(주술회전) → B(만화) → C(엔터테인먼트) 위계.
    const a = await store.findOrCreateTagConcept("주술회전");
    const b = await store.findOrCreateTagConcept("만화");
    const cc = await store.findOrCreateTagConcept("엔터테인먼트");
    await store.addConceptEdge({ sourceConceptId: a, targetConceptId: b, relation: "parent_of" ,
    provenance: "user_input",
    sourceNodeId: null,
});
    await store.addConceptEdge({ sourceConceptId: b, targetConceptId: cc, relation: "parent_of" ,
    provenance: "user_input",
    sourceNodeId: null,
});
    const nid = await store.addNode({ content: "고죠가 죽었어" });
    await store.addNodeConceptEdge(nid, a, "tag", "user_input", nid); // 노드 직접 개념 = A

    const exp = await store.getNodeConceptExpansion(nid);
    expect(exp.direct.map((d) => d.concept.conceptId)).toContain(a);
    const neighborIds = exp.neighbors.map((n) => n.concept.conceptId);
    expect(neighborIds).toContain(b);       // A 의 1단계 이웃 = B
    expect(neighborIds).not.toContain(cc);  // C 는 2단계 → 생략
  });

  test("개념 없는 노드 = 빈 펼침(에러 X)", async () => {
    const nid = await store.addNode({ content: "아무 개념 없음" });
    const exp = await store.getNodeConceptExpansion(nid);
    expect(exp.direct).toEqual([]);
    expect(exp.neighbors).toEqual([]);
  });
});

describe("searchByFts — 듀얼 색인 union", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  beforeEach(async () => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    await store.addNode({ content: "사용자는 커피를 좋아한다" }); // 2글자 "커피"
    await store.addNode({ content: "변경이유는 옛 방식이 흠" });   // 합성어 "변경이유"
    await store.addNode({ content: "디스코드봇으로 입력" });       // 합성어 "디스코드봇"
  });
  afterEach(() => {
    db.close();
  });

  test("2글자 검색어 보존 — unicode61 본색인 경로", async () => {
    const hits = await store.searchByFts("커피", 10);
    // 단순 trigram 전환이었다면 0건이 됐을 검색어. 본색인이 보호한다.
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  test("3글자+ 합성어 부분 매치 — trigram 보조 색인 추가분", async () => {
    const hits = await store.searchByFts("변경이유", 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hits2 = await store.searchByFts("디스코드", 10);
    expect(hits2.length).toBeGreaterThanOrEqual(1);
  });

  test("전부 2글자 검색어 — trigram 후보 0 자연 degrade(에러 X)", async () => {
    const hits = await store.searchByFts("커피", 10); // trigram 쿼리 빈 문자열 경로
    expect(Array.isArray(hits)).toBe(true);
  });

  test("FtsHit.score number 계약 보존", async () => {
    const hits = await store.searchByFts("커피", 10);
    expect(typeof hits[0]!.score).toBe("number");
  });

  test("빈/메타문자 쿼리는 빈 배열 (두 색인 모두 빈 쿼리)", async () => {
    expect(await store.searchByFts("", 10)).toEqual([]);
    expect(await store.searchByFts("*+-", 10)).toEqual([]);
  });
});

describe("개념 매칭 채널 — searchConceptsByFts / getNodesByConcepts (1.1a T5)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => db.close());

  test("searchConceptsByFts — 글자 매칭으로 개념 후보", async () => {
    // findOrCreateTagConcept 가 concept_nodes INSERT → 트리거가 concept_nodes_fts 동기.
    // concept_nodes_fts 는 trigram 토크나이저(기준 스키마) — 연속 3 코드포인트만
    // 색인한다. 그래서 매칭 검색어는 최소 3글자여야 한다("주술" 2글자는 trigram
    // 후보 0개 / 아래 graceful 케이스). "주술회" 가 본문 "주술회전" 의 3-gram 과 매칭.
    await store.findOrCreateTagConcept("주술회전");
    const hits = await store.searchConceptsByFts("주술회", 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  test("getNodesByConcepts — 개념 → 연결 자산 글(자산만)", async () => {
    const cid = await store.findOrCreateTagConcept("커피");
    const nid = await store.addNode({ content: "오늘 커피 마셨다" });
    await store.addNodeConceptEdge(nid, cid, "tag", "user_input", nid);
    const nodes = await store.getNodesByConcepts([cid], 10);
    expect(nodes).toContain(nid);
  });

  test("graceful — 개념 색인 비면 개념 채널 빈 결과(에러 X)", async () => {
    const hits = await store.searchConceptsByFts("없는개념", 5);
    expect(hits).toEqual([]);
    const nodes = await store.getNodesByConcepts([], 10);
    expect(nodes).toEqual([]);
  });

  // ── polarity 후보 축소(1.1c T3 / spec 5.5 / D7) ─────────────────────────
  describe("filterNodeIdsByPolarity — 후보 polarity 축소", () => {
    test("일치 polarity 만 남기고 다른 polarity·NULL 제외", async () => {
      const pos = await store.addNode({ content: "긍정 디자인", polarity: "positive" });
      const neg = await store.addNode({ content: "부정 디자인", polarity: "negative" });
      const neu = await store.addNode({ content: "무난 디자인", polarity: "neutral" });
      const nul = await store.addNode({ content: "라벨 없는 디자인" }); // NULL

      const allowed = store.filterNodeIdsByPolarity([pos, neg, neu, nul], "positive");
      expect(allowed.has(pos)).toBe(true);
      expect(allowed.has(neg)).toBe(false);
      expect(allowed.has(neu)).toBe(false);
      expect(allowed.has(nul)).toBe(false); // NULL = 라벨 없음 → 제외(의도된 필터 의미)
      expect(allowed.size).toBe(1);
    });

    test("rowToNode 가 polarity 를 도메인 노드에 노출(positive·NULL 구분)", async () => {
      const pos = await store.addNode({ content: "환한 디자인", polarity: "positive" });
      const nul = await store.addNode({ content: "그냥 디자인" }); // NULL
      const posNode = await store.getNode(pos);
      const nulNode = await store.getNode(nul);
      expect(posNode!.polarity).toBe("positive");
      expect(nulNode!.polarity).toBe(null); // 라벨 없으면 NULL — 데이터 누락 아님
    });

    test("후보 0개 또는 일치 0개 = 빈 Set(에러 아님)", async () => {
      const nul = await store.addNode({ content: "라벨 없는 노드만" }); // NULL
      // 후보는 있으나 positive 라벨 0개 → 빈 Set(정직한 빈 상태).
      const allowed = store.filterNodeIdsByPolarity([nul], "positive");
      expect(allowed.size).toBe(0);
      // 후보 자체가 0개 → 빈 Set.
      expect(store.filterNodeIdsByPolarity([], "positive").size).toBe(0);
    });
  });

  // ── 학술 분류 필터(1.1c T4 / spec 5.7) ──────────────────────────────────
  describe("getNodeIdsByConceptName — 분류 값 → 연결 자산(name UNIQUE 통합)", () => {
    test("name UNIQUE 통합 — #만화 태그 자산 + review:만화 분류 자산이 한 query 로 둘 다 잡힘", async () => {
      // (A) `#만화` 해시태그 통로로 들어간 자산 — role='tag'.
      const tagNode = await store.addNode({ content: "오늘 본 만화 정리" });
      const cidTag = await store.findOrCreateTagConcept("만화");
      await store.addNodeConceptEdge(tagNode, cidTag, "tag", "user_input", tagNode);

      // (B) `review:만화` 분류 통로로 들어간 자산 — role='classification'.
      //     findOrCreateConcept 가 같은 이름 = 같은 노드라 cidTag 와 동일 conceptId.
      const classNode = await store.addNode({ content: "리뷰 단 작품 하나" });
      const cidClass = await store.findOrCreateConcept("만화", {
        isClassificationValue: true,
      });
      await store.addNodeConceptEdge(classNode, cidClass, "classification", "user_input", classNode);

      // name UNIQUE 자동 통합 — 두 통로가 같은 `만화` concept 노드를 가리킨다.
      expect(cidClass).toBe(cidTag);

      // filter.review=만화 (또는 filter.character=...) 한 query → 분류 값 '만화'
      // 으로 name UNIQUE 매칭 → role 무관 연결 자산 회수. 두 자산 다 잡혀야 한다.
      const matched = store.getNodeIdsByConceptName("만화");
      expect(matched.has(tagNode)).toBe(true); // #만화 태그 통로 자산
      expect(matched.has(classNode)).toBe(true); // review:만화 분류 통로 자산
      expect(matched.size).toBe(2);
    });

    test("다른 분류 값 자산은 정확히 제외(후보 줄임)", async () => {
      const mangaNode = await store.addNode({ content: "만화 자산" });
      const cidManga = await store.findOrCreateTagConcept("만화");
      await store.addNodeConceptEdge(mangaNode, cidManga, "classification", "user_input", mangaNode);

      const novelNode = await store.addNode({ content: "소설 자산" });
      const cidNovel = await store.findOrCreateTagConcept("소설");
      await store.addNodeConceptEdge(novelNode, cidNovel, "classification", "user_input", novelNode);

      const matched = store.getNodeIdsByConceptName("만화");
      expect(matched.has(mangaNode)).toBe(true);
      expect(matched.has(novelNode)).toBe(false); // 다른 분류 값 자산 제외
    });

    test("값 매칭 — 입력 대소문자·공백 정규화(저장 시점 lowercase 정합)", async () => {
      // findOrCreateConcept 가 name 을 lowercase 저장하므로 영문 값도 매칭돼야 한다.
      const node = await store.addNode({ content: "흰머리토끼귀 캐릭터 메모" });
      const cid = await store.findOrCreateConcept("Manga", {
        isClassificationValue: true,
      });
      await store.addNodeConceptEdge(node, cid, "classification", "user_input", node);
      // 입력이 대문자·공백 포함이어도 저장된 lowercase name 과 매칭.
      const matched = store.getNodeIdsByConceptName("  MANGA  ");
      expect(matched.has(node)).toBe(true);
    });

    test("graceful — 매칭 concept 0개면 빈 Set(에러 아님)", async () => {
      await store.addNode({ content: "아무 분류 없는 자산" });
      const matched = store.getNodeIdsByConceptName("존재하지않는분류값");
      expect(matched.size).toBe(0); // 정직한 빈 상태 — "그 분류 라벨 자산 없음".
      // 빈/공백 값도 빈 Set(에러 아님).
      expect(store.getNodeIdsByConceptName("").size).toBe(0);
      expect(store.getNodeIdsByConceptName("   ").size).toBe(0);
    });
  });

  // ── 인접 청크 조회(14b T1 / 14.5 토대) ───────────────────────────────────
  describe("getNeighborChunks — 같은 문서 인접 청크 조회", () => {
    /** 한 문서의 document_chunk 노드 N개를 chunkIndex 0..count-1 로 넣는다. */
    async function ingestChunks(parentId: string, count: number): Promise<number[]> {
      const ids: number[] = [];
      for (let i = 0; i < count; i++) {
        const id = await store.addNode({
          content: `${parentId} 청크 ${i}`,
          sourceType: "document_chunk",
          metadata: {
            parentId,
            chunkIndex: i,
            assetSha256: "sha_" + parentId,
            headingPath: [parentId, `섹션 ${i}`],
            headingTitle: `섹션 ${i}`,
            headingDepth: 2,
            parentHeadingPath: [parentId],
            sectionChunkIndex: 0,
            sectionChunkCount: 1,
            chunkingStrategy: "heading_path",
          },
        });
        ids.push(id);
      }
      return ids;
    }

    test("같은 문서의 radius 인접 청크를 chunkIndex 오름차순으로 반환(중심 제외)", async () => {
      const ids = await ingestChunks("doc_x", 6); // chunkIndex 0..5
      const neighbors = await store.getNeighborChunks("doc_x", 3, 1);
      // radius 1 → [2, 4] (중심 3 제외).
      expect(neighbors.map((n) => n.chunkIndex)).toEqual([2, 4]);
      expect(neighbors[0]!.id).toBe(ids[2]!);
      expect(neighbors[1]!.id).toBe(ids[4]!);
      expect(neighbors[0]!.content).toBe("doc_x 청크 2");
      expect(neighbors[0]!.headingPath).toEqual(["doc_x", "섹션 2"]);
      expect(neighbors[0]!.headingTitle).toBe("섹션 2");
      expect(neighbors[0]!.headingDepth).toBe(2);
      expect(neighbors[0]!.parentHeadingPath).toEqual(["doc_x"]);
      expect(neighbors[0]!.sectionChunkIndex).toBe(0);
      expect(neighbors[0]!.sectionChunkCount).toBe(1);
      expect(neighbors[0]!.chunkingStrategy).toBe("heading_path");
    });

    test("radius 2 — 양쪽 두 칸씩(중심 제외, 오름차순)", async () => {
      await ingestChunks("doc_x", 6);
      const neighbors = await store.getNeighborChunks("doc_x", 3, 2);
      // radius 2 → [1, 2, 4, 5] (중심 3 제외).
      expect(neighbors.map((n) => n.chunkIndex)).toEqual([1, 2, 4, 5]);
    });

    test("문서 시작/끝 경계 — 범위 밖 인접은 자연 생략", async () => {
      await ingestChunks("doc_x", 4); // chunkIndex 0..3
      // 중심 0, radius 1 → [-1, 1] 범위에서 0 제외 → [1] 만(음수 인덱스 청크 없음).
      const start = await store.getNeighborChunks("doc_x", 0, 1);
      expect(start.map((n) => n.chunkIndex)).toEqual([1]);
      // 중심 3(마지막), radius 1 → [2, 4] 범위에서 3 제외 → [2] 만(4 청크 없음).
      const end = await store.getNeighborChunks("doc_x", 3, 1);
      expect(end.map((n) => n.chunkIndex)).toEqual([2]);
    });

    test("다른 문서 청크는 안 섞임(parentId 격리)", async () => {
      await ingestChunks("doc_x", 6);
      await ingestChunks("doc_y", 6);
      const neighbors = await store.getNeighborChunks("doc_x", 3, 2);
      // doc_y 청크는 전혀 포함되지 않는다 — 모두 doc_x 콘텐츠.
      expect(neighbors.every((n) => n.content.startsWith("doc_x"))).toBe(true);
      expect(neighbors.map((n) => n.chunkIndex)).toEqual([1, 2, 4, 5]);
    });

    test("document_chunk 가 아닌 노드는 매칭 안 됨", async () => {
      // 같은 parentId·chunkIndex metadata 를 가진 *일반* 노드(source_type 다름).
      await store.addNode({
        content: "가짜 청크 — 일반 노드",
        metadata: { parentId: "doc_z", chunkIndex: 2 },
      });
      await store.addNode({
        content: "doc_z 진짜 청크 3",
        sourceType: "document_chunk",
        metadata: { parentId: "doc_z", chunkIndex: 3 },
      });
      // 중심 3, radius 1 → [2, 4] 범위. chunkIndex 2 는 document_chunk 가 아니므로 제외.
      const neighbors = await store.getNeighborChunks("doc_z", 3, 1);
      expect(neighbors).toEqual([]);
    });

    test("없는 parentId / 인접 0개 = 빈 배열(에러 아님)", async () => {
      await ingestChunks("doc_x", 6);
      // 존재하지 않는 문서.
      expect(await store.getNeighborChunks("doc_없음", 3, 1)).toEqual([]);
      // radius 0 → 인접 없음(중심만 범위인데 중심 제외) → 빈 배열.
      expect(await store.getNeighborChunks("doc_x", 3, 0)).toEqual([]);
    });
  });

  // ── pending_review 검색 비노출 필터(6a T9.5 / 사용자 결정 #5) ───────────────
  describe("filterOutPendingReview — pending_review 후보 제외", () => {
    test("metadata.pending_review=true 만 제외 / false·없음·NULL 통과", async () => {
      // (a) pending_review:true (regex 3~4점 갈래 metadata) — 제외 대상.
      const pending = await store.addNode({
        content: "검토 대기 결정 메모",
        metadata: { source: "regex", pending_review: true },
      });
      // (b) pending_review:false (regex auto_store 갈래는 이 칸을 안 넣지만, false 도 통과해야 함).
      const explicitFalse = await store.addNode({
        content: "명시 false 메모",
        metadata: { source: "regex", pending_review: false },
      });
      // (c) pending_review 칸 없음 (일반 노드 metadata).
      const noKey = await store.addNode({
        content: "일반 메모",
        metadata: { source: "discord" },
      });
      // (d) metadata 자체가 빈 객체 → 추출 시 NULL.
      const emptyMeta = await store.addNode({ content: "메타 없는 메모" });

      const surviving = store.filterOutPendingReview([
        pending,
        explicitFalse,
        noKey,
        emptyMeta,
      ]);
      expect(surviving.has(pending)).toBe(false); // true 만 제외
      expect(surviving.has(explicitFalse)).toBe(true);
      expect(surviving.has(noKey)).toBe(true);
      expect(surviving.has(emptyMeta)).toBe(true);
      expect(surviving.size).toBe(3);
    });

    test("JSON boolean true 가 ->> 로 추출될 때의 실측 — true 행만 제외됨", async () => {
      // buildRegexMetadata 의 pending_review:true 가 JSON.stringify 시 boolean true 로
      // 직렬화되고, SQLite metadata_json->>'$.pending_review' 가 이를 정수 1 로 추출한다
      // (문자열 'true' 가 아니다). filterOutPendingReview 는 이 실측 동작에 맞춰
      // 정수 1(=JSON true)인 행만 제외한다.
      const t1 = await store.addNode({
        content: "true 1",
        metadata: { pending_review: true },
      });
      const t2 = await store.addNode({
        content: "true 2 추가 칸",
        metadata: { source: "regex", pending_review: true, regex_score: 3 },
      });
      const ok = await store.addNode({
        content: "통과 노드",
        metadata: { pending_review: false },
      });
      const surviving = store.filterOutPendingReview([t1, t2, ok]);
      expect(surviving.has(t1)).toBe(false);
      expect(surviving.has(t2)).toBe(false);
      expect(surviving.has(ok)).toBe(true);
    });

    test("후보 0개 = 빈 Set(에러 아님)", () => {
      expect(store.filterOutPendingReview([]).size).toBe(0);
    });

    test("pending_review 노드가 0건이면 전 후보 통과(회귀 0 경로)", async () => {
      const a = await store.addNode({ content: "노드 A" });
      const b = await store.addNode({
        content: "노드 B",
        metadata: { source: "discord" },
      });
      const surviving = store.filterOutPendingReview([a, b]);
      expect(surviving.has(a)).toBe(true);
      expect(surviving.has(b)).toBe(true);
      expect(surviving.size).toBe(2); // 한 노드도 줄지 않음
    });
  });
});

describe("getNodesByConcepts — 8 타입 엔티티 행 id 분기 (위계 단일 출처 S2-T2 §7.2 b)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => db.close());

  // ── FK 충족용 실제 INSERT 헬퍼(entity-relation-search.test.ts 양식 그대로) ──
  function insertConcept(conceptId: string, name: string): void {
    db.prepare("INSERT INTO concept_nodes (concept_id, name) VALUES (?, ?)").run(
      conceptId,
      name,
    );
  }
  // 분류 단계4 T4 — 8 타입 엔티티 행은 죽은 전용 테이블(places·works)이 아니라 범용
  // 본체 entities 에 산다. identity 엣지도 통합 entity_concept_edges(entity_id 끝점·
  // FK→entities)에 깐다. 헬퍼가 그 통로로 INSERT 한다(실 production 저장 모양 재현).
  function insertEntityRow(entityId: string, typeName: string, name: string): void {
    db.prepare(
      `INSERT INTO entities (entity_id, type_name, name, created_at, updated_at)
       VALUES (?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    ).run(entityId, typeName, name);
  }
  function insertPlace(placeId: string, name: string): void {
    insertEntityRow(placeId, "place", name);
  }
  function insertWork(workId: string, name: string): void {
    insertEntityRow(workId, "work", name);
  }
  function insertNode(content: string): number {
    const r = db
      .prepare("INSERT INTO knowledge_nodes (content) VALUES (?)")
      .run(content);
    return Number(r.lastInsertRowid);
  }
  /**
   * 엔티티 행 ↔ 위계 잎 개념을 role='identity' 로 잇는다(통합 엣지·단계4 T4). 옛
   * (table, idColumn) 인자는 통합 테이블 수렴 후 의미가 없어 무시한다 — 호출처 변경
   * 최소화를 위해 시그니처만 유지하고 entity_concept_edges(entity_id)에 한 곳으로 쓴다.
   */
  function linkIdentity(
    _table: string,
    _idColumn: string,
    rowId: string,
    conceptId: string,
  ): void {
    db.prepare(
      `INSERT INTO entity_concept_edges (entity_id, concept_id, role, created_at, provenance, source_node_id) VALUES (?, ?, 'identity', '2026-01-01 00:00:00', 'user_input', NULL)`,
    ).run(rowId, conceptId);
  }
  /** 글 ↔ 잎 개념 mention(분류 엣지) — 흡수 없이 행 → 글 도달의 마지막 다리. */
  function linkNodeConcept(nodeId: number, conceptId: string): void {
    db.prepare(
      `INSERT INTO node_concept_edges (node_id, concept_id, role, provenance, source_node_id) VALUES (?, ?, 'classification', 'user_input', NULL)`,
    ).run(nodeId, conceptId);
  }

  test("place 행 id → identity 잎 개념 → 그 행 언급 글 회수(흡수 없이 행→글 도달)", async () => {
    // `#피부과:무지개의원` 이 만드는 데이터 모양을 실제 INSERT 로 깐다:
    //   place 행 plc_rainbow + 잎 개념 cpt_rainbow(role='identity') + 그 개념 언급 글.
    insertPlace("plc_rainbow", "무지개의원");
    insertConcept("cpt_rainbow", "무지개의원");
    linkIdentity("place_concept_edges", "place_id", "plc_rainbow", "cpt_rainbow");
    const visitNode = insertNode("무지개의원 피부과 다녀옴");
    linkNodeConcept(visitNode, "cpt_rainbow");

    // 위계 펼침이 plc_ 행 id 를 conceptIds 에 넣은 상황을 직접 재현.
    const nodes = await store.getNodesByConcepts(["plc_rainbow"], 10);
    expect(nodes).toContain(visitNode);
  });

  test("8 타입 행 id 0 개(개념·psn_ 만) 입력 = 옛 동작과 동일(회귀 0)", async () => {
    // 평범한 개념 통로 글 하나.
    const cid = await store.findOrCreateTagConcept("커피");
    const nid = await store.addNode({ content: "오늘 커피 마셨다" });
    await store.addNodeConceptEdge(nid, cid, "tag", "user_input", nid);

    // 8 타입 행 id 가 전혀 없는 입력 — 8 타입 분기가 통째로 건너뛴다.
    const onlyConcept = await store.getNodesByConcepts([cid], 10);
    expect(onlyConcept).toEqual([nid]);

    // place 행과 그 글이 DB 에 있어도, 입력에 plc_ 가 없으면 안 끌려온다(byte 동일).
    insertPlace("plc_noise", "무관장소");
    insertConcept("cpt_noise", "무관장소");
    linkIdentity("place_concept_edges", "place_id", "plc_noise", "cpt_noise");
    const noiseNode = insertNode("무관 장소 글");
    linkNodeConcept(noiseNode, "cpt_noise");

    const stillOnlyConcept = await store.getNodesByConcepts([cid], 10);
    expect(stillOnlyConcept).toEqual([nid]); // 결과 불변 — place 글 안 섞임.
  });

  test("conceptRank 정렬이 행 id 의 입력 순위를 따른다(여러 타입 섞임)", async () => {
    // work 행과 place 행을 각자 잎 개념 + 글로 깐다.
    insertWork("wrk_jjk", "주술회전");
    insertConcept("cpt_jjk", "주술회전");
    linkIdentity("work_concept_edges", "work_id", "wrk_jjk", "cpt_jjk");
    const jjkNode = insertNode("주술회전 감상");
    linkNodeConcept(jjkNode, "cpt_jjk");

    insertPlace("plc_cafe", "동네카페");
    insertConcept("cpt_cafe", "동네카페");
    linkIdentity("place_concept_edges", "place_id", "plc_cafe", "cpt_cafe");
    const cafeNode = insertNode("동네카페 다녀옴");
    linkNodeConcept(cafeNode, "cpt_cafe");

    // 입력 순위: place 행이 0번(가장 강함), work 행이 1번. 그 순서로 정렬돼야 한다.
    const placeFirst = await store.getNodesByConcepts(["plc_cafe", "wrk_jjk"], 10);
    expect(placeFirst).toEqual([cafeNode, jjkNode]);

    // 순서를 뒤집으면 정렬도 뒤집힌다 — 행 id 입력 순위가 conceptRank 에 반영됨.
    const workFirst = await store.getNodesByConcepts(["wrk_jjk", "plc_cafe"], 10);
    expect(workFirst).toEqual([jjkNode, cafeNode]);
  });

  test("8 타입 행 + 개념 + psn_ 섞여도 각 통로로 풀어 합류한다", async () => {
    // 개념 통로 글.
    const cid = await store.findOrCreateTagConcept("일기");
    const diaryNode = await store.addNode({ content: "오늘의 일기" });
    await store.addNodeConceptEdge(diaryNode, cid, "tag", "user_input", diaryNode);

    // psn_ 통로 글(node_person_edges).
    const psn = await store.findOrCreatePerson({
      displayName: "박대웅",
      userId: "u_park",
    });
    const personNode = await store.addNode({ content: "박대웅과 점심" });
    await store.addNodePersonEdge(personNode, psn.personId, "mentions", "user_input", personNode);

    // place 행 통로 글.
    insertPlace("plc_park", "한강공원");
    insertConcept("cpt_park", "한강공원");
    linkIdentity("place_concept_edges", "place_id", "plc_park", "cpt_park");
    const placeNode = insertNode("한강공원 산책");
    linkNodeConcept(placeNode, "cpt_park");

    const nodes = await store.getNodesByConcepts(
      [cid, psn.personId, "plc_park"],
      10,
    );
    expect(nodes).toContain(diaryNode); // 개념 통로
    expect(nodes).toContain(personNode); // psn_ 통로
    expect(nodes).toContain(placeNode); // 8 타입 행 통로
  });

  // ── T8: listPlaceLeafNames 통합 엣지 검증 ──────────────────────────────────
  // 재배선은 단계4 T4 가 흡수했다 — listPlaceLeafNames 가 옛 place_concept_edges 가 아니라
  // 범용 entity_concept_edges(role='identity') + entities(type_name='place')를 읽는다.
  // T8 은 그 통로를 검증으로 확인한다(직접 입력 identity 장소·정렬·빈 상태·종류 가름).
  // 위 describe 의 insertPlace·insertConcept·insertWork·linkIdentity 헬퍼를 재사용한다.

  test("listPlaceLeafNames — 통합 엣지(entity_concept_edges identity) 장소를 회신", () => {
    // place 엔티티 + identity 엣지(통합 테이블)를 직접 깐다 — 직접 입력(#장소) 통로 모양.
    insertPlace("plc_t8", "무지개의원");
    insertConcept("cpt_t8", "무지개의원");
    linkIdentity("place_concept_edges", "place_id", "plc_t8", "cpt_t8");
    expect(store.listPlaceLeafNames()).toContain("무지개의원");
  });

  test("listPlaceLeafNames — 장소 0건이면 빈 배열(정직한 빈 상태)", () => {
    expect(store.listPlaceLeafNames()).toEqual([]);
  });

  test("listPlaceLeafNames — 정렬 length(name) DESC·name ASC 보존(긴 이름 우선)", () => {
    // 긴 이름이 먼저 와 호출처(자연어 장소 신호 감지)가 가장 긴 매칭을 먼저 만난다.
    insertPlace("plc_a", "강남");
    insertConcept("cpt_a", "강남");
    linkIdentity("place_concept_edges", "place_id", "plc_a", "cpt_a");
    insertPlace("plc_b", "강남에이마트");
    insertConcept("cpt_b", "강남에이마트");
    linkIdentity("place_concept_edges", "place_id", "plc_b", "cpt_b");
    const names = store.listPlaceLeafNames();
    expect(names.indexOf("강남에이마트")).toBeLessThan(names.indexOf("강남"));
  });

  test("listPlaceLeafNames — place 아닌 종류의 identity 잎은 안 섞인다(type_name='place' 가름)", () => {
    // 통합 엣지에 work identity 가 같이 있어도 listPlaceLeafNames 는 place 잎만 회신한다.
    insertPlace("plc_only", "장소잎");
    insertConcept("cpt_place", "장소잎");
    linkIdentity("place_concept_edges", "place_id", "plc_only", "cpt_place");
    insertWork("wrk_only", "작품잎");
    insertConcept("cpt_work", "작품잎");
    linkIdentity("work_concept_edges", "work_id", "wrk_only", "cpt_work");
    const names = store.listPlaceLeafNames();
    expect(names).toContain("장소잎");
    expect(names).not.toContain("작품잎");
  });
});

describe("프로젝트·사람 엔티티 검색 3채널 + memory_type 필터 (1.2 T7)", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => db.close());

  test("searchProjectsByFts — projects_fts 글자 매칭(≥3글자)", async () => {
    const prj = await store.findOrCreateProject({
      name: "바라시스템",
      summary: "어디든 붙는 메모리 모듈",
    });
    const hits = await store.searchProjectsByFts("바라시스템", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.projectId).toBe(prj.projectId);
    expect(typeof hits[0]!.score).toBe("number");
  });

  test("searchProjectsByVector — project_summary_vec KNN hit", async () => {
    const prj = await store.findOrCreateProject({
      name: "주술회전 자료집",
      summary: "고죠 사토루 캐릭터 정리",
    });
    await store.applyProjectEmbedding(prj.projectId);
    const queryVec = await embedder.embed("주술회전 고죠");
    const hits = await store.searchProjectsByVector(queryVec, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.projectId)).toContain(prj.projectId);
    expect(typeof hits[0]!.distance).toBe("number");
  });

  test("searchProjectsByVector — 차원 불일치 throw", async () => {
    const wrong = new Float32Array(embedder.dimension + 1);
    await expect(store.searchProjectsByVector(wrong, 5)).rejects.toThrow(
      /dim mismatch/,
    );
  });

  test("searchPersonsByFts — persons_fts 글자 매칭(≥3글자)", async () => {
    const psn = await store.findOrCreatePerson({
      displayName: "김민수개발자",
      userId: "u_kim",
    });
    const hits = await store.searchPersonsByFts("김민수개발자", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.personId).toBe(psn.personId);
  });

  test("searchPersonsByVector — person_vec KNN hit + 차원 불일치 throw", async () => {
    const psn = await store.findOrCreatePerson({
      displayName: "고죠사토루",
      userId: "u_gojo",
    });
    await store.applyPersonEmbedding(psn.personId);
    const queryVec = await embedder.embed("고죠사토루");
    const hits = await store.searchPersonsByVector(queryVec, 5);
    expect(hits.map((h) => h.personId)).toContain(psn.personId);

    const wrong = new Float32Array(embedder.dimension + 1);
    await expect(store.searchPersonsByVector(wrong, 5)).rejects.toThrow(
      /dim mismatch/,
    );
  });

  test("getNodesByProjectId — project_id 일치 글만 후보로 끌어온다", async () => {
    const prj = await store.findOrCreateProject({ name: "테스트프로젝트" });
    const inA = await store.addNode({
      content: "프로젝트 글 A",
      project_id: prj.projectId,
    });
    const inB = await store.addNode({
      content: "프로젝트 글 B",
      project_id: prj.projectId,
    });
    // project_id 없는 글 — 끌려오면 안 됨.
    await store.addNode({ content: "무관 글" });

    const ids = store.getNodesByProjectId(prj.projectId, 10);
    expect(ids.sort()).toEqual([inA, inB].sort());
  });

  test("getNodesByProjectId — 글 없는 프로젝트는 빈 배열(에러 아님)", async () => {
    const prj = await store.findOrCreateProject({ name: "빈프로젝트" });
    expect(store.getNodesByProjectId(prj.projectId, 10)).toEqual([]);
    // 빈 인자도 빈 배열.
    expect(store.getNodesByProjectId("", 10)).toEqual([]);
  });

  test("참여자 양방향 1-hop — getProjectParticipantPersonIds / getPersonProjectIds", async () => {
    const prj = await store.findOrCreateProject({ name: "협업프로젝트" });
    const p1 = await store.findOrCreatePerson({
      displayName: "참여자1",
      userId: "u1",
    });
    const p2 = await store.findOrCreatePerson({
      displayName: "참여자2",
      userId: "u2",
    });
    await store.addProjectPersonEdge(prj.projectId, p1.personId, "creator", "user_input", null);
    await store.addProjectPersonEdge(prj.projectId, p2.personId, "participant", "user_input", null);

    const participants = store.getProjectParticipantPersonIds(prj.projectId);
    expect(participants.sort()).toEqual([p1.personId, p2.personId].sort());

    const p1Projects = store.getPersonProjectIds(p1.personId);
    expect(p1Projects).toEqual([prj.projectId]);
  });

  test("참여자 — 같은 사람 여러 role 이어도 person_id 1개로 묶는다(DISTINCT)", async () => {
    const prj = await store.findOrCreateProject({ name: "다중역할프로젝트" });
    const p1 = await store.findOrCreatePerson({
      displayName: "겸직자",
      userId: "u_multi",
    });
    await store.addProjectPersonEdge(prj.projectId, p1.personId, "creator", "user_input", null);
    await store.addProjectPersonEdge(prj.projectId, p1.personId, "contributor", "user_input", null);

    const participants = store.getProjectParticipantPersonIds(prj.projectId);
    expect(participants).toEqual([p1.personId]); // 중복 없음
  });

  test("참여자 — 참여자/프로젝트 0개면 빈 배열(에러 아님)", async () => {
    const prj = await store.findOrCreateProject({ name: "외톨이프로젝트" });
    const psn = await store.findOrCreatePerson({
      displayName: "무소속",
      userId: "u_solo",
    });
    expect(store.getProjectParticipantPersonIds(prj.projectId)).toEqual([]);
    expect(store.getPersonProjectIds(psn.personId)).toEqual([]);
    expect(store.getProjectParticipantPersonIds("")).toEqual([]);
    expect(store.getPersonProjectIds("")).toEqual([]);
  });

  test("filterNodeIdsByMemoryType — episode 만 남기고 insight/fact 는 뺀다", async () => {
    const ep = await store.addNode({
      content: "어제 회의에 갔다",
      memoryType: "episode",
    });
    const ins = await store.addNode({
      content: "회의는 비효율적이다",
      memoryType: "insight",
    });
    const ft = await store.addNode({
      content: "회의는 오후 3시다",
      memoryType: "fact",
    });

    const kept = store.filterNodeIdsByMemoryType([ep, ins, ft], "episode");
    expect(kept.has(ep)).toBe(true);
    expect(kept.has(ins)).toBe(false);
    expect(kept.has(ft)).toBe(false);
    expect(kept.size).toBe(1);
  });

  test("filterNodeIdsByMemoryType — 후보 0개 = 빈 Set(에러 아님)", () => {
    expect(store.filterNodeIdsByMemoryType([], "episode").size).toBe(0);
  });

  test("빈 색인 graceful — FTS/벡터 검색이 빈 배열 반환(에러 아님)", async () => {
    expect(await store.searchProjectsByFts("아무것도없음", 5)).toEqual([]);
    expect(await store.searchPersonsByFts("아무것도없음", 5)).toEqual([]);
    const queryVec = await embedder.embed("아무것도없음");
    expect(await store.searchProjectsByVector(queryVec, 5)).toEqual([]);
    expect(await store.searchPersonsByVector(queryVec, 5)).toEqual([]);
  });

  // ── 장소 소프트 검색 점수 (활용 단계4 T1 / search-field-filter D2) ──────────
  //
  // searchPlaceNodeScores(value) 가 장소 leaf 개념 이름 부분일치 + place 두 경로
  // OR 로 매칭된 글 node_id 마다 0..1 소프트 점수 Map 을 회신한다. 정확 일치=1.0,
  // 부분 일치=낮은 점수(매칭 길이 비율). 직접 입력(place_concept_edges identity)과
  // 추론(concept 위계 has_place 경로1) 두 통로 모두 같은 leaf 로 수렴한다.
  // 실 SQLite + setPlace public 진입점(direct/system/inferred 분기·mock 0).

  test("searchPlaceNodeScores — 정확 일치 글 점수 1.0(direct place 엔티티 경로)", async () => {
    const nid = await store.addNode({ content: "쇼핑 메모" });
    expect((await store.setPlace(nid, "강남 A마트", "direct")).wrote).toBe(true);
    const scores = store.searchPlaceNodeScores("강남 A마트");
    expect(scores.get(nid)).toBe(1.0);
  });

  test("searchPlaceNodeScores — 부분 일치 '강남' → '강남 A마트' 글 점수>0(표기 흔들림)", async () => {
    const nid = await store.addNode({ content: "쇼핑 메모" });
    expect((await store.setPlace(nid, "강남 A마트", "direct")).wrote).toBe(true);
    const scores = store.searchPlaceNodeScores("강남");
    const s = scores.get(nid);
    expect(s).toBeGreaterThan(0);
    // 부분 일치는 정확 일치(1.0)보다 작아야 한다(매칭 길이 비율 — 결정적 규칙).
    expect(s).toBeLessThan(1.0);
  });

  test("searchPlaceNodeScores — 추론(system) 경로도 매칭(concept 위계 has_place 경로1)", async () => {
    const nid = await store.addNode({ content: "거기 갔다 메모" });
    // system 출처 = concept(장소)→concept(value) 위계만(places 행 0·C-1).
    expect((await store.setPlace(nid, "속초", "system")).wrote).toBe(true);
    const scores = store.searchPlaceNodeScores("속초");
    expect(scores.get(nid)).toBe(1.0);
  });

  test("searchPlaceNodeScores — 직접·추론 두 경로가 같은 검색에서 모두 매칭", async () => {
    const direct = await store.addNode({ content: "직접 입력 장소 메모" });
    expect((await store.setPlace(direct, "강남 A마트", "direct")).wrote).toBe(true);
    const inferred = await store.addNode({ content: "추론 장소 메모" });
    expect((await store.setPlace(inferred, "강남역", "system")).wrote).toBe(true);
    // 부분일치 '강남' 이 두 통로(direct 잎 '강남 A마트' + system 잎 '강남역')를 다 잡는다.
    const scores = store.searchPlaceNodeScores("강남");
    expect(scores.get(direct)).toBeGreaterThan(0);
    expect(scores.get(inferred)).toBeGreaterThan(0);
  });

  test("searchPlaceNodeScores — 장소가 아닌 글/무관 노드는 미포함", async () => {
    const place = await store.addNode({ content: "장소 메모" });
    expect((await store.setPlace(place, "강남 A마트", "direct")).wrote).toBe(true);
    // 장소가 안 붙은 노드 — 같은 단어가 본문에 있어도 장소 leaf 매칭이 아니라 미포함.
    const nonPlace = await store.addNode({ content: "강남 스타일 노래 좋아함" });
    const scores = store.searchPlaceNodeScores("강남");
    expect(scores.has(place)).toBe(true);
    expect(scores.has(nonPlace)).toBe(false);
  });

  test("searchPlaceNodeScores — 빈 값·매칭 0건이면 빈 Map(에러·fallback 없음)", async () => {
    const nid = await store.addNode({ content: "장소 메모" });
    expect((await store.setPlace(nid, "강남 A마트", "direct")).wrote).toBe(true);
    expect(store.searchPlaceNodeScores("").size).toBe(0);
    expect(store.searchPlaceNodeScores("   ").size).toBe(0);
    expect(store.searchPlaceNodeScores("부산항대교").size).toBe(0);
  });

  test("searchPlaceNodeScores — 값 trim().toLowerCase() 정규화(getNodeIdsByConceptName 정합)", async () => {
    const nid = await store.addNode({ content: "쇼핑 메모" });
    expect((await store.setPlace(nid, "강남 A마트", "direct")).wrote).toBe(true);
    // 저장 시 concept name 은 toLowerCase 정규화('강남 a마트'). 검색 값도 같게 정규화돼야 매칭.
    expect(store.searchPlaceNodeScores("  강남 A마트  ").get(nid)).toBe(1.0);
    expect(store.searchPlaceNodeScores("강남 a마트").get(nid)).toBe(1.0);
  });
});
