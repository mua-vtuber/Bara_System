/**
 * ingest-message-source.test.ts — Discord 첨부의 메시지 출처(WP-B1-20U 설계 17.8, 사용자 결정 2, U6).
 *
 * 봇이 첨부마다 POST /ingest 에 sourceMessage(플랫폼·메시지 id·채널·서버·첨부 id)를 실으면, 문서·이미지 노드가
 * 첨부별 메시지 출처 행(키 `msg:<platform>:<messageId>:att:<attachmentId>`)을 받아 메시지 삭제가 그 노드를 찾는다.
 * 청크·캡션은 지금처럼 계보 파생이라 함께 지워진다. 글 수정(PATCH by-source)의 "이 메시지 행"은 첨부 id 없는 글 행
 * 뿐이라, 같은 메시지의 첨부 행은 다른 출처로 센다.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 SigLIP(이미지) + 임시 디렉터리의 실제 AssetStore + 실제 Hono 라우트
 * (POST /ingest·/memories·/search, PATCH·DELETE /memories/by-source). 캡션은 테스트 안 Bun.serve 루프백 VLM 을 실제
 * OllamaVisionProvider 가 부른다. mock 0. 모든 메시지 삭제 뒤 계보 불변식 도우미를 부른다.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetStore } from "../../assets/asset-store.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { NodeSourceRepository } from "../../db/store-internal/node-source-repository.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { createImageEmbedder } from "../../embedding/factory.ts";
import type { ImageEmbedder } from "../../embedding/types.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { buildMemoryApi } from "../../server.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import type { DeleteBySourceResult, EditBySourceResult } from "../../api-client-types.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";
import {
  startDelayedOllamaChatServer,
  type DelayedOllamaChatServer,
} from "../../test-utils/delayed-ollama-chat-server.ts";

const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";
const CHANNEL_ID = "channel-1";
const GUILD_ID = "guild-1";
const AUTHOR = "owner";
const USER_ID = "user-1";
const ATTRIBUTION = { author: AUTHOR, userId: USER_ID };
const JSON_HEADERS = { "content-type": "application/json" };
const VLM_CAPTION = "창가에 놓인 작은 화분 사진";

const NOTE_MD = "# 분기 워크숍 준비 메모\n\n워크숍 장소는 양평 숲속 연수원으로 정했다. 버스는 토요일 아침 일곱시에 출발한다.";
const NOTE_QUERY = "양평 숲속 연수원 워크숍 장소";
const TEXT = "이번 주 금요일 저녁 회의는 화상으로 진행한다. 안건은 다음 분기 예산이다.";
const TEXT_EDITED = "이번 주 금요일 저녁 회의는 본사 삼층 회의실에서 진행한다. 안건은 다음 분기 예산이다.";
const SHARED_BODY = "동아리 회비는 매달 오일에 총무 계좌로 보낸다. 늦으면 다음 달에 함께 낸다.";
const SHARED_EDITED = "동아리 회비는 매달 십일에 총무 계좌로 보낸다. 늦으면 다음 달에 함께 낸다.";

const PNG_FIXTURE = join(import.meta.dir, "..", "..", "memory", "image-preserve", "__fixtures__", "static-small.png");

/** 첨부 출처 행 키 — 키 형식은 첫 배포 때 굳으므로 리터럴로 고정한다(설계 17.8). */
const attachmentKey = (messageId: string, attachmentId: string) => `msg:${PLATFORM}:${messageId}:att:${attachmentId}`;
const textKey = (messageId: string) => `msg:${PLATFORM}:${messageId}`;
const DASHBOARD_KEY = `save:dashboard:${AUTHOR}`;

let embedder: Bgem3Embedder;
let imageEmbedder: ImageEmbedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  imageEmbedder = createImageEmbedder();
}, 180_000);

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  dir: string;
  vlm: DelayedOllamaChatServer | null;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.vlm?.stop();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

/** caption 이면 업로드 통로가 루프백 VLM 으로 즉시 캡션을 단다(extractor.mode immediate + vision on). */
function makeHarness(opts: { caption?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bara-ingest-message-source-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  let vlm: DelayedOllamaChatServer | null = null;
  if (opts.caption) {
    vlm = startDelayedOllamaChatServer({ delayMs: 0, content: VLM_CAPTION });
    settings.llm.extractor.mode = "immediate";
    settings.llm.vision = {
      ...settings.llm.vision, enabled: true, provider: "ollama", ollamaUrl: vlm.url, ollamaModel: "test-vlm", forceCall: true,
    };
  }
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
    assetStore: new AssetStore(dir), imageEmbedder, getSettings: () => settings,
  });
  const h = { app, db, store, dir, vlm };
  harnesses.push(h);
  return h;
}

