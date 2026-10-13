/**
 * memories-source-channels.test.ts — 설계 2.1 의 저장 통로마다 출처 행·계보 엣지가 남는다(WP-B1-20T T2).
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 실제 Hono 라우트(buildMemoryApi) + 실제 AssetStore(tmp dir).
 * 추출은 실제 MemoryExtractor 가 실제 OllamaClient 로 이 파일이 띄운 루프백 HTTP 서버(Ollama /api/chat
 * 응답 형식)를 부르고, 이미지는 실제 SigLIP 2 이미지 임베더(createImageEmbedder)다.
 *
 *  - 즉시 추출 원문: 메시지 행. 같은 메시지 재전송은 그대로, 같은 본문 대시보드 저장은 행을 더한다.
 *    추출 자식은 출처 행이 없다(파생).
 *  - from-text preserveRaw 원문, 해시태그 본문 노드: 입력 출처 행.
 *  - 원문 재청크, 문서 청크, OCR 청크, 이미지 캡션: 출처 행 없이 부모로 가는 계보 엣지.
 *  - 문서 노드, 이미지 자산 노드: 입력 통로·작성자의 직접 저장 행.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { createImageEmbedder } from "../../embedding/factory.ts";
import type { ImageEmbedder } from "../../embedding/types.ts";
import { AssetStore } from "../../assets/asset-store.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { NodeSourceRepository } from "../../db/store-internal/node-source-repository.ts";
import { OllamaClient } from "../../llm/ollama-client.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { MemoryExtractor, applyHashtagWiring } from "../../memory/extractor.ts";
import { describeInputSource, sourceKeyOf } from "../../memory/node-sources/source-ref.ts";
import { writeOriginChunksAtomic } from "../../memory/origin-chunks.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-schema.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import { buildMemoryApi } from "../../server.ts";

const EXTRACTION_MODEL = "source-channels-fixture";
const PLATFORM = "discord";
const DISCORD_SOURCE = "discord-channel";
const OWNER = "owner";
const JSON_HEADERS = { "content-type": "application/json" };
/** 루프백 LLM 이 모든 추출 호출에 돌려주는 항목 — 입력 문장과 다른 사실이라 원문에 흡수되지 않는다. */
const EXTRACTED_FACT = "배포 창구는 금요일 오후다";
const FIXTURES = join(import.meta.dir, "..", "..", "memory");

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let dir: string;
let db: Database;
let store: SqliteMemoryStore;
let settings: MemorySettings;
let llm: ReturnType<typeof Bun.serve>;
let extractor: MemoryExtractor;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-source-channels-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  llm = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/api/chat") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({
        model: EXTRACTION_MODEL,
        message: { role: "assistant", content: JSON.stringify([{ content: EXTRACTED_FACT, memoryType: "fact", importance: 0.8 }]) },
        done: true,
      });
    },
  });
  extractor = new MemoryExtractor(
    new OllamaClient({ baseUrl: `http://127.0.0.1:${llm.port}`, model: EXTRACTION_MODEL }),
    store, embedder, { duplicateSim: 0.999, minImportance: 0 },
  );
});

