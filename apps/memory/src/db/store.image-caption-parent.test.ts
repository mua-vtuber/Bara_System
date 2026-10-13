/**
 * store.image-caption-parent.test.ts — Phase 11e G2-2 (T4):
 * getImageAssetParentOfCaption 역추적 메서드 단위 검증.
 *
 * 캡션 자식 노드 id → 부모 image_asset 노드 id 를 parent_of 엣지로 추적한다.
 * 부모 관계의 권위는 parent_of 엣지(addImageCaption 이 생성) — metadata.parentId 가
 * 같은 값을 담아도 엣지를 추적한다(spec §10.3). 부모가 실제 image_asset 인지
 * JOIN 으로 검증해, 고아 캡션(엣지 없음)·부모가 이미지 아님 갈래는 null(가짜
 * 부모 안 만듦 / No-fallback).
 *
 * 실 bun:sqlite :memory: + 실 Bgem3Embedder — mock 0. 운영 DB 비접근.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "./migrations.ts";
import { SqliteMemoryStore } from "./store.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

describe("getImageAssetParentOfCaption — 캡션 → 부모 이미지 역추적", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });

  test("addImageCaption 이 만든 parent_of 엣지로 부모 image_asset 을 찾는다", async () => {
    const sha = "d".repeat(64);
    const parentId = await store.addNode({
      content: "이미지 자산 라벨",
      sourceType: "image_asset",
      metadata: { asset_sha256: sha },
    });
    const captionId = await store.addImageCaption({
      parentNodeId: parentId,
      assetSha256: sha,
      caption: "노란 후드 캐릭터",
      captionRole: "auto",
    });

    expect(store.getImageAssetParentOfCaption(captionId)).toBe(parentId);
  });

  test("parent_of 엣지 없는 고아 캡션 → null", async () => {
    // addImageCaption 을 안 쓰고 image_caption 노드만 직접 만든다(엣지 0).
    const orphanId = await store.addNode({
      content: "부모 없는 캡션 글",
      sourceType: "image_caption",
      metadata: { parentId: 12345, captionRole: "auto" },
    });
    expect(store.getImageAssetParentOfCaption(orphanId)).toBeNull();
  });

  test("parent_of 가 image_asset 이 아닌 노드를 가리키면 null(데이터 이상 graceful)", async () => {
    // 부모가 글(auto_capture) 노드인 비정상 엣지 — JOIN 검증이 걸러야 한다.
    const captionId = await store.addNode({
      content: "캡션 글",
      sourceType: "image_caption",
      metadata: { captionRole: "auto" },
    });
    const wrongParentId = await store.addNode({
      content: "이건 이미지가 아니라 일반 글",
    });
    await store.addEdge({
      sourceId: captionId,
      targetId: wrongParentId,
      relation: "parent_of",
      provenance: "user_input",
      sourceNodeId: null,
      weight: 1.0,
    });
    expect(store.getImageAssetParentOfCaption(captionId)).toBeNull();
  });

  test("존재하지 않는 노드 id → null", () => {
    expect(store.getImageAssetParentOfCaption(987654)).toBeNull();
  });
});