type Json = Record<string, unknown>;

async function call(h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await h.app.request(path, {
    method,
    ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as Json };
}

function sourceMessage(messageId: string, attachmentId?: string): Json {
  return { platform: PLATFORM, messageId, channelId: CHANNEL_ID, guildId: GUILD_ID, ...(attachmentId ? { attachmentId } : {}) };
}

/** 봇 첨부 모양의 .md·.txt 파일 입력(파일 이름이 있어 문서 갈래). 반환: 응답 nodeIds([0] = 문서 노드). */
async function ingestTextFile(
  h: Harness, name: string, mimeType: string, data: string, message: Json | undefined,
): Promise<number[]> {
  const res = await call(h, "POST", "/ingest", {
    source: DISCORD_SOURCE, content: { type: "text", data, mimeType, originalName: name }, attribution: ATTRIBUTION,
    ...(message === undefined ? {} : { sourceMessage: message }),
  });
  expect(res.status).toBe(201);
  return res.body.nodeIds as number[];
}

async function ingestImage(h: Harness, message: Json): Promise<{ nodeId: number; body: Json }> {
  const res = await call(h, "POST", "/ingest", {
    source: DISCORD_SOURCE,
    content: { type: "image", data: readFileSync(PNG_FIXTURE).toString("base64"), mimeType: "image/png", originalName: "plant.png" },
    attribution: ATTRIBUTION,
    sourceMessage: message,
  });
  expect(res.status).toBe(201);
  return { nodeId: (res.body.images as Array<{ nodeId: number }>)[0]!.nodeId, body: res.body };
}

/** Discord 봇 글 모양(POST /memories, platform discord, metadata 메시지 표시). */
async function postDiscordText(h: Harness, content: string, messageId: string): Promise<number> {
  const res = await call(h, "POST", "/memories", {
    content, platform: PLATFORM, author: AUTHOR, force: true,
    metadata: { source: DISCORD_SOURCE, user_id: USER_ID, messageId, channelId: CHANNEL_ID, guildId: GUILD_ID },
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

async function postDashboard(h: Harness, content: string): Promise<number> {
  const res = await call(h, "POST", "/memories", { content, platform: "dashboard", author: AUTHOR, force: true });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

async function deleteBySource(h: Harness, messageId: string): Promise<DeleteBySourceResult> {
  const res = await call(h, "DELETE", `/memories/by-source?messageId=${messageId}&platform=${PLATFORM}`);
  expect(res.status).toBe(200);
  return res.body as unknown as DeleteBySourceResult;
}

async function editBySource(h: Harness, messageId: string, content: string): Promise<EditBySourceResult> {
  const res = await call(h, "PATCH", "/memories/by-source", {
    messageId, platform: PLATFORM, content, editor: "discord-owner", source: PLATFORM,
  });
  expect(res.status).toBe(200);
  return res.body as unknown as EditBySourceResult;
}

async function searchIds(h: Harness, query: string): Promise<number[]> {
  const res = await call(h, "POST", "/search", { query, limit: 20 });
  expect(res.status).toBe(200);
  return (res.body.results as Array<{ id: number }>).map((r) => r.id);
}

function sourceKeys(db: Database, id: number): string[] {
  return new NodeSourceRepository(db).listSync([id]).get(id)!.map((row) => row.key);
}

function count(db: Database, sql: string, ...params: Array<string | number>): number {
  return (db.query(sql).get(...params) as { c: number }).c;
}

/** id 의 parent_of 계보 자식(자식 → 부모 엣지의 source). */
function lineageChildren(db: Database, id: number): number[] {
  return (db.query("SELECT source_id AS id FROM knowledge_edges WHERE target_id = ? AND relation = 'parent_of' ORDER BY source_id")
    .all(id) as Array<{ id: number }>).map((row) => row.id);
}

const sorted = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);

describe("POST /ingest sourceMessage — 첨부 노드의 메시지 출처와 메시지 삭제", () => {
  test(".md 첨부: 문서 노드가 첨부 키 행을 받고 청크는 계보다 — 메시지 삭제가 문서 노드·청크를 지우고 본문 검색 0건", async () => {
    const h = makeHarness();
    const [docId, ...chunkIds] = await ingestTextFile(h, "note.md", "text/markdown", NOTE_MD, sourceMessage("msg-doc", "att-doc"));
    expect(chunkIds.length).toBeGreaterThan(0);

    expect(sourceKeys(h.db, docId!)).toEqual([attachmentKey("msg-doc", "att-doc")]);
    const [row] = new NodeSourceRepository(h.db).listSync([docId!]).get(docId!)!;
    expect(row).toMatchObject({
      kind: "message", platform: PLATFORM, externalId: "msg-doc",
      detail: { attachmentId: "att-doc", channelId: CHANNEL_ID, guildId: GUILD_ID, channel: DISCORD_SOURCE, actor: AUTHOR },
    });
    expect((await h.store.getNode(docId!))!.metadata).toMatchObject({ messageId: "msg-doc", channelId: CHANNEL_ID, guildId: GUILD_ID });
    for (const chunkId of chunkIds) expect(sourceKeys(h.db, chunkId)).toEqual([]);
    expect(lineageChildren(h.db, docId!)).toEqual(sorted(chunkIds));
    expect((await searchIds(h, NOTE_QUERY)).length).toBeGreaterThan(0);

    const deleted = await deleteBySource(h, "msg-doc");
    expect(deleted.deletedIds).toEqual([docId!]);
    expect(sorted(deleted.derivedDeletedIds)).toEqual(sorted(chunkIds));
    expect(deleted.keptIds).toEqual([]);
    expect(count(h.db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(0);
    expect(await searchIds(h, NOTE_QUERY)).toEqual([]);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 180_000);

  test("이미지 첨부(캡션 켬): 이미지 노드가 첨부 키 행을 받고 캡션은 계보다 — 메시지 삭제가 둘 다 지운다", async () => {
    const h = makeHarness({ caption: true });
    const { nodeId: imageId } = await ingestImage(h, sourceMessage("msg-img", "att-img"));
    expect(h.vlm!.requestCount()).toBe(1);
    const captionIds = (h.db.query("SELECT id FROM knowledge_nodes WHERE source_type = 'image_caption'").all() as Array<{ id: number }>)
      .map((r) => r.id);
    expect(captionIds).toHaveLength(1);

    expect(sourceKeys(h.db, imageId)).toEqual([attachmentKey("msg-img", "att-img")]);
    expect(sourceKeys(h.db, captionIds[0]!)).toEqual([]);
    expect(lineageChildren(h.db, imageId)).toEqual(captionIds);

    const deleted = await deleteBySource(h, "msg-img");
    expect(deleted.deletedIds).toEqual([imageId]);
    expect(deleted.derivedDeletedIds).toEqual(captionIds);
    expect(count(h.db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(0);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 180_000);

  test("같은 파일을 두 메시지가 보내면 문서 노드가 두 첨부 행을 갖고, 하나만 지우면 남고 둘 다 지우면 지워진다", async () => {
    const h = makeHarness();
    const [docId, ...firstChunks] = await ingestTextFile(h, "note.md", "text/markdown", NOTE_MD, sourceMessage("msg-a", "att-a"));
    const [againId, ...secondChunks] = await ingestTextFile(h, "note.md", "text/markdown", NOTE_MD, sourceMessage("msg-b", "att-b"));
    expect(againId).toBe(docId!);
    expect(sourceKeys(h.db, docId!)).toEqual([attachmentKey("msg-a", "att-a"), attachmentKey("msg-b", "att-b")]);

    const first = await deleteBySource(h, "msg-a");
    expect(first).toMatchObject({ deletedIds: [], derivedDeletedIds: [], keptIds: [docId!] });
    const kept = (await h.store.getNode(docId!))!;
    expect(kept.content).toBe(NOTE_MD);
    expect(kept.metadata).not.toHaveProperty("messageId");
    expect(sourceKeys(h.db, docId!)).toEqual([attachmentKey("msg-b", "att-b")]);
    expect(lineageChildren(h.db, docId!)).toEqual(sorted([...firstChunks, ...secondChunks]));
    expect(lineageOrphans(h.db)).toEqual([]);

    const second = await deleteBySource(h, "msg-b");
    expect(second.deletedIds).toEqual([docId!]);
    expect(sorted(second.derivedDeletedIds)).toEqual(sorted([...firstChunks, ...secondChunks]));
    expect(count(h.db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(0);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 180_000);

  test("파일 이름 없는 글(글 갈래)의 sourceMessage 는 첨부 id 없는 메시지 출처가 되고 메시지 삭제가 지운다", async () => {
    const h = makeHarness();
    const res = await call(h, "POST", "/ingest", {
      source: DISCORD_SOURCE, content: { type: "text", data: TEXT }, attribution: ATTRIBUTION,
      sourceMessage: { platform: " Discord ", messageId: "msg-plain", channelId: CHANNEL_ID, guildId: null },
    });
    expect(res.status).toBe(201);
    const originId = res.body.originNodeId as number;
    expect(sourceKeys(h.db, originId)).toEqual([textKey("msg-plain")]);
    expect((await h.store.getNode(originId))!.metadata).toMatchObject({
      messageId: "msg-plain", channelId: CHANNEL_ID, guildId: null, platform: PLATFORM,
    });

    const deleted = await deleteBySource(h, "msg-plain");
    expect(deleted.deletedIds).toEqual([originId]);
    expect(count(h.db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(0);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 180_000);
});

describe("글 수정(PATCH by-source)과 첨부 행의 경계", () => {
  test("같은 메시지의 글 수정은 글 노드만 고치고 문서·이미지 노드는 skippedIds 에 든다", async () => {
    const h = makeHarness();
    const textId = await postDiscordText(h, TEXT, "msg-mix");
    const [docId] = await ingestTextFile(h, "note.md", "text/markdown", NOTE_MD, sourceMessage("msg-mix", "att-1"));
    const { nodeId: imageId } = await ingestImage(h, sourceMessage("msg-mix", "att-2"));

    const edited = await editBySource(h, "msg-mix", TEXT_EDITED);
    expect(edited).toMatchObject({ changed: true, matchedCount: 3, editedCount: 1, editedIds: [textId], splits: [] });
    expect(sorted(edited.skippedIds)).toEqual(sorted([docId!, imageId]));
    expect((await h.store.getNode(textId))!.content).toBe(TEXT_EDITED);
    expect((await h.store.getNode(docId!))!.content).toBe(NOTE_MD);
    expect(sourceKeys(h.db, textId)).toEqual([textKey("msg-mix")]);
    expect(sourceKeys(h.db, docId!)).toEqual([attachmentKey("msg-mix", "att-1")]);
    expect(sourceKeys(h.db, imageId)).toEqual([attachmentKey("msg-mix", "att-2")]);

    const deleted = await deleteBySource(h, "msg-mix");
    expect(sorted(deleted.deletedIds)).toEqual(sorted([textId, docId!, imageId]));
    expect(count(h.db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(0);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 180_000);

  test("글과 같은 본문의 .txt 첨부가 흡수된 노드는 글 수정이 덮지 않고 분리한다", async () => {
    const h = makeHarness();
    const textId = await postDiscordText(h, SHARED_BODY, "msg-txt");
    const [absorbedId] = await ingestTextFile(h, "memo.txt", "text/plain", SHARED_BODY, sourceMessage("msg-txt", "att-txt"));
    expect(absorbedId).toBe(textId);
    expect(sourceKeys(h.db, textId)).toEqual([textKey("msg-txt"), attachmentKey("msg-txt", "att-txt")]);

    const edited = await editBySource(h, "msg-txt", SHARED_EDITED);
    expect(edited).toMatchObject({ changed: true, editedIds: [], skippedIds: [] });
    expect(edited.splits).toHaveLength(1);
    const [split] = edited.splits;
    expect(split).toMatchObject({ fromNodeId: textId, reused: false });
    const splitId = split!.newNodeId;
    expect((await h.store.getNode(textId))!.content).toBe(SHARED_BODY);
    expect((await h.store.getNode(splitId))!.content).toBe(SHARED_EDITED);
    expect(sourceKeys(h.db, textId)).toEqual([attachmentKey("msg-txt", "att-txt")]);
    expect(sourceKeys(h.db, splitId)).toEqual([textKey("msg-txt")]);
    expect(h.db.query("SELECT old_node_id, new_node_id, source_message_id, source_platform FROM memory_revisions").all()).toEqual([
      { old_node_id: textId, new_node_id: splitId, source_message_id: "msg-txt", source_platform: PLATFORM },
    ]);

    const deleted = await deleteBySource(h, "msg-txt");
    expect(sorted(deleted.deletedIds)).toEqual(sorted([textId, splitId]));
    expect(count(h.db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(0);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 180_000);

  test("그 메시지의 첨부 행만 가진 글 노드(다른 저장에 흡수된 .txt)는 글 수정 대상이 아니라 skippedIds 에 든다", async () => {
    const h = makeHarness();
    const dashboardId = await postDashboard(h, SHARED_BODY);
    const textId = await postDiscordText(h, TEXT, "msg-only");
    const [absorbedId] = await ingestTextFile(h, "memo.txt", "text/plain", SHARED_BODY, sourceMessage("msg-only", "att-x"));
    expect(absorbedId).toBe(dashboardId);
    expect(sourceKeys(h.db, dashboardId)).toEqual([attachmentKey("msg-only", "att-x"), DASHBOARD_KEY]);

    const edited = await editBySource(h, "msg-only", TEXT_EDITED);
    expect(edited).toMatchObject({ changed: true, matchedCount: 2, editedIds: [textId], skippedIds: [dashboardId], splits: [] });
    expect((await h.store.getNode(dashboardId))!.content).toBe(SHARED_BODY);
    expect(sourceKeys(h.db, dashboardId)).toEqual([attachmentKey("msg-only", "att-x"), DASHBOARD_KEY]);

    const deleted = await deleteBySource(h, "msg-only");
    expect(deleted).toMatchObject({ deletedIds: [textId], keptIds: [dashboardId] });
    expect(sourceKeys(h.db, dashboardId)).toEqual([DASHBOARD_KEY]);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 180_000);
});

describe("POST /ingest sourceMessage 모양 검사", () => {
  const md = (message: unknown) => ({
    source: DISCORD_SOURCE, content: { type: "text", data: NOTE_MD, mimeType: "text/markdown", originalName: "note.md" },
    attribution: ATTRIBUTION, sourceMessage: message,
  });
  const valid = { platform: PLATFORM, messageId: "msg-bad", channelId: CHANNEL_ID, guildId: GUILD_ID };
  const cases: Array<{ name: string; body: Json; field: string }> = [
    { name: "객체가 아님", body: md("msg-bad"), field: "sourceMessage" },
    { name: "platform 없음", body: md({ messageId: "msg-bad" }), field: "sourceMessage.platform" },
    { name: "platform 빈 글", body: md({ ...valid, platform: "  " }), field: "sourceMessage.platform" },
    { name: "messageId 빈 글", body: md({ ...valid, messageId: " " }), field: "sourceMessage.messageId" },
    { name: "messageId 숫자", body: md({ ...valid, messageId: 42 }), field: "sourceMessage.messageId" },
    { name: "channelId 숫자", body: md({ ...valid, channelId: 5 }), field: "sourceMessage.channelId" },
    { name: "guildId 참거짓", body: md({ ...valid, guildId: true }), field: "sourceMessage.guildId" },
    { name: "attachmentId 빈 글", body: md({ ...valid, attachmentId: "" }), field: "sourceMessage.attachmentId" },
    { name: "attachmentId 숫자", body: md({ ...valid, attachmentId: 7 }), field: "sourceMessage.attachmentId" },
    {
      name: "글 갈래에 attachmentId",
      body: { source: DISCORD_SOURCE, content: { type: "text", data: TEXT }, attribution: ATTRIBUTION,
        sourceMessage: { ...valid, attachmentId: "att-1" } },
      field: "sourceMessage.attachmentId",
    },
  ];

  test.each(cases)("$name → 400(어느 칸인지 문구에) 이고 아무것도 쓰지 않는다", async ({ body, field }) => {
    const h = makeHarness();
    const res = await call(h, "POST", "/ingest", body);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toStartWith(`${field} `);
    expect(count(h.db, "SELECT COUNT(*) AS c FROM knowledge_nodes")).toBe(0);
    expect(count(h.db, "SELECT COUNT(*) AS c FROM asset_files")).toBe(0);
    expect(count(h.db, "SELECT COUNT(*) AS c FROM documents")).toBe(0);
  }, 60_000);
});
