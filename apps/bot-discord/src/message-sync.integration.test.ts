/**
 * message-sync.integration.test.ts — 메시지 수정 동기화의 첨부 갈래를 실제 코어로 검증(WP-B1-20U 설계 17.9, U7).
 *
 * 봇은 수정 뒤 남은 첨부 id 전부를 attachmentIds 로 항상 보내고, 글이 빈 메시지(첨부만)는 content 없이 보낸다. 코어는
 * 목록에서 빠진 첨부의 기억을 메시지 삭제와 같은 규칙으로 지운다. 부분 메시지(첨부 목록을 모름)는 보내지 않는다 —
 * 빈 목록을 보내면 첨부 기억이 모두 지워지기 때문이다.
 *
 * mock 객체 없음(CLAUDE.md 정책):
 *   - 클라이언트는 진짜 MemoryApiClient. 메모리 코어는 실 SQLite(:memory:) + 실 Bgem3Embedder + 임시 디렉터리의 실
 *     AssetStore 로 띄운 buildMemoryApi 를 Bun.serve 루프백 URL 에 노출한다. 파일 지우기 함수는 서버 부팅과 같은
 *     installAssetFileRemover 로 넣는다.
 *   - 글은 봇 MessageCreate 와 같은 MemoryApiClient.ingest + buildBaseMetadata, 첨부는 봇과 같은 ingestAttachment 가
 *     또 하나의 Bun.serve 에서 실제로 내려받아 POST /ingest 로 보낸다.
 *   - 수정 메시지는 discord.js Message 와 같은 모양의 순수 데이터(첨부는 Map)다.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bgem3Embedder } from "../../memory/src/embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../memory/src/db/migrations.ts";
import { SqliteMemoryStore } from "../../memory/src/db/store.ts";
import { HybridRetriever } from "../../memory/src/memory/retriever.ts";
import { ContextAssembler } from "../../memory/src/memory/context-assembler.ts";
import { AssetStore } from "../../memory/src/assets/asset-store.ts";
import { getMemorySettings } from "../../memory/src/settings/memory-settings.ts";
import { buildMemoryApi } from "../../memory/src/server.ts";
import { installAssetFileRemover } from "../../memory/src/server-internal/asset-file-remover-boot.ts";
import { MemoryApiClient } from "../../memory/src/api-client.ts";
import { NodeSourceRepository } from "../../memory/src/db/store-internal/node-source-repository.ts";
import { lineageOrphans } from "../../memory/src/test-utils/lineage-invariant.ts";
import { buildBaseMetadata } from "./attribution.ts";
import { ingestAttachment, type AttachmentSourceMessage } from "./attachment-ingest.ts";
import type { BotConfig } from "./config.ts";
import { syncEditedDiscordMessage, type EditableDiscordMessageLike } from "./message-sync.ts";

const OWNER_ID = "owner-1";
const OWNER_NAME = "owner";
const MEMO_CHANNEL_ID = "memo-1";
const GUILD_ID = "guild-1";
const PLATFORM = "discord";
const SOURCE = "discord-channel";

const CONFIG: BotConfig = {
  token: "tok",
  applicationId: "app",
  ownerUserId: OWNER_ID,
  memoChannelId: MEMO_CHANNEL_ID,
  memoryApiUrl: "http://127.0.0.1:3001",
  notifyEvolverDiscord: false,
  evolverPollIntervalMin: 60,
  sseReconnectDelayMs: 3000,
  scheduleRemindersEnabled: false,
  scheduleReminderPollIntervalMin: 5,
  scheduleReminderDateOnlyTime: "09:00",
};

const TEXT = "이번 주 금요일 저녁 회의는 화상으로 진행한다. 안건은 다음 분기 예산이다.";
const NOTE_MD = "# 분기 워크숍 준비 메모\n\n워크숍 장소는 양평 숲속 연수원으로 정했다. 버스는 토요일 아침 일곱시에 출발한다.";
const NOTE_TXT = "주말 등산 계획\n\n토요일 아침 여덟시에 북한산 입구에서 만난다. 점심은 각자 준비한다.";
/** 첨부 다운로드 경로 → [이름, MIME, 본문]. */
const FILES: Record<string, [string, string, string]> = {
  "/workshop.md": ["workshop.md", "text/markdown", NOTE_MD],
  "/hiking.txt": ["hiking.txt", "text/plain", NOTE_TXT],
};