afterEach(() => {
  llm.stop(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function buildApp(imageEmbedder?: ImageEmbedder): Hono {
  return buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(),
    extractor, assetStore: new AssetStore(dir), getSettings: () => settings,
    ...(imageEmbedder !== undefined ? { imageEmbedder } : {}),
  });
}

async function postJson(app: Hono, path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await app.request(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return await res.json() as Record<string, unknown>;
}

const messageKey = (messageId: string) => sourceKeyOf({ kind: "message", platform: PLATFORM, messageId });
const saveKey = (channel: string, actor: string) => sourceKeyOf({ kind: "direct_save", channel, actor });
const discordMetadata = (messageId: string) => ({ messageId, channelId: "channel-1", guildId: "guild-1", source: DISCORD_SOURCE });

function sourceKeys(id: number): string[] {
  return new NodeSourceRepository(db).listSync([id]).get(id)!.map((row) => row.key);
}

function mentionCount(id: number): number {
  return (db.query("SELECT mention_count FROM knowledge_nodes WHERE id = ?").get(id) as { mention_count: number }).mention_count;
}

function lineageParents(id: number): Array<[number, string, string]> {
  return (db.query(`SELECT target_id, relation, provenance FROM knowledge_edges
    WHERE source_id = ? AND relation IN ('merged_into', 'parent_of') ORDER BY target_id`).all(id) as Array<{
    target_id: number; relation: string; provenance: string;
  }>).map((edge) => [edge.target_id, edge.relation, edge.provenance]);
}

describe("직접 저장 통로 — 입력 출처 행", () => {
  test("즉시 추출 원문은 메시지 행을 갖고, 재전송은 그대로·같은 본문 대시보드 저장은 행을 더한다", async () => {
    settings.llm.extractor.enabled = true;
    settings.llm.extractor.mode = "immediate";
    const app = buildApp();
    const content = "배포 창구를 금요일 오후로 확정했다. 담당은 운영팀이 맡는다.";
    const saved = await postJson(app, "/memories", {
      content, platform: PLATFORM, author: OWNER, force: true, metadata: discordMetadata("msg-immediate"),
    });
    const origin = saved.id as number;
    const children = saved.extracted as number[];
    expect(children.length).toBeGreaterThan(0);
    expect(sourceKeys(origin)).toEqual([messageKey("msg-immediate")]);
    for (const child of children) {
      expect(sourceKeys(child)).toEqual([]);
      expect(lineageParents(child)).toEqual([[origin, "merged_into", "system"]]);
    }

    const mentions = mentionCount(origin);
    const resent = await postJson(app, "/memories", {
      content, platform: PLATFORM, author: OWNER, force: true, metadata: discordMetadata("msg-immediate"),
    });
    expect(resent.id).toBe(origin);
    expect(sourceKeys(origin)).toEqual([messageKey("msg-immediate")]);
    expect(mentionCount(origin)).toBe(mentions);

    const dashboard = await postJson(app, "/memories", { content, platform: "dashboard", author: OWNER });
    expect(dashboard.id).toBe(origin);
    expect(sourceKeys(origin)).toEqual([messageKey("msg-immediate"), saveKey("dashboard", OWNER)]);
  }, 60_000);

  test("from-text preserveRaw 원문은 메시지 행을 갖고, 추출 자식은 행이 없다", async () => {
    const app = buildApp();
    const body = await postJson(app, "/memories/from-text", {
      text: "배포 창구를 금요일 오후로 확정했다. 담당은 운영팀이 맡는다.",
      platform: PLATFORM, author: OWNER, preserveRaw: true, metadata: discordMetadata("msg-from-text"),
    });
    const raw = (body.raw as { id: number }).id;
    expect(sourceKeys(raw)).toEqual([messageKey("msg-from-text")]);
    for (const child of body.stored as number[]) expect(sourceKeys(child)).toEqual([]);
  }, 60_000);

  test("해시태그 본문 노드는 입력 칸의 메시지 출처 행을 갖는다", async () => {
    const result = await applyHashtagWiring(store, "#여행 제주도 일정을 다시 정했다", {
      platform: PLATFORM, author: OWNER, metadata: discordMetadata("msg-hashtag"), embedder,
    });
    expect(result.bodyNodeId).not.toBeNull();
    expect(sourceKeys(result.bodyNodeId!)).toEqual([messageKey("msg-hashtag")]);
  }, 60_000);
});

describe("파생 통로 — 출처 행 없이 계보 엣지", () => {
  test("원문 재청크(writeOriginChunksAtomic)의 청크는 원문으로 가는 parent_of 엣지만 갖는다", async () => {
    const paragraphs = [
      "첫 문단은 금요일 오후 창구를 쓴다. 이유는 주말 대응 인력 때문이다.",
      "둘째 문단은 알림 결론이다. 운영팀 채널로 보내기로 확정했다.",
      "셋째 문단은 점검 목록을 정한다. 배포 전날 저녁에 다시 확인한다.",
    ];
    const originId = await store.addNode({
      content: paragraphs.join("\n\n"), platform: PLATFORM, author: OWNER,
      provenance: { kind: "source", source: describeInputSource({ source: PLATFORM, author: OWNER, metadata: discordMetadata("msg-long") }) },
    });
    const chunks = await writeOriginChunksAtomic(store, (await store.getNode(originId))!, { tokenCap: 80, minChunkTokens: 1 }, {
      clearPending: false,
    });
    expect(chunks).toHaveLength(paragraphs.length);
    for (const chunk of chunks) {
      expect(sourceKeys(chunk)).toEqual([]);
      expect(lineageParents(chunk)).toEqual([[originId, "parent_of", "system"]]);
    }
  }, 60_000);

  test("문서 노드는 입력 행을 갖고, 문서 청크와 OCR 청크는 문서 노드로 가는 parent_of 엣지만 갖는다", async () => {
    const app = buildApp();
    const ingested = await postJson(app, "/ingest", {
      source: "dashboard:manual",
      content: {
        type: "auto",
        data: readFileSync(join(FIXTURES, "canonicalize", "__fixtures__", "scanned.pdf")).toString("base64"),
        mimeType: "application/pdf",
        originalName: "scanned.pdf",
      },
      attribution: { author: "테스터", userId: "u-doc" },
    });
    const documentId = ingested.documentId as string;
    const documentNode = store.findDocumentNodeId(documentId)!;
    expect(sourceKeys(documentNode)).toEqual([saveKey("dashboard:manual", "테스터")]);

    const res = await app.request(`/api/documents/${documentId}/ocr-result`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ markdown: "# OCR 결과\n\n배포 창구 문서 본문입니다.", source: "manual", providerName: "manual-test" }),
    });
    expect(res.status).toBe(200);
    const nodeIds = (await res.json() as { nodeIds: number[] }).nodeIds;
    expect(nodeIds[0]).toBe(documentNode);
    const ocrChunks = nodeIds.slice(1);
    expect(ocrChunks.length).toBeGreaterThan(0);
    for (const chunk of ocrChunks) {
      expect(sourceKeys(chunk)).toEqual([]);
      expect(lineageParents(chunk)).toEqual([[documentNode, "parent_of", "system"]]);
    }
  }, 120_000);

  describe("이미지", () => {
    let imageEmbedder: ImageEmbedder;
    beforeAll(() => {
      imageEmbedder = createImageEmbedder();
    }, 180_000);

    test("이미지 자산 노드는 입력 행을 갖고, 자동·사용자 캡션은 이미지로 가는 parent_of 엣지만 갖는다", async () => {
      const app = buildApp(imageEmbedder);
      const body = await postJson(app, "/ingest", {
        source: DISCORD_SOURCE,
        content: {
          type: "image",
          data: readFileSync(join(FIXTURES, "image-preserve", "__fixtures__", "static-small.png")).toString("base64"),
          mimeType: "image/png",
          originalName: "rabbit.png",
        },
        attribution: { author: "친구B", userId: "discord-user-1" },
      });
      const image = (body.images as Array<{ nodeId: number }>)[0]!.nodeId;
      expect(sourceKeys(image)).toEqual([saveKey(DISCORD_SOURCE, "친구B")]);

      const assetSha256 = (await store.getNode(image))!.metadata.asset_sha256 as string;
      const auto = await store.addImageCaption({ parentNodeId: image, assetSha256, caption: "풀밭의 토끼", captionRole: "auto" });
      const user = await store.addImageCaption({ parentNodeId: image, assetSha256, caption: "우리 집 토끼", captionRole: "user" });
      expect(sourceKeys(auto)).toEqual([]);
      expect(sourceKeys(user)).toEqual([]);
      expect(lineageParents(auto)).toEqual([[image, "parent_of", "image"]]);
      expect(lineageParents(user)).toEqual([[image, "parent_of", "user_input"]]);
    }, 180_000);
  });
});
