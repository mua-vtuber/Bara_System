/**
 * routes/ingest-image-attribution.test.ts — DA-3: POST /ingest 이미지 분기의
 * image_asset 노드 metadata 에 user_id·source 기록.
 *
 * ingest-image.ts 의 addImageAssetNode metadata 에는 attribution 세 축 중
 * author/platform 만 knowledge_nodes 칼럼으로 저장되고, user_id·source 는 다른
 * /ingest 갈래(문서 원문 — ingest-document-flow.ts documentMetadata)처럼 metadata
 * 칸에 기록돼야 한다(docs/decisions/2026-09-20-discord-author-metadata.md 5행:
 * "메시지·채널·서버 ID도 유지한다" 정신 — user_id 보존 없이는 봇이 나중에 작성자를
 * 복원할 수 없다). ingest.test.ts 의 (k)/(k1.5) image 분기 harness 를 그대로 쓴다.
 *
 * mock 0 — 실 SQLite(:memory:) + 실 Bgem3Embedder + 실 AssetStore(tmp dir) + 실
 * Hono 라우트 + 실 SigLIP 2 이미지 임베더(createImageEmbedder, ingest-image.int.test.ts
 * beforeAll 선례 — describe 안 한 번만 로드해 다운로드 비용을 공유한다). 인터페이스를
 * 흉내 내는 stub 객체는 만들지 않는다(CLAUDE.md "테스트 정책" — Mock 객체 금지,
 * WP-B1-19R).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { AssetStore } from "../../assets/asset-store.ts";
import { getMemorySettings } from "../../settings/memory-settings.ts";
import { buildMemoryApi } from "../../server.ts";
import { createImageEmbedder } from "../../embedding/factory.ts";
import type { ImageEmbedder } from "../../embedding/types.ts";

const PNG_FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "memory",
  "image-preserve",
  "__fixtures__",
  "static-small.png",
);

let embedder: Bgem3Embedder;
// SigLIP 2 singleton — describe 안 한 번 로드, 모든 test 공유(ingest-image.int.test.ts
// 선례). 이 파일은 metadata 배선만 검증하고 image_vec 값 자체는 보지 않는다.
let imageEmbedder: ImageEmbedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
  imageEmbedder = createImageEmbedder();
}, 180_000);
afterAll(() => {});

let dir: string;
let db: Database;
let store: SqliteMemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-ingest-image-attribution-"));
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function buildApp() {
  const settings = getMemorySettings("/nonexistent-default-ingest-test", "/nonexistent-default-ingest-test.secrets.json");
  return buildMemoryApi({
    store,
    retriever: new HybridRetriever(store, embedder),
    assembler: new ContextAssembler(),
    assetStore: new AssetStore(dir),
    imageEmbedder,
    getSettings: () => settings,
  });
}

describe("POST /ingest image 분기 — image_asset metadata 의 user_id·source (DA-3)", () => {
  test("Discord 이미지 — metadata 에 user_id·source 기록(사람 엔티티는 안 만듦)", async () => {
    const app = buildApp();
    const pngBase64 = readFileSync(PNG_FIXTURE).toString("base64");

    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "discord-channel",
        content: {
          type: "image",
          data: pngBase64,
          mimeType: "image/png",
          originalName: "rabbit.png",
        },
        attribution: { author: "친구B", userId: "discord-user-1" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      images: Array<{ nodeId: number }>;
    };
    const nodeId = json.images[0]!.nodeId;

    const node = await store.getNode(nodeId);
    expect(node?.metadata).toMatchObject({
      user_id: "discord-user-1",
      source: "discord-channel",
    });

    // Discord 는 attribution-only — 이미지도 텍스트 원문과 같은 정책(person-link 미가동).
    expect(await store.listPersons({ limit: 10 })).toHaveLength(0);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
  }, 180_000);

  test("비Discord 이미지 — metadata 에 user_id·source 기록", async () => {
    const app = buildApp();
    const pngBase64 = readFileSync(PNG_FIXTURE).toString("base64");

    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "image",
          data: pngBase64,
          mimeType: "image/png",
          originalName: "cat.png",
        },
        attribution: { author: "본인", userId: "u1" },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      images: Array<{ nodeId: number }>;
    };
    const nodeId = json.images[0]!.nodeId;

    const node = await store.getNode(nodeId);
    expect(node?.metadata).toMatchObject({
      user_id: "u1",
      source: "dashboard:manual",
    });
  }, 180_000);

  test("user_id 없는 이미지 — metadata.user_id 는 빈 문자열, source 는 그대로 기록", async () => {
    const app = buildApp();
    const pngBase64 = readFileSync(PNG_FIXTURE).toString("base64");

    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "dashboard:manual",
        content: {
          type: "image",
          data: pngBase64,
          mimeType: "image/png",
          originalName: "no-user.png",
        },
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      images: Array<{ nodeId: number }>;
    };
    const nodeId = json.images[0]!.nodeId;

    const node = await store.getNode(nodeId);
    expect(node?.metadata).toMatchObject({
      user_id: "",
      source: "dashboard:manual",
    });
  }, 180_000);
});
