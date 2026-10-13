/**
 * node-repository.idempotency.test.ts — P0-A 입력 멱등성 코어 계층(T3).
 *
 * addNode / addNodeIdempotent 가 정규화 해시로 정확-중복을 흡수하는지 실제
 * SQLite(sqlite-vec) + 실제 임베더(bge-m3 1024)로 검증한다. mock 없음.
 *
 * 불변식(spec §4.4): 같은 정규화 내용을 N번 넣으면 knowledge_nodes 1행,
 * vec_nodes·FTS·trigram 각 1행, mention_count 는 N-1.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { NodeRepository } from "./node-repository.ts";
import { contentHash } from "../../memory/content-hash.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

function countRows(
  db: Database,
  sql: string,
  ...params: SQLQueryBindings[]
): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

describe("addNode 멱등 흡수 — 계보 무효화된 행 (SL-2)", () => {
  let db: Database;
  let repo: NodeRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new NodeRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("원문 편집·철회가 거둔 행에는 흡수하지 않고, 직접 철회한 행에는 계속 흡수한다", async () => {
    const fact = "롤백 담당은 운영팀이 맡는다";
    const invalidated = await repo.addNode({
      content: fact, sourceType: "llm_extract",
      metadata: { sharedMemory: { status: "retracted", revision: 1, assertionKind: "ai_inference", invalidatedBy: 7 } },
    });
    const mentionsBefore = countRows(db, "SELECT mention_count AS c FROM knowledge_nodes WHERE id = ?", invalidated);

    // 같은 본문을 다시 추출·저장하면 새 행이 생긴다 — 거둔 행에 mention 만 오르고 숨지 않는다.
    const regenerated = await repo.addNodeIdempotent({ content: fact, sourceType: "llm_extract" });
    expect(regenerated.reused).toBe(false);
    expect(regenerated.id).not.toBe(invalidated);
    expect(countRows(db, "SELECT mention_count AS c FROM knowledge_nodes WHERE id = ?", invalidated)).toBe(mentionsBefore);
    expect(await repo.findNodeIdByContentHash(fact)).toBe(regenerated.id);
    expect(await repo.addNodeIdempotent({ content: fact })).toEqual({ id: regenerated.id, reused: true });

    // 클라이언트가 직접 철회한 행(invalidatedBy 없음)은 같은 본문 재저장이 되살리지 않는다.
    const withdrawn = await repo.addNode({
      content: "직접 철회한 기억",
      metadata: { sharedMemory: { status: "retracted", revision: 1, assertionKind: "unknown" } },
    });
    expect(await repo.addNodeIdempotent({ content: "직접 철회한 기억" })).toEqual({ id: withdrawn, reused: true });
  });
});

describe("addNode 멱등 흡수 — 정확 중복", () => {
  let db: Database;
  let repo: NodeRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new NodeRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("(a) 같은 content 2회 addNode → 반환 id 동일 + 각 테이블 1행", async () => {
    const id1 = await repo.addNode({ content: "오늘 회의록 정리" });
    const id2 = await repo.addNode({ content: "오늘 회의록 정리" });

    expect(id2).toBe(id1);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(1);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM vec_nodes")).toBe(1);
    expect(
      countRows(
        db,
        "SELECT COUNT(*) AS c FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH '회의록'",
      ),
    ).toBe(1);
    // trigram 은 3-gram 색인 — 원본 rowid 매핑 1행 확인.
    expect(
      countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes_trgm"),
    ).toBe(1);
  });

  test("(b) 2회 후 mention_count = 1(0→1)", async () => {
    const id = await repo.addNode({ content: "반복 언급 주제" });
    await repo.addNode({ content: "반복 언급 주제" });
    const row = db
      .prepare("SELECT mention_count FROM knowledge_nodes WHERE id = ?")
      .get(id) as { mention_count: number };
    expect(row.mention_count).toBe(1);

    // N=3 → mention_count 2 (N-1).
    await repo.addNode({ content: "반복 언급 주제" });
    const row3 = db
      .prepare("SELECT mention_count FROM knowledge_nodes WHERE id = ?")
      .get(id) as { mention_count: number };
    expect(row3.mention_count).toBe(2);
  });

  test("(c) NFC 변형·앞뒤 공백만 다른 재입력 → 흡수(같은 id)", async () => {
    const id1 = await repo.addNode({ content: "한글 메모".normalize("NFC") });
    const id2 = await repo.addNode({ content: "  한글 메모  ".normalize("NFD") });
    expect(id2).toBe(id1);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(1);
  });

  test("(d) 내부 내용 다르면 새 노드", async () => {
    const id1 = await repo.addNode({ content: "노란후드" });
    const id2 = await repo.addNode({ content: "노란 후드" });
    expect(id2).not.toBe(id1);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(2);
  });

  test("(e) addNodeIdempotent — 첫 호출 reused=false, 둘째 reused=true", async () => {
    const r1 = await repo.addNodeIdempotent({ content: "멱등 반환 계약" });
    const r2 = await repo.addNodeIdempotent({ content: "멱등 반환 계약" });
    expect(r1.reused).toBe(false);
    expect(r2.reused).toBe(true);
    expect(r2.id).toBe(r1.id);
  });

  test("content_hash 칸이 저장된다(원문이 아니라 정규화 해시)", async () => {
    const id = await repo.addNode({ content: "  해시 저장 확인  " });
    const row = db
      .prepare("SELECT content, content_hash FROM knowledge_nodes WHERE id = ?")
      .get(id) as { content: string; content_hash: string };
    // content 는 원문 그대로(정규화는 해시에만).
    expect(row.content).toBe("  해시 저장 확인  ");
    expect(row.content_hash).toBe(contentHash("해시 저장 확인"));
  });

  test("흡수 시 새 임베딩을 계산하지 않는다(embedder 호출 skip)", async () => {
    // embedder 를 감싸 호출 횟수를 센다 — 데이터 fixture 가 아니라 실제 임베더에
    // 얇은 카운터를 씌운 래퍼(인터페이스 mock 아님 — 실제 embed 를 그대로 위임).
    let embedCalls = 0;
    const counting = {
      dimension: embedder.dimension,
      async embed(text: string) {
        embedCalls += 1;
        return embedder.embed(text);
      },
    };
    const countingRepo = new NodeRepository(db, counting as never);
    await countingRepo.addNode({ content: "임베딩 낭비 방지" });
    expect(embedCalls).toBe(1);
    await countingRepo.addNode({ content: "임베딩 낭비 방지" });
    // 둘째(흡수)는 임베딩을 다시 계산하지 않는다.
    expect(embedCalls).toBe(1);
  });

  test("재입력이 updated_at 을 건드리지 않는다(재언급 ≠ 본문 수정)", async () => {
    const id = await repo.addNode({ content: "updated_at 보존 확인" });
    const before = db
      .prepare("SELECT updated_at FROM knowledge_nodes WHERE id = ?")
      .get(id) as { updated_at: string | null };
    await repo.addNode({ content: "updated_at 보존 확인" });
    const after = db
      .prepare("SELECT updated_at FROM knowledge_nodes WHERE id = ?")
      .get(id) as { updated_at: string | null };
    expect(before.updated_at).toBeNull();
    expect(after.updated_at).toBeNull();
  });

  test("흡수 키는 (content_hash, project_id) — 같은 content 다른 project 는 별 노드", async () => {
    const idA = await repo.addNode({ content: "공유 문장", project_id: "prj_a" });
    const idB = await repo.addNode({ content: "공유 문장", project_id: "prj_b" });
    // 같은 정규화 내용이라도 project 가 다르면 흡수 안 함(프로젝트 분리 계약 보존).
    expect(idB).not.toBe(idA);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(2);

    // 같은 project 재입력은 흡수.
    const idA2 = await repo.addNode({ content: "공유 문장", project_id: "prj_a" });
    expect(idA2).toBe(idA);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(2);
  });

  test("project 없는(NULL) 노드와 특정 project 노드는 안 섞인다", async () => {
    const idNull = await repo.addNode({ content: "무소속 문장" });
    const idScoped = await repo.addNode({
      content: "무소속 문장",
      project_id: "prj_x",
    });
    expect(idScoped).not.toBe(idNull);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(2);

    // NULL 끼리는 흡수(NULL 도 하나의 스코프).
    const idNull2 = await repo.addNode({ content: "무소속 문장" });
    expect(idNull2).toBe(idNull);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(2);
  });

  test("NFC 정규화 경계(G3-a) — NFD 입력이 DB 에 NFC 바이트로 저장된다", async () => {
    const nfd = "노란후드 티셔츠".normalize("NFD");
    const nfc = "노란후드 티셔츠".normalize("NFC");
    // 사전 조건 — 두 표현이 실제로 다른 바이트인지 확인(테스트 전제).
    expect(nfd).not.toBe(nfc);

    const id = await repo.addNode({ content: nfd });
    const row = db
      .prepare("SELECT content FROM knowledge_nodes WHERE id = ?")
      .get(id) as { content: string };
    // 저장된 content 칸은 원문(NFD) 이 아니라 NFC 정규화된 바이트여야 한다.
    expect(row.content).toBe(nfc);
    expect(row.content).not.toBe(nfd);
  });

  test("NFC 정규화 경계(회귀) — 이미 NFC 인 입력은 byte 동일하게 저장(trim 은 안 함)", async () => {
    const withSpaces = "  이미 NFC인 내용  ".normalize("NFC");
    const id = await repo.addNode({ content: withSpaces });
    const row = db
      .prepare("SELECT content FROM knowledge_nodes WHERE id = ?")
      .get(id) as { content: string };
    // NFC(NFC(x)) === NFC(x) — 이미 정규화된 입력은 그대로 저장된다.
    // trim 은 저장 content 경계에서 하지 않으므로 앞뒤 공백도 그대로 보존된다.
    expect(row.content).toBe(withSpaces);
  });

  test("흡수는 최저 id 를 재사용한다(ORDER BY id ASC)", async () => {
    // 장수 DB 에 이미 정확 중복이 둘 있는 상황 재현 — raw INSERT 로 같은 해시 두 행.
    const h = contentHash("이미 중복된 글");
    const rawInsert = db.prepare(
      "INSERT INTO knowledge_nodes (content, source_type, content_hash) VALUES (?, 'auto_capture', ?)",
    );
    rawInsert.run("이미 중복된 글", h);
    const lowId = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    rawInsert.run("이미 중복된 글", h);

    const reusedId = await repo.addNode({ content: "이미 중복된 글" });
    expect(reusedId).toBe(lowId);
  });
});

describe("editNodeContent — NFC 정규화 경계(G3-a)", () => {
  let db: Database;
  let repo: NodeRepository;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    repo = new NodeRepository(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("NFD 로 편집한 content 가 DB 에 NFC 바이트로 저장된다", async () => {
    const id = await repo.addNode({ content: "원본 메모" });
    const nfd = "노란후드 티셔츠로 정정".normalize("NFD");
    const nfc = "노란후드 티셔츠로 정정".normalize("NFC");
    expect(nfd).not.toBe(nfc);

    await repo.editNodeContent({ nodeId: id, content: nfd });
    const row = db
      .prepare("SELECT content FROM knowledge_nodes WHERE id = ?")
      .get(id) as { content: string };
    expect(row.content).toBe(nfc);
    expect(row.content).not.toBe(nfd);
  });
});
