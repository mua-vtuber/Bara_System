/**
 * node-repository.batch.test.ts — P3 G5-d 배치 입력 통로(addNodesBatch).
 *
 * 순차 addNodeIdempotent 와의 의미 동일성(배치 내 흡수·DB 흡수·document_chunk
 * 제외·NFC 동등·입력 순서)과 임베딩 호출 배치화(embedBatch 1회·건별 embed 0회)를
 * 실제 SQLite(sqlite-vec) + 실제 임베더(bge-m3 1024)로 검증한다. mock 클래스 없음 —
 * 호출 횟수 확인은 실제 임베더에 얇은 카운터를 씌운 래퍼(실 embed/embedBatch 를
 * 그대로 위임)로 한다(node-repository.idempotency.test.ts 선례).
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { NodeRepository } from "./node-repository.ts";
import { SqliteMemoryStore } from "../store.ts";
import { contentHash } from "../../memory/content-hash.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

function countRows(
  db: Database,
  sql: string,
  ...params: SQLQueryBindings[]
): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

/**
 * 실제 임베더 위임 카운터 — embed/embedBatch 호출 횟수와 embedBatch 에 넘어간
 * 텍스트를 기록만 하고 계산은 실제 Bgem3Embedder 가 한다(인터페이스 mock 아님).
 */
function makeCountingEmbedder(): {
  wrapper: Embedder;
  counts: { embed: number; embedBatch: number; batchTexts: string[][] };
} {
  const counts = {
    embed: 0,
    embedBatch: 0,
    batchTexts: [] as string[][],
  };
  const wrapper: Embedder = {
    dimension: embedder.dimension,
    load: () => embedder.load(),
    embed(text: string) {
      counts.embed += 1;
      return embedder.embed(text);
    },
    embedBatch(texts: string[]) {
      counts.embedBatch += 1;
      counts.batchTexts.push([...texts]);
      return embedder.embedBatch(texts);
    },
  };
  return { wrapper, counts };
}

