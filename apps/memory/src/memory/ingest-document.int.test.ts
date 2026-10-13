import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { ingestDocument } from "./ingest-document.ts";
import { describeInputSource } from "./node-sources/source-ref.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let store: SqliteMemoryStore;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  store.upsertAssetFile({ sha256: "docsha", assetType: "text", assetPath: "/x/docsha.md", byteSize: 50 });
});
afterEach(() => {
  db.close();
});

describe("ingestDocument", () => {
  test("document 노드 1 + document_chunk 노드 N + chunk_count 갱신", async () => {
    const documentId = store.createDocument({
      assetSha256: "docsha",
      title: "회의록",
      documentType: "meeting_log",
    });
    const result = await ingestDocument(store, {
      documentId,
      assetSha256: "docsha",
      title: "회의록",
      rawContent: "회의록\n\n첫 청크\n\n둘째 청크",
      documentType: "meeting_log",
      chunks: [
        { text: "첫 청크", index: 0 },
        { text: "둘째 청크", index: 1 },
      ],
      author: "사용자",
      platform: "discord",
    });

    // nodeIds = document 1 + chunk 2 = 3
    expect(result.nodeIds.length).toBe(3);

    // document 노드 검증 — content = 원문 전체(안 잘림), 제목은 metadata.title.
    const docNode = await store.getNode(result.documentNodeId);
    expect(docNode?.sourceType).toBe("document");
    expect(docNode?.content).toBe("회의록\n\n첫 청크\n\n둘째 청크");
    expect((docNode?.metadata as { documentId: string }).documentId).toBe(documentId);
    expect((docNode?.metadata as { assetSha256: string }).assetSha256).toBe("docsha");
    expect((docNode?.metadata as { title: string }).title).toBe("회의록");

    // 첫 chunk 노드 검증
    const chunkNode = await store.getNode(result.chunkNodeIds[0]!);
    expect(chunkNode?.sourceType).toBe("document_chunk");
    expect((chunkNode?.metadata as { parentId: string }).parentId).toBe(documentId);
    expect((chunkNode?.metadata as { chunkIndex: number }).chunkIndex).toBe(0);

    // chunk_count 갱신 검증
    expect(store.getDocument(documentId)?.chunkCount).toBe(2);

    // parent_of 엣지 — chunk → document 방향
    const neighbors = await store.getNeighbors(result.chunkNodeIds[0]!);
    expect(
      neighbors.some((e) => e.relation === "parent_of" && e.targetId === result.documentNodeId),
    ).toBe(true);
  });

  test("청크 0 → document 노드만 + chunk_count 0 (정직한 빈 상태)", async () => {
    const documentId = store.createDocument({
      assetSha256: "docsha",
      title: "빈문서",
      documentType: "free",
    });
    const result = await ingestDocument(store, {
      documentId,
      assetSha256: "docsha",
      title: "빈문서",
      rawContent: "빈문서",
      documentType: "free",
      chunks: [],
      author: "",
      platform: "",
    });

    // document 노드 1개만
    expect(result.chunkNodeIds.length).toBe(0);
    expect(result.nodeIds.length).toBe(1);
    expect(result.nodeIds[0]).toBe(result.documentNodeId);

    // chunk_count = 0
    expect(store.getDocument(documentId)?.chunkCount).toBe(0);
  });

  test("projectId 주입 시 document/chunk 노드 project_id 에 함께 저장", async () => {
    const documentId = store.createDocument({
      assetSha256: "docsha",
      title: "프로젝트 문서",
      documentType: "reference",
    });
    const result = await ingestDocument(store, {
      documentId,
      assetSha256: "docsha",
      title: "프로젝트 문서",
      rawContent: "프로젝트 문서\n\n청크 내용",
      documentType: "reference",
      chunks: [{ text: "청크 내용", index: 0 }],
      author: "사용자",
      platform: "discord",
      projectId: " proj_abc ",
    });

    // nodeIds = document 1 + chunk 1 = 2
    expect(result.nodeIds.length).toBe(2);
    expect((await store.getNode(result.documentNodeId))?.projectId).toBe("proj_abc");
    expect((await store.getNode(result.chunkNodeIds[0]!))?.projectId).toBe("proj_abc");
  });

  test("chunk heading_path metadata 를 document_chunk metadata_json 에 저장", async () => {
    const documentId = store.createDocument({
      assetSha256: "docsha",
      title: "구조 문서",
      documentType: "reference",
    });
    const result = await ingestDocument(store, {
      documentId,
      assetSha256: "docsha",
      title: "구조 문서",
      rawContent: "# 제목\n## 중간\n본문",
      documentType: "reference",
      chunks: [
        {
          text: "# 제목\n## 중간\n본문",
          index: 0,
          headingPath: ["제목", "중간"],
          headingTitle: "중간",
          headingDepth: 2,
          parentHeadingPath: ["제목"],
          sectionChunkIndex: 0,
          sectionChunkCount: 1,
          chunkingStrategy: "heading_path",
        },
      ],
      author: "사용자",
      platform: "test",
    });

    const chunkNode = await store.getNode(result.chunkNodeIds[0]!);
    expect(chunkNode?.metadata).toMatchObject({
      parentId: documentId,
      chunkIndex: 0,
      headingPath: ["제목", "중간"],
      headingTitle: "중간",
      headingDepth: 2,
      parentHeadingPath: ["제목"],
      sectionChunkIndex: 0,
      sectionChunkCount: 1,
      chunkingStrategy: "heading_path",
    });

    const edgeCounts = db
      .prepare(
        "SELECT relation, COUNT(*) AS count FROM knowledge_edges GROUP BY relation",
      )
      .all() as Array<{ relation: string; count: number }>;
    expect(edgeCounts).toEqual([{ relation: "parent_of", count: 1 }]);
  });

  test("nodeIds 순서 — document 노드 id 먼저, 그 다음 chunk id 들", async () => {
    const documentId = store.createDocument({
      assetSha256: "docsha",
      title: "순서 테스트",
      documentType: "free",
    });
    const result = await ingestDocument(store, {
      documentId,
      assetSha256: "docsha",
      title: "순서 테스트",
      rawContent: "순서 테스트\n\nA 청크\n\nB 청크",
      documentType: "free",
      chunks: [
        { text: "A 청크", index: 0 },
        { text: "B 청크", index: 1 },
      ],
      author: "사용자",
      platform: "test",
    });

    expect(result.nodeIds[0]).toBe(result.documentNodeId);
    expect(result.nodeIds[1]).toBe(result.chunkNodeIds[0]);
    expect(result.nodeIds[2]).toBe(result.chunkNodeIds[1]);
  });

  test("재입력 — document 노드 흡수(1행 유지 + mention bump), 청크는 흡수 제외로 새 행", async () => {
    const documentId = store.createDocument({
      assetSha256: "docsha",
      title: "재입력 문서",
      documentType: "free",
    });
    const ingestArgs = {
      documentId,
      assetSha256: "docsha",
      title: "재입력 문서",
      rawContent: "재입력 문서\n\n청크 하나\n\n청크 둘",
      documentType: "free",
      chunks: [
        { text: "청크 하나", index: 0 },
        { text: "청크 둘", index: 1 },
      ],
      author: "사용자",
      platform: "test",
    };

    const revBefore = store.getDbRevision();
    const first = await ingestDocument(store, ingestArgs);
    // 첫 입력 — 삽입 노드 3개(document 1 + chunk 2)당 revision 1회씩(순차 경로 정합).
    expect(store.getDbRevision()).toBe(revBefore + 3);

    const second = await ingestDocument(store, ingestArgs);

    // document 노드는 (content_hash, project_id) 흡수 — 같은 id 재사용, 행 1개 유지.
    expect(second.documentNodeId).toBe(first.documentNodeId);
    const docRows = db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM knowledge_nodes WHERE source_type = 'document'",
      )
      .get() as { cnt: number };
    expect(docRows.cnt).toBe(1);
    const mention = db
      .prepare("SELECT mention_count FROM knowledge_nodes WHERE id = ?")
      .get(first.documentNodeId) as { mention_count: number };
    expect(mention.mention_count).toBe(1);

    // document_chunk 는 흡수 제외 계약(위치 대표성) — 재입력마다 새 행이 생긴다.
    expect(second.chunkNodeIds).not.toContain(first.chunkNodeIds[0]!);
    expect(second.chunkNodeIds).not.toContain(first.chunkNodeIds[1]!);

    // 흡수된 document 는 신호 없음 — 두 번째 입력의 revision 상승은 청크 2회만.
    expect(store.getDbRevision()).toBe(revBefore + 5);

    // chunk_count 는 마지막 입력 기준으로 갱신 유지.
    expect(store.getDocument(documentId)?.chunkCount).toBe(2);
  });
});

