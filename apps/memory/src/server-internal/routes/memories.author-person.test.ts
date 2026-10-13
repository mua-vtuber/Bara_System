/**
 * Discord 작성자는 attribution으로만 보존하고 본문의 해시태그로 글을 분류한다.
 * 명시적인 #사람 선언과 다른 어댑터의 작성자 연결은 계속 동작한다.
 *
 * 실 bun:sqlite(:memory:) + 실 Bgem3Embedder. mock 0(MockStore 금지). 운영 DB 비접근.
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
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
}

function makeHarness(): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  // extractor 미주입 — plain 경로(saveOriginThenChunks)로 origin 1노드 저장 + author 연결.
  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

interface PostResponse {
  id: number;
}

describe("POST /memories — Discord 작성자 메타데이터와 해시태그 분류", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  test("Discord 작성자 정보는 보존하고 본문 #태그에 글을 연결한다", async () => {
    const metadata = {
      user_id: "u-test-1", source: "discord-channel",
      messageId: "m-test-1", channelId: "c-test-1", guildId: "g-test-1",
    };
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "오늘 디스코드로 올린 메모입니다 #독서 #아이디어",
        author: "테스터",
        platform: "discord",
        metadata,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PostResponse;
    const originNodeId = body.id;
    expect(typeof originNodeId).toBe("number");

    const edges = await h.store.listNodePersonEdges({
      nodeId: originNodeId,
      relation: "authored_by",
    });
    expect(edges).toHaveLength(0);
    expect(await h.store.listPersons({ limit: 10 })).toHaveLength(0);
    const node = (await h.store.getNode(originNodeId))!;
    expect(node.author).toBe("테스터");
    expect(node.platform).toBe("discord");
    expect(node.metadata).toMatchObject(metadata);
    const tagEdges = await h.store.listNodeConceptEdges({ nodeId: originNodeId, role: "tag" });
    const tags = await Promise.all(tagEdges.map((edge) => h.store.getConcept(edge.conceptId)));
    expect(tags.map((tag) => tag!.name).sort()).toEqual(["독서", "아이디어"]);
  });

  test("#사람:철수는 명시한 사람만 연결하고 작성자 신원을 섞지 않는다", async () => {
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "오늘 함께 이야기했다 #사람:철수 #독서",
        author: "작성자", platform: "discord",
        metadata: { user_id: "u-author", source: "discord-dm" },
      }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json() as PostResponse;
    const persons = await h.store.listPersons({ limit: 10 });
    expect(persons).toHaveLength(1);
    expect(persons[0]!.displayName).toBe("철수");
    expect(persons[0]!.externalRefs).toEqual({});
    expect(await h.store.listNodePersonEdges({ nodeId: id, relation: "authored_by" })).toHaveLength(0);
    const mentions = await h.store.listNodePersonEdges({ nodeId: id, relation: "mentions" });
    expect(mentions.map((edge) => edge.personId)).toEqual([persons[0]!.personId]);
  });

  test("다른 어댑터의 명시된 작성자 신원 연결은 유지한다", async () => {
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "다른 어댑터에서 작성한 메모", author: "테스터", platform: "slack",
        metadata: { user_id: "u-slack", source: "slack-channel" },
      }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json() as PostResponse;
    expect(await h.store.listNodePersonEdges({ nodeId: id, relation: "authored_by" })).toHaveLength(1);
  });

  test("metadata.user_id 가 없으면 authored_by 엣지 0 (사람 신원 미추적 정상 no-op)", async () => {
    const res = await h.app.request("/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "user_id 없이 올린 메모입니다",
        author: "테스터",
        platform: "discord",
        // metadata 자체를 생략 — user_id 없음.
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PostResponse;
    const originNodeId = body.id;

    const edges = await h.store.listNodePersonEdges({
      nodeId: originNodeId,
      relation: "authored_by",
    });
    expect(edges.length).toBe(0);
  });
});
