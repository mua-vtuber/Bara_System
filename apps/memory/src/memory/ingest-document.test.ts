/**
 * ingest-document.test.ts — document 노드 content=원문(rawContent) 보존 검증
 * (입력 통로 통합 spec §3 / Task 3). 옛 content=title(절단) 폐기 확인.
 *
 * 실제 bun:sqlite + Bgem3Embedder 통합 검증(Mock 객체 금지 — CLAUDE.md
 * 테스트 정책). 청크·parent_of 같은 옛 동작은 ingest-document.int.test.ts 가
 * 이미 검증하므로, 여기서는 content=rawContent 전환 흠만 집중 검증한다.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { ingestDocument } from "./ingest-document.ts";

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

describe("ingestDocument — content=원문 보존", () => {
  test("document 노드 content = rawContent 전체 (제목 절단 아님)", async () => {
    // 제목(첫 줄)보다 본문이 훨씬 긴 글 — 옛 content=title 이면 본문이 통째 사라진다.
    const raw =
      "짧은 제목 한 줄\n\n" +
      "여기는 제목 뒤에 이어지는 긴 본문 단락이다. 옛 흐름은 document 노드 content 에 " +
      "제목만 저장해 이 본문 전체가 노드에서 사라졌고, 같은 글이 chunk 노드로 한 번 더 " +
      "저장돼 두 번 저장 + 하나 잘림 증상이 생겼다. 이 테스트는 content 가 원문 전체를 " +
      "그대로 담는지 확인한다.";
    const documentId = store.createDocument({
      assetSha256: "docsha",
      title: "짧은 제목 한 줄",
      documentType: "free",
    });
    const result = await ingestDocument(store, {
      documentId,
      assetSha256: "docsha",
      title: "짧은 제목 한 줄",
      rawContent: raw,
      documentType: "free",
      chunks: [],
      author: "사용자",
      platform: "dashboard:manual",
    });

    const docNode = await store.getNode(result.documentNodeId);
    // content = 원문 전체 (안 잘림)
    expect(docNode?.content).toBe(raw);
    // 제목은 metadata.title 에 보존
    expect((docNode?.metadata as { title: string }).title).toBe("짧은 제목 한 줄");
    // 청크 0 → document 노드 1개만
    expect(result.nodeIds.length).toBe(1);
  });

  test("스캔본 fallback — rawContent=title (빈 content 회피)", async () => {
    // 호출처(ingest.ts)는 canon.markdown=null 일 때 title 을 rawContent 로 넘긴다.
    const documentId = store.createDocument({
      assetSha256: "docsha",
      title: "스캔 문서.pdf",
      documentType: "free",
    });
    const result = await ingestDocument(store, {
      documentId,
      assetSha256: "docsha",
      title: "스캔 문서.pdf",
      rawContent: "스캔 문서.pdf",
      documentType: "free",
      chunks: [],
      author: "",
      platform: "dashboard:manual",
    });
    const docNode = await store.getNode(result.documentNodeId);
    // content 가 빈 문자열이 아니라 제목으로 채워짐 (정직한 fallback)
    expect(docNode?.content).toBe("스캔 문서.pdf");
    expect(docNode?.content.length).toBeGreaterThan(0);
  });
});