describe("addDocumentGraphAtomic — 문서 단위 원자성", () => {
  test("중간 실패(뒤 청크 차원 불일치) → 전체 롤백 — 고아 노드·엣지·chunk_count 0", async () => {
    const documentId = store.createDocument({
      assetSha256: "docsha",
      title: "롤백 문서",
      documentType: "free",
    });
    const revBefore = store.getDbRevision();

    // 마지막 청크에 잘못된 차원의 임베딩을 주입 — 트랜잭션 안 항목 순서 검증에서
    // throw 가 나며, 그 시점엔 document + 첫 청크 + 엣지가 이미 삽입된 상태다.
    // 롤백 계약이 지켜지면 그 부분 삽입 전부가 사라져야 한다.
    await expect(
      store.addDocumentGraphAtomic({
        documentId,
        document: {
          content: "롤백 문서 원문",
          sourceType: "document",
          author: "사용자",
          platform: "test",
          provenance: {
            kind: "source",
            source: describeInputSource({ source: "test", author: "사용자" }),
          },
        },
        chunks: [
          { content: "정상 청크", sourceType: "document_chunk" },
          {
            content: "차원 흠 청크",
            sourceType: "document_chunk",
            embedding: new Float32Array(8),
          },
        ],
        chunkLineage: { relation: "parent_of", provenance: "system" },
      }),
    ).rejects.toThrow(/dim mismatch/);

    // 부분 문서 금지 — 노드·vec·엣지 전부 0, chunk_count 는 생성 시 0 그대로.
    const nodeCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM knowledge_nodes")
      .get() as { cnt: number };
    expect(nodeCount.cnt).toBe(0);
    const vecCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM vec_nodes")
      .get() as { cnt: number };
    expect(vecCount.cnt).toBe(0);
    const edgeCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM knowledge_edges")
      .get() as { cnt: number };
    expect(edgeCount.cnt).toBe(0);
    // WP-B1-20T — 문서 노드의 출처 행도 같은 트랜잭션이라 함께 롤백된다.
    const sourceCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM memory_node_sources")
      .get() as { cnt: number };
    expect(sourceCount.cnt).toBe(0);
    expect(store.getDocument(documentId)?.chunkCount).toBe(0);

    // 롤백된 삽입에는 변동 신호가 안 나간다.
    expect(store.getDbRevision()).toBe(revBefore);
  });
});