describe("addNodesBatch — 순차 addNodeIdempotent 와 의미 동일 + 임베딩 배치화", () => {
  let db: Database;
  let repo: NodeRepository;
  let counts: { embed: number; embedBatch: number; batchTexts: string[][] };

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    const counting = makeCountingEmbedder();
    counts = counting.counts;
    repo = new NodeRepository(db, counting.wrapper);
  });
  afterEach(() => {
    db.close();
  });

  test("빈 배열 → [] 반환 + 모델 호출 0회", async () => {
    const results = await repo.addNodesBatch([]);
    expect(results).toEqual([]);
    expect(counts.embed).toBe(0);
    expect(counts.embedBatch).toBe(0);
  });

  test("고유 N줄 → embedBatch 1회(건별 embed 0회) + N행 + 입력 순서 보존", async () => {
    const contents = ["첫 줄 내용", "둘째 줄 내용", "셋째 줄 내용"];
    const results = await repo.addNodesBatch(
      contents.map((content) => ({ content })),
    );

    // 임베딩 호출이 줄 수(3회)가 아니라 embedBatch 1회로 묶인다.
    expect(counts.embedBatch).toBe(1);
    expect(counts.embed).toBe(0);
    expect(counts.batchTexts[0]).toEqual(contents);

    // 반환 배열은 입력 순서 — 각 id 의 저장 content 가 입력 순서와 일치.
    expect(results.length).toBe(3);
    for (let i = 0; i < contents.length; i++) {
      expect(results[i]!.reused).toBe(false);
      const row = db
        .prepare("SELECT content FROM knowledge_nodes WHERE id = ?")
        .get(results[i]!.id) as { content: string };
      expect(row.content).toBe(contents[i]!);
    }
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(3);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM vec_nodes")).toBe(3);
  });

  test("배치 내 중복 줄 흡수 — 첫 줄만 INSERT, 뒤 줄은 그 노드를 흡수(순차 동일)", async () => {
    const results = await repo.addNodesBatch([
      { content: "같은 줄" },
      { content: "다른 줄" },
      { content: "같은 줄" },
    ]);

    expect(results[0]!.reused).toBe(false);
    expect(results[1]!.reused).toBe(false);
    expect(results[2]!.reused).toBe(true);
    expect(results[2]!.id).toBe(results[0]!.id);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(2);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM vec_nodes")).toBe(2);

    // 흡수는 mention bump 로 기록된다(순차 addNode 와 동일 — N-1 규칙).
    const row = db
      .prepare("SELECT mention_count FROM knowledge_nodes WHERE id = ?")
      .get(results[0]!.id) as { mention_count: number };
    expect(row.mention_count).toBe(1);

    // 중복 줄은 임베딩 대상에서도 빠진다 — embedBatch 입력은 고유 2건.
    expect(counts.embedBatch).toBe(1);
    expect(counts.batchTexts[0]).toEqual(["같은 줄", "다른 줄"]);
  });

  test("DB 기존 노드 흡수 — 이미 저장된 줄은 배치에서 임베딩 없이 재사용", async () => {
    const preId = await repo.addNode({ content: "기존 글" });
    expect(counts.embed).toBe(1); // 사전 적재 1회(배치 밖).

    const results = await repo.addNodesBatch([
      { content: "기존 글" },
      { content: "새 글" },
    ]);
    expect(results[0]!.reused).toBe(true);
    expect(results[0]!.id).toBe(preId);
    expect(results[1]!.reused).toBe(false);

    // 기존 노드로 흡수될 줄은 embedBatch 입력에서 제외 — "새 글" 1건만 계산.
    expect(counts.embedBatch).toBe(1);
    expect(counts.batchTexts[0]).toEqual(["새 글"]);
    expect(counts.embed).toBe(1); // 배치가 건별 embed 를 추가 호출하지 않음.
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(2);
  });

  test("document_chunk 흡수 제외 — 같은 내용 청크 2건이 각각 별 행(content_hash 는 채움)", async () => {
    const results = await repo.addNodesBatch([
      { content: "반복 조각", sourceType: "document_chunk" },
      { content: "반복 조각", sourceType: "document_chunk" },
    ]);
    expect(results[0]!.reused).toBe(false);
    expect(results[1]!.reused).toBe(false);
    expect(results[1]!.id).not.toBe(results[0]!.id);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(2);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM vec_nodes")).toBe(2);

    const hashes = db
      .prepare(
        "SELECT content_hash FROM knowledge_nodes ORDER BY id ASC",
      )
      .all() as Array<{ content_hash: string }>;
    for (const row of hashes) {
      expect(row.content_hash).toBe(contentHash("반복 조각"));
    }
  });

  test("NFC-NFD 입력 동등 — 임베딩·저장 모두 NFC 로 통일되고 배치 안에서 흡수", async () => {
    const nfc = "노란후드 티셔츠".normalize("NFC");
    const nfd = "노란후드 티셔츠".normalize("NFD");
    expect(nfd).not.toBe(nfc); // 테스트 전제 — 두 표현이 실제로 다른 바이트.

    const results = await repo.addNodesBatch([
      { content: nfd },
      { content: nfc },
    ]);
    expect(results[1]!.id).toBe(results[0]!.id);
    expect(results[1]!.reused).toBe(true);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(1);

    // 저장 content 는 NFC 바이트(G3-a 경계와 동일 규칙).
    const row = db
      .prepare("SELECT content FROM knowledge_nodes WHERE id = ?")
      .get(results[0]!.id) as { content: string };
    expect(row.content).toBe(nfc);

    // embedBatch 에 넘어간 문자열도 원문(NFD)이 아니라 NFC — 저장 content 와
    // 벡터가 같은 정규화 상태여야 한다는 계약의 직접 증거.
    expect(counts.embedBatch).toBe(1);
    expect(counts.batchTexts[0]).toEqual([nfc]);
  });

  test("흡수 키는 (content_hash, project_id) — 같은 content 다른 project 는 배치 안에서도 별 노드", async () => {
    const results = await repo.addNodesBatch([
      { content: "공유 문장", project_id: "prj_a" },
      { content: "공유 문장", project_id: "prj_b" },
      { content: "공유 문장", project_id: "prj_a" },
    ]);
    expect(results[1]!.id).not.toBe(results[0]!.id);
    expect(results[1]!.reused).toBe(false);
    expect(results[2]!.id).toBe(results[0]!.id);
    expect(results[2]!.reused).toBe(true);
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(2);
  });

  test("차원 불일치 임베딩 주입 → loud throw(기존 dim mismatch 계약 그대로)", async () => {
    await expect(
      repo.addNodesBatch([
        { content: "차원 불일치 주입", embedding: new Float32Array(8) },
      ]),
    ).rejects.toThrow("dim mismatch");
    // 실패한 항목은 INSERT 에 도달하지 않는다.
    expect(countRows(db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(0);
  });

  test("임베딩 주입 항목은 embedBatch 대상에서 제외된다", async () => {
    const vector = await embedder.embed("주입 벡터 글");
    const results = await repo.addNodesBatch([
      { content: "주입 벡터 글", embedding: vector },
      { content: "계산 필요 글" },
    ]);
    expect(results[0]!.reused).toBe(false);
    expect(results[1]!.reused).toBe(false);
    expect(counts.embedBatch).toBe(1);
    expect(counts.batchTexts[0]).toEqual(["계산 필요 글"]);
  });
});

describe("addNodesBatch — store 파사드 노출", () => {
  test("SqliteMemoryStore.addNodesBatch 가 NodeRepository 로 위임된다", async () => {
    const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    try {
      const store = new SqliteMemoryStore(db, embedder);
      const results = await store.addNodesBatch([
        { content: "파사드 확인 글" },
        { content: "파사드 확인 글" },
      ]);
      expect(results.length).toBe(2);
      expect(results[0]!.id).toBeGreaterThan(0);
      expect(results[1]!.id).toBe(results[0]!.id);
      expect(results[1]!.reused).toBe(true);
    } finally {
      db.close();
    }
  });
});
