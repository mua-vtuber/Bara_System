/**
 * vision-backfill.test.ts — 비전 백필의 VLM 호출을 쓰기 잠금 밖으로 옮긴 흐름(WP-B1-07, SL-7).
 *
 * VLM 은 테스트 안 로컬 HTTP 서버(Bun.serve)가 Ollama /api/chat 형식으로 지연 응답하고, 실제
 * OllamaVisionProvider(createVisionProvider)가 그 서버를 호출한다. 저장은 실제 SQLite + 실제
 * AssetStore 파일 + 실제 bge-m3(캡션 노드 임베딩)다.
 *
 * 검증:
 *  1. VLM 이 3초 지연하는 동안 쓰기 잠금이 비어 있어 다른 흐름의 잠금 작업이 기다리지 않는다.
 *  2. VLM 호출 중 다른 흐름이 자동 캡션을 달면(has_caption_auto=1) 결과를 버리고 이유를 남긴다.
 *  3. VLM 호출 중 부모 이미지가 철회되면 결과를 버리고 이유를 남기며 has_caption_auto 는 0 이다.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../assets/asset-store.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { createVisionProvider, type VisionProviderSettings } from "../llm/vision/index.ts";
import {
  startDelayedOllamaChatServer,
  type DelayedOllamaChatServer,
} from "../test-utils/delayed-ollama-chat-server.ts";
import { withMemoryMutationLock } from "./shared-memory-mutation-lock.ts";
import { runVisionBackfillCycle } from "./vision-backfill.ts";

const VLM_DELAY_MS = 3_000;
const LOCK_WAIT_LIMIT_MS = 1_000;
const VLM_CAPTION = "창가에 앉은 회색 고양이, 햇빛이 드는 방";
const LOG_PREFIX = "[vision-backfill.test]";
const IMAGE_MIME = "image/png";
const IMAGE_EXT = "png";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let store: SqliteMemoryStore;
let assetStore: AssetStore;
let tmpDir: string;
let server: DelayedOllamaChatServer;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
  tmpDir = mkdtempSync(join(tmpdir(), "bara-vision-lock-"));
  assetStore = new AssetStore(tmpDir);
  server = startDelayedOllamaChatServer({ delayMs: VLM_DELAY_MS, content: VLM_CAPTION });
});
afterEach(() => {
  server.stop();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function visionSettings(): VisionProviderSettings {
  return {
    enabled: true,
    provider: "ollama",
    model: "test-vlm",
    endpoint: server.url,
    apiKey: null,
    tokenCap: 200,
    forceCall: true,
    timeoutMs: VLM_DELAY_MS * 4,
  };
}

function startCycle() {
  const settings = visionSettings();
  const provider = createVisionProvider(settings);
  if (provider === null) throw new Error("createVisionProvider 가 ollama 설정에서 provider 를 만들지 않았다");
  return runVisionBackfillCycle({
    store, assetStore, visionSettings: settings, provider, batchSize: 5, logPrefix: LOG_PREFIX,
  });
}

/** image_asset 노드 + images 행 + 실제 자산 파일을 한 묶음 만든다(scheduler.test.ts 와 같은 방식). */
async function seedImage(): Promise<{ nodeId: number; sha256: string }> {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]);
  const written = assetStore.write(bytes, IMAGE_EXT);
  db.prepare(
    `INSERT OR IGNORE INTO asset_files
       (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
     VALUES (?, 'image', ?, ?, ?, NULL, ?)`,
  ).run(written.sha256, assetStore.path(written.sha256, IMAGE_EXT), bytes.byteLength, IMAGE_MIME, Date.now());
  db.prepare(
    `INSERT INTO images
       (asset_sha256, thumb_sha256, width, height, mime, preserve_mode,
        is_animated, warnings_json, has_caption_auto, created_at)
     VALUES (?, ?, 1, 1, ?, 'smart', 0, '[]', 0, '2026-09-28 10:00:00')`,
  ).run(written.sha256, written.sha256, IMAGE_MIME);
  const nodeId = await store.addNode({
    content: `이미지 자산 ${written.sha256.slice(0, 12)}`,
    sourceType: "image_asset",
    metadata: { asset_sha256: written.sha256 },
  });
  return { nodeId, sha256: written.sha256 };
}

