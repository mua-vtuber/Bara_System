/**
 * person-link 단위 테스트.
 *
 * 실 store (Bgem3Embedder + SqliteMemoryStore) 와 연결해서 round-trip
 * 검증. mock 객체 없음 (CLAUDE.md 정책).
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
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { linkAuthorPerson } from "./person-link.ts";
import { buildChildMetadata } from "./extractor-internal/contract.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

afterAll(() => {});

describe("linkAuthorPerson", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("author + metadata.user_id 둘 다 있으면 person + authored_by 엣지", async () => {
    const nodeId = await store.addNode({
      content: "친구B 가 적은 메모",
      author: "친구B",
      metadata: { user_id: "id_xyz", source: "slack-channel" },
    });
    const result = await linkAuthorPerson(store, {
      nodeId,
      author: "친구B",
      metadata: { user_id: "id_xyz", source: "slack-channel" },
    });
    expect(result.personId?.startsWith("psn_")).toBe(true);
    expect(result.edgeAdded).toBe(true);

    const edges = await store.listNodePersonEdges({
      nodeId,
      relation: "authored_by",
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.personId).toBe(result.personId!);
  });

  test("같은 user_id 두 번째 메모 → 같은 person 재사용", async () => {
    const m1 = await store.addNode({ content: "메모 1" });
    const m2 = await store.addNode({ content: "메모 2" });
    const r1 = await linkAuthorPerson(store, {
      nodeId: m1,
      author: "친구B",
      metadata: { user_id: "id_xyz" },
    });
    const r2 = await linkAuthorPerson(store, {
      nodeId: m2,
      author: "친구B",
      metadata: { user_id: "id_xyz" },
    });
    expect(r2.personId).toBe(r1.personId);
  });

  test.each([
    "discord",
    "discord-channel",
    "discord-dm",
    "discord-slash-append",
    "discord-slash-extract",
  ])("%s 작성자는 메타데이터로만 보존하고 사람을 만들지 않는다", async (source) => {
    const metadata = { user_id: "discord-user-1", source };
    const nodeId = await store.addNode({ content: "디스코드 메모", author: "작성자", metadata });

    expect(await linkAuthorPerson(store, { nodeId, author: "작성자", metadata }))
      .toEqual({ personId: null, edgeAdded: false });
    expect(await store.listPersons({ limit: 10 })).toHaveLength(0);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
    expect((await store.getNode(nodeId))!.metadata).toMatchObject(metadata);
  });

  test("추출 결과의 source가 llm_extract여도 Discord 작성자를 만들지 않는다", async () => {
    const item = { content: "추출된 기억", memoryType: "fact", importance: 0.5 };
    const metadata = buildChildMetadata(item, {
      platform: "discord",
      metadata: { user_id: "discord-user-1", source: "discord-channel" },
    }, "ollama");
    const nodeId = await store.addNode({ content: item.content, author: "작성자", metadata });

    expect(await linkAuthorPerson(store, { nodeId, author: "작성자", metadata }))
      .toEqual({ personId: null, edgeAdded: false });
    expect(await store.listPersons({ limit: 10 })).toHaveLength(0);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
  });

  test("원래 플랫폼이 Discord면 metadata에 출처가 없어도 작성자를 만들지 않는다", async () => {
    const nodeId = await store.addNode({ content: "출처 없는 메타데이터" });
    expect(await linkAuthorPerson(store, {
      nodeId, author: "작성자", platform: "discord",
      metadata: { user_id: "discord-user-1" },
    })).toEqual({ personId: null, edgeAdded: false });
    expect(await store.listPersons({ limit: 10 })).toHaveLength(0);
  });

  test("이미 등록된 Discord 작성자에게도 새 글을 자동 연결하지 않는다", async () => {
    const person = await store.findOrCreatePerson({
      displayName: "작성자", userId: "discord-user-1", source: "discord-channel",
    });
    const nodeId = await store.addNode({ content: "새 메모" });
    const result = await linkAuthorPerson(store, {
      nodeId, author: "작성자",
      metadata: { user_id: "discord-user-1", source: "discord-channel" },
    });

    expect(result).toEqual({ personId: null, edgeAdded: false });
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
    expect((await store.getPerson(person.personId))!.displayName).toBe("작성자");
  });

  test("author 빈 → no-op", async () => {
    const memId = await store.addNode({ content: "anon" });
    const result = await linkAuthorPerson(store, {
      nodeId: memId,
      author: "",
      metadata: { user_id: "id_xyz" },
    });
    expect(result.personId).toBeNull();
    expect(result.edgeAdded).toBe(false);
  });

  test("metadata.user_id 누락 → no-op", async () => {
    const memId = await store.addNode({ content: "no user_id" });
    const result = await linkAuthorPerson(store, {
      nodeId: memId,
      author: "친구B",
      metadata: { source: "discord-channel" },
    });
    expect(result.personId).toBeNull();
    expect(result.edgeAdded).toBe(false);
  });

  test("같은 nodeId 두 번째 호출 → authored_by dedup (edgeAdded=false)", async () => {
    const memId = await store.addNode({ content: "한 메모" });
    const first = await linkAuthorPerson(store, {
      nodeId: memId,
      author: "친구B",
      metadata: { user_id: "id_xyz" },
    });
    const second = await linkAuthorPerson(store, {
      nodeId: memId,
      author: "친구B",
      metadata: { user_id: "id_xyz" },
    });
    expect(first.edgeAdded).toBe(true);
    expect(second.edgeAdded).toBe(false);
    expect(second.personId).toBe(first.personId);
  });
});