const attachmentKey = (messageId: string, attachmentId: string) => `msg:${PLATFORM}:${messageId}:att:${attachmentId}`;
const textKey = (messageId: string) => `msg:${PLATFORM}:${messageId}`;

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
}, 180_000);

let dir: string;
let db: Database;
let store: SqliteMemoryStore;
let memoryServer: Server<undefined>;
let fileServer: Server<undefined>;
let client: MemoryApiClient;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bara-message-sync-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  const assetStore = new AssetStore(dir);
  await installAssetFileRemover(store, assetStore);
  const settings = getMemorySettings("/nonexistent-message-sync-test", "/nonexistent-message-sync-test.secrets.json");
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
    assetStore, getSettings: () => settings,
  });
  memoryServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  client = new MemoryApiClient(`http://127.0.0.1:${memoryServer.port}`);
  fileServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const file = FILES[new URL(req.url).pathname];
      if (file === undefined) return new Response("not found", { status: 404 });
      return new Response(file[2], { status: 200, headers: { "content-type": file[1] } });
    },
  });
});

afterEach(() => {
  memoryServer.stop(true);
  fileServer.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function sourceMessage(messageId: string): AttachmentSourceMessage {
  return { platform: PLATFORM, messageId, channelId: MEMO_CHANNEL_ID, guildId: GUILD_ID };
}

/** 봇 MessageCreate 의 글 통로 — POST /memories, metadata 에 메시지 표시. */
async function postText(messageId: string, content: string): Promise<number> {
  const metadata = buildBaseMetadata({
    author: { id: OWNER_ID, username: OWNER_NAME }, source: SOURCE, messageId, channelId: MEMO_CHANNEL_ID, guildId: GUILD_ID,
  });
  const { id } = await client.ingest({ content, metadata, author: OWNER_NAME, platform: PLATFORM });
  if (id === null) throw new Error(`메시지 ${messageId} 글 저장이 기억 id 를 돌려주지 않았습니다`);
  return id;
}

/** 봇 MessageCreate 의 첨부 통로 — 실제 다운로드 뒤 POST /ingest. 반환: 문서 기록 id. */
async function postAttachment(messageId: string, attachmentId: string, path: string): Promise<string> {
  const [name, contentType, body] = FILES[path]!;
  const outcome = await ingestAttachment(
    client,
    { id: attachmentId, name, contentType, url: `http://127.0.0.1:${fileServer.port}${path}`, size: body.length },
    SOURCE,
    { author: OWNER_NAME, userId: OWNER_ID },
    sourceMessage(messageId),
  );
  if (outcome.status !== "ingested") throw new Error(`첨부 ${attachmentId} 저장 실패: ${JSON.stringify(outcome)}`);
  return outcome.documentId;
}

/** 그 메시지의 출처 행 키 → 노드 id. */
function messageRows(messageId: string): Map<string, number> {
  return new Map(new NodeSourceRepository(db).findMessageSync(messageId, PLATFORM).map((row) => [row.key, row.nodeId]));
}

/** 고친 메시지 — discord.js Message 와 같은 모양(첨부는 id 로 찾는 Map). */
function editedMessage(
  messageId: string, content: string, attachmentIds: string[], extra: Partial<EditableDiscordMessageLike> = {},
): EditableDiscordMessageLike {
  return {
    id: messageId,
    content,
    channelId: MEMO_CHANNEL_ID,
    guildId: GUILD_ID,
    author: { id: OWNER_ID, bot: false, tag: "owner#0001" },
    channel: { isDMBased: () => false },
    attachments: new Map(attachmentIds.map((id) => [id, { id }])),
    ...extra,
  };
}

describe("syncEditedDiscordMessage — 실제 코어와 첨부", () => {
  test("첨부를 뺀 수정이 그 첨부의 기억·문서 기록·파일을 지우고, 글과 남은 첨부는 그대로다", async () => {
    const textId = await postText("msg-1", TEXT);
    const a1Document = await postAttachment("msg-1", "a1", "/workshop.md");
    const a2Document = await postAttachment("msg-1", "a2", "/hiking.txt");
    const before = messageRows("msg-1");
    const a1Node = before.get(attachmentKey("msg-1", "a1"))!;
    const a2Node = before.get(attachmentKey("msg-1", "a2"))!;
    expect(before.get(textKey("msg-1"))).toBe(textId);

    const result = await syncEditedDiscordMessage(editedMessage("msg-1", TEXT, ["a2"]), CONFIG, client);

    expect(result.status).toBe("synced");
    if (result.status !== "synced") return;
    expect(result.changed).toBe(true);
    expect(result.attachmentRemoval.removedAttachmentKeys).toEqual([attachmentKey("msg-1", "a1")]);
    expect(result.attachmentRemoval.deletedIds).toEqual([a1Node]);
    expect(result.attachmentRemoval.assetCleanup.documentIds).toEqual([a1Document]);
    expect(result.attachmentRemoval.assetCleanup.removedSha256s).toHaveLength(1);
    expect(result.attachmentRemoval.assetCleanup.failed).toEqual([]);
    expect(await store.getNode(a1Node)).toBeNull();
    expect(store.getDocument(a1Document)).toBeNull();
    expect(await store.getNode(a2Node)).not.toBeNull();
    expect(store.getDocument(a2Document)).not.toBeNull();
    expect((await store.getNode(textId))!.content).toBe(TEXT);
    expect([...messageRows("msg-1").keys()].sort()).toEqual([attachmentKey("msg-1", "a2"), textKey("msg-1")].sort());
    expect(lineageOrphans(db)).toEqual([]);
  }, 120_000);

  test("글이 빈 메시지(첨부만)도 동기화된다 — content 없이 남은 첨부 목록만 보낸다", async () => {
    await postAttachment("msg-files", "a1", "/workshop.md");
    const a2Document = await postAttachment("msg-files", "a2", "/hiking.txt");
    const a2Node = messageRows("msg-files").get(attachmentKey("msg-files", "a2"))!;

    const result = await syncEditedDiscordMessage(editedMessage("msg-files", "", ["a2"]), CONFIG, client);

    expect(result.status).toBe("synced");
    if (result.status !== "synced") return;
    expect(result).toMatchObject({ changed: true, matchedCount: 0, editedCount: 0, editedIds: [] });
    expect(result.attachmentRemoval.removedAttachmentKeys).toEqual([attachmentKey("msg-files", "a1")]);
    expect([...messageRows("msg-files").entries()]).toEqual([[attachmentKey("msg-files", "a2"), a2Node]]);
    expect(store.getDocument(a2Document)).not.toBeNull();
    expect(lineageOrphans(db)).toEqual([]);
  }, 120_000);

  test("부분 메시지(첨부 목록을 모름)는 보내지 않아 첨부 기억이 그대로다", async () => {
    await postText("msg-partial", TEXT);
    await postAttachment("msg-partial", "a1", "/workshop.md");
    const before = messageRows("msg-partial");

    const result = await syncEditedDiscordMessage(
      editedMessage("msg-partial", TEXT, [], { partial: true }), CONFIG, client,
    );

    expect(result).toEqual({ status: "ignored", reason: "partial message (attachment list unknown)" });
    expect(messageRows("msg-partial")).toEqual(before);
  }, 120_000);
});