function hasCaptionAuto(sha256: string): number {
  return (db.query("SELECT has_caption_auto AS v FROM images WHERE asset_sha256 = ?").get(sha256) as { v: number }).v;
}

function captionNodeCount(): number {
  return (db.query("SELECT COUNT(*) AS n FROM knowledge_nodes WHERE source_type = 'image_caption'").get() as { n: number }).n;
}

function discardLines(spy: ReturnType<typeof spyOn>, nodeId: number): string[] {
  return spy.mock.calls
    .map((call: unknown[]) => call.map(String).join(" "))
    .filter((line: string) => line.includes(`캡션 결과 버림 node ${nodeId}`));
}

describe("비전 백필 — VLM 호출 동안 쓰기 잠금이 비어 있다", () => {
  test("VLM 3초 지연 중 다른 흐름의 잠금 작업이 기다리지 않고, 캡션은 그 뒤 저장된다", async () => {
    const image = await seedImage();
    const other = await store.addNode({ content: "잠금 작업 대상 기억", sourceType: "user_explicit" });

    const vlmCalled = server.nextRequest();
    let cycleDone = false;
    const cycle = startCycle().then((summary) => { cycleDone = true; return summary; });
    await vlmCalled;
    const lockStart = performance.now();
    await withMemoryMutationLock(store, () => store.bumpMention(other));
    const lockWaitMs = performance.now() - lockStart;

    expect(cycleDone).toBe(false);
    expect(lockWaitMs).toBeLessThan(LOCK_WAIT_LIMIT_MS);

    const summary = await cycle;
    expect(summary).toMatchObject({ candidatesFound: 1, processed: 1, storedNodes: 1, failures: 0 });
    expect(store.getImageCaptions(image.nodeId).auto).toBe(VLM_CAPTION);
    expect(hasCaptionAuto(image.sha256)).toBe(1);
  }, 30_000);
});

describe("비전 백필 — 잠금 안 재확인이 어긋나면 캡션을 버린다", () => {
  test("VLM 호출 중 다른 흐름이 자동 캡션을 달면 저장하지 않고 이유를 남긴다", async () => {
    const image = await seedImage();
    const warn = spyOn(console, "warn");
    try {
      const vlmCalled = server.nextRequest();
      const cycle = startCycle();
      await vlmCalled;
      await withMemoryMutationLock(store, () => store.addImageCaption({
        parentNodeId: image.nodeId, assetSha256: image.sha256, caption: "다른 흐름이 단 캡션", captionRole: "auto",
      }));

      const summary = await cycle;
      expect(summary).toMatchObject({ processed: 1, storedNodes: 0, failures: 0 });
      const lines = discardLines(warn, image.nodeId);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("이미 자동 캡션을 달았다");
    } finally {
      warn.mockRestore();
    }
    expect(captionNodeCount()).toBe(1);
    expect(store.getImageCaptions(image.nodeId).auto).toBe("다른 흐름이 단 캡션");
  }, 30_000);

  test("VLM 호출 중 부모 이미지가 철회되면 저장하지 않고 has_caption_auto 는 0 으로 남는다", async () => {
    const image = await seedImage();
    const warn = spyOn(console, "warn");
    try {
      const vlmCalled = server.nextRequest();
      const cycle = startCycle();
      await vlmCalled;
      await withMemoryMutationLock(store, async () => {
        db.query("UPDATE knowledge_nodes SET metadata_json = json_set(metadata_json, '$.sharedMemory', json(?)) WHERE id = ?")
          .run(JSON.stringify({ status: "retracted", revision: 1, assertionKind: "unknown" }), image.nodeId);
      });

      const summary = await cycle;
      expect(summary).toMatchObject({ processed: 1, storedNodes: 0, failures: 0 });
      const lines = discardLines(warn, image.nodeId);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("기본 조회에서 빠졌다");
    } finally {
      warn.mockRestore();
    }
    expect(captionNodeCount()).toBe(0);
    expect(hasCaptionAuto(image.sha256)).toBe(0);
  }, 30_000);
});
