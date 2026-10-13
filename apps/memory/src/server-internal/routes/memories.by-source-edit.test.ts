/**
 * PATCH /memories/by-source — external adapter edit sync.
 *
 * This is the generic side of Discord MessageUpdate: the memory module does
 * not know Discord, it only edits the raw node identified by external source
 * metadata. The adapter owns when to call it.
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
  const app = buildMemoryApi({ store, retriever, assembler });
  return { app, db, store };
}

async function addDiscordRawNode(
  store: SqliteMemoryStore,
  content: string,
  messageId: string,
): Promise<number> {
  return store.addNode({
    content,
    sourceType: "auto_capture",
    platform: "discord",
    metadata: {
      messageId,
      source: "discord-channel",
      channelId: "chan-1",
    },
  });
}

describe("PATCH /memories/by-source", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  test("Discord messageId 기준 원본 auto_capture 노드를 같은 id로 수정한다", async () => {
    const id = await addDiscordRawNode(
      h.store,
      "치과 예약 #일정:치과 #날짜:2026-07-10 09:00",
      "msg-1",
    );
    const childId = await h.store.addNode({
      content: "치과 예약",
      sourceType: "llm_extract",
      platform: "discord",
      metadata: { messageId: "msg-1", platform: "discord" },
    });

    const res = await h.app.request("/memories/by-source", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId: "msg-1",
        platform: "discord",
        content: "치과 예약 변경 #일정:치과 #날짜:2026-07-11 10:00",
        editor: "discord-owner",
        source: "discord",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changed: boolean;
      matchedCount: number;
      editedIds: number[];
      skippedIds: number[];
    };
    expect(body.changed).toBe(true);
    // WP-B1-20T 설계 5.6 알려진 차이 — 편집 대상은 그 메시지의 출처 행을 가진 노드다. metadata 로
    // messageId 만 물려받은 추출 자식은 출처 행이 없어 일치 목록(matchedCount·skippedIds)에 들지 않고,
    // 아래처럼 본문도 그대로다.
    expect(body.matchedCount).toBe(1);
    expect(body.editedIds).toEqual([id]);
    expect(body.skippedIds).toEqual([]);

    const edited = await h.store.getNode(id);
    expect(edited?.content).toBe("치과 예약 변경 #일정:치과 #날짜:2026-07-11 10:00");
    expect(edited?.eventAt).toBe("2026-07-11T10:00");

    const child = await h.store.getNode(childId);
    expect(child?.content).toBe("치과 예약");
  });

  test("수정된 원문에서 날짜 태그가 사라지면 direct event_at/event_until 을 비운다", async () => {
    const id = await addDiscordRawNode(
      h.store,
      "행사 #일정:행사 #날짜:2026-07-10 09:00 #일정종료:2026-07-10 11:00",
      "msg-2",
    );
    await h.store.setEventAt(id, "2026-07-10 09:00:00", "direct");
    await h.store.setEventUntil(id, "2026-07-10 11:00:00", "direct");

    const res = await h.app.request("/memories/by-source", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId: "msg-2",
        platform: "discord",
        content: "행사 날짜 미정 #일정:행사",
        editor: "discord-owner",
        source: "discord",
      }),
    });

    expect(res.status).toBe(200);
    const edited = await h.store.getNode(id);
    expect(edited?.content).toBe("행사 날짜 미정 #일정:행사");
    expect(edited?.eventAt).toBeNull();
    expect(edited?.eventUntil).toBeNull();
  });

  test("매칭되는 원본이 없으면 변경 없음으로 응답한다", async () => {
    const res = await h.app.request("/memories/by-source", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId: "missing",
        platform: "discord",
        content: "없는 메시지 수정",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changed: boolean;
      matchedCount: number;
      editedIds: number[];
    };
    expect(body.changed).toBe(false);
    expect(body.matchedCount).toBe(0);
    expect(body.editedIds).toEqual([]);
  });
});
