/**
 * 캡션 백필 한 주기 + 실패 기록 (2026-10-14 backfill-retry-ledger spec 4.5·4.6·7장).
 *
 * VLM 자리에 진짜 로컬 HTTP 서버(provider-stand-in)를 세우고 실제 OllamaVisionProvider(createVisionProvider)·AssetStore 파일·
 * SQLite 로 주기를 돈다(mock 클래스 0). 실패 경로만 보므로 캡션 저장 성공은 bge-m3 를 싣는 vision-backfill.test.ts 가 본다.
 * 시계는 주입값 하나(NOW_MS)로 고정한다 — 기록 줄의 시각과 막힘 판정이 같은 시계를 쓰므로 시험이 시각에 기대지 않는다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../../assets/asset-store.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { createVisionProvider, type VisionProviderSettings } from "../../llm/vision/index.ts";
import type { BackfillCycleSummary } from "../../scheduler.ts";
import { startProviderStandIn, type ProviderStandIn } from "../../test-utils/provider-stand-in.ts";
import { runVisionBackfillCycle } from "../vision-backfill.ts";
import { captionFingerprint } from "./fingerprint.ts";
import { BackfillAttemptsLedger, type BackfillRetryPolicy } from "./ledger.ts";

const POLICY: BackfillRetryPolicy = { maxAttempts: 2, retryDelayMin: 30, retryMaxDelayMin: 1440 };
const TIMEOUT_MS = 80;
const LOG_PREFIX = "[caption-cycle.test]";
const NOW_MS = Date.UTC(2026, 9, 14, 0, 0, 0);
const MODEL = "test-vlm";

let standIn: ProviderStandIn;
beforeAll(() => { standIn = startProviderStandIn(); });
afterAll(() => standIn.stop());

let db: Database;
let store: SqliteMemoryStore;
let assetStore: AssetStore;
let ledger: BackfillAttemptsLedger;
let tmpDir: string;
let seq = 0;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, new Bgem3Embedder());
  tmpDir = mkdtempSync(join(tmpdir(), "bara-caption-cycle-"));
  assetStore = new AssetStore(tmpDir);
  ledger = new BackfillAttemptsLedger(db);
});
afterEach(() => {
  standIn.requests.length = 0;
  standIn.reply = () => ({ status: 404, body: "not found" });
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function settingsAt(endpoint: string, overrides: Partial<VisionProviderSettings> = {}): VisionProviderSettings {
  return {
    enabled: true, provider: "ollama", model: MODEL, endpoint, apiKey: null,
    tokenCap: 200, forceCall: true, timeoutMs: TIMEOUT_MS, ...overrides,
  };
}

/** 지금 설정으로 계산한 지문 — 시험이 심는 줄이 reconcile 에서 "지문 바뀜"으로 지워지지 않게 한다. */
function fingerprintOf(sha: string, captionPrompt?: string): string {
  return captionFingerprint({ provider: "ollama", model: MODEL, captionPrompt, assetSha256: sha });
}

/** image_asset 노드 + images 행 + asset_files 행. writeFile=false 면 자산 파일을 쓰지 않는다(파일 없음 실패용). */
function seedImage(createdAt: string, writeFile = true): { nodeId: number; sha: string } {
  seq += 1;
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, seq]);
  const sha = writeFile ? assetStore.write(bytes, "png").sha256 : seq.toString(16).padStart(64, "f");
  db.query(
    `INSERT OR IGNORE INTO asset_files (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
     VALUES (?, 'image', ?, ?, 'image/png', NULL, 1)`,
  ).run(sha, assetStore.path(sha, "png"), bytes.byteLength);
  db.query(
    `INSERT INTO images (asset_sha256, thumb_sha256, width, height, mime, preserve_mode, is_animated, warnings_json, has_caption_auto, created_at)
     VALUES (?, ?, 1, 1, 'image/png', 'smart', 0, '[]', 0, ?)`,
  ).run(sha, sha, createdAt);
  const nodeId = Number(
    db.query("INSERT INTO knowledge_nodes (content, source_type, metadata_json, created_at) VALUES (?, 'image_asset', json_object('asset_sha256', ?), ?)")
      .run(`이미지 ${seq}`, sha, createdAt).lastInsertRowid,
  );
  return { nodeId, sha };
}

async function cycle(settings: VisionProviderSettings, opts: { batchSize?: number; captionPrompt?: string } = {}): Promise<BackfillCycleSummary> {
  // provider 는 켜진 설정으로 만든다 — enabled=false 시험은 같은 provider 를 두고 판정(decideVlmInvocation)만 꺼진 설정으로 본다.
  const provider = createVisionProvider({ ...settings, enabled: true });
  if (provider === null) throw new Error("createVisionProvider 가 provider 를 만들지 않았다");
  return runVisionBackfillCycle({
    store, assetStore, visionSettings: settings, provider, batchSize: opts.batchSize ?? 5,
    ...(opts.captionPrompt !== undefined ? { captionPrompt: opts.captionPrompt } : {}),
    logPrefix: LOG_PREFIX, retry: { policy: POLICY }, now: () => NOW_MS,
  });
}

function releaseRetryTime(): void {
  db.query("UPDATE backfill_attempts SET next_retry_at = '2000-01-01 00:00:00' WHERE next_retry_at IS NOT NULL").run();
}

function closedPortUrl(): string {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const url = `http://127.0.0.1:${server.port}`;
  void server.stop(true);
  return url;
}

function seedTerminal(nodeId: number, sha: string, fingerprint: string): void {
  for (let i = 0; i < POLICY.maxAttempts; i += 1) {
    ledger.recordCounted({ kind: "caption", targetKey: sha, nodeId, fingerprint, error: "이전 실패", policy: POLICY }, NOW_MS);
  }
}

describe("세는 실패", () => {
  test("시간 초과 → 다음 주기에 빠짐 → 시각이 지나면 다시 → 상한에서 멈춤, 멈춤 줄 한 번", async () => {
    standIn.reply = () => ({ hang: true });
    const { nodeId, sha } = seedImage("2026-10-14 09:00:00");
    const settings = settingsAt(standIn.origin);
    const errors = spyOn(console, "error");
    try {
      expect(await cycle(settings)).toMatchObject({ candidatesFound: 1, failures: 1, retry: { retryWait: 1, stopped: 0 } });
      expect(ledger.get("caption", sha)).toMatchObject({ nodeId, attemptCount: 1, status: "retryable_failure" });
      expect(ledger.get("caption", sha)!.lastError).toContain(`timeout (${TIMEOUT_MS}ms 초과)`);
      expect((await cycle(settings)).candidatesFound).toBe(0);
      releaseRetryTime();
      expect(await cycle(settings)).toMatchObject({ retry: { retryWait: 0, stopped: 1, cycleStopped: null } });
      const stopLines = errors.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).filter((l: string) => l.includes("caption backfill stopped for"));
      expect(stopLines).toHaveLength(1);
      expect(stopLines[0]).toStartWith(`${LOG_PREFIX} caption backfill stopped for node ${nodeId} (asset ${sha}) after 2 attempts:`);
    } finally {
      errors.mockRestore();
    }
  });

  test("같은 자산을 가리키는 노드가 둘이어도 한 주기에 한 번만 시도하고 한 번만 센다", async () => {
    standIn.reply = () => ({ hang: true });
    const { sha } = seedImage("2026-10-14 09:00:00");
    // 같은 파일을 두 번 가져온 경우 — images 행은 하나, 노드는 둘.
    db.query("INSERT INTO knowledge_nodes (content, source_type, metadata_json, created_at) VALUES (?, 'image_asset', json_object('asset_sha256', ?), ?)")
      .run("이미지 중복", sha, "2026-10-14 09:00:01");
    const summary = await cycle(settingsAt(standIn.origin));
    expect(summary.candidatesFound).toBe(2);
    expect(standIn.requests).toHaveLength(1);
    expect(ledger.get("caption", sha)).toMatchObject({ attemptCount: 1, status: "retryable_failure" });
  });

  test("빈 캡션도 센다", async () => {
    standIn.reply = () => ({ body: { model: MODEL, message: { role: "assistant", content: "   " }, done: true, done_reason: "stop" } });
    const { sha } = seedImage("2026-10-14 09:00:00");
    await cycle(settingsAt(standIn.origin));
    expect(ledger.get("caption", sha)).toMatchObject({ status: "retryable_failure", attemptCount: 1 });
  });

  test("자산 파일이 없어도 센다", async () => {
    const { sha } = seedImage("2026-10-14 09:00:00", false);
    expect(await cycle(settingsAt(standIn.origin))).toMatchObject({ failures: 1 });
    expect(ledger.get("caption", sha)!.lastError).toContain("asset 없음");
  });
});

describe("주기 중단·기록 안 함", () => {
  test("연결 거부(닫힌 포트)면 주기를 멈추고 아무것도 기록하지 않으며 남은 이미지를 건드리지 않는다", async () => {
    seedImage("2026-10-14 09:00:00");
    seedImage("2026-10-14 09:01:00");
    expect(await cycle(settingsAt(closedPortUrl()))).toMatchObject({
      candidatesFound: 2, processed: 1, failures: 1, retry: { cycleStopped: "connection" },
    });
    expect(ledger.rows("caption")).toEqual([]);
  });

  test("설정상 호출하지 않으면(called=false) 기록하지 않는다", async () => {
    const { sha } = seedImage("2026-10-14 09:00:00");
    const summary = await cycle(settingsAt(standIn.origin, { enabled: false }));
    expect(summary.failures).toBe(1);
    expect(ledger.get("caption", sha)).toBeNull();
    expect(standIn.requests).toHaveLength(0);
  });
});

describe("후보 고르기·지문·정리", () => {
  test("막힌 대상이 있어도 batchSize 만큼 다른 이미지를 고른다", async () => {
    standIn.reply = () => ({ hang: true });
    const a = seedImage("2026-10-14 09:00:00");
    const b = seedImage("2026-10-14 09:01:00");
    const c = seedImage("2026-10-14 09:02:00");
    // a 는 지금 지문으로 한 번 실패해 다음 시각(NOW+30분)까지 막혀 있다 — reconcile 이 지우지 않는다.
    ledger.recordCounted({ kind: "caption", targetKey: a.sha, nodeId: a.nodeId, fingerprint: fingerprintOf(a.sha), error: "이전 실패", policy: POLICY }, NOW_MS);
    expect((await cycle(settingsAt(standIn.origin), { batchSize: 2 })).candidatesFound).toBe(2);
    expect(ledger.get("caption", a.sha)!.attemptCount).toBe(1);
    expect(ledger.get("caption", b.sha)!.attemptCount).toBe(1);
    expect(ledger.get("caption", c.sha)!.attemptCount).toBe(1);
  });

  test("캡션 지시문을 바꾸면 지문이 바뀌어 멈춤이 풀린다", async () => {
    standIn.reply = () => ({ hang: true });
    const { nodeId, sha } = seedImage("2026-10-14 09:00:00");
    seedTerminal(nodeId, sha, fingerprintOf(sha, "옛 지시문"));
    expect((await cycle(settingsAt(standIn.origin), { captionPrompt: "옛 지시문" })).candidatesFound).toBe(0);
    expect((await cycle(settingsAt(standIn.origin), { captionPrompt: "새 지시문" })).candidatesFound).toBe(1);
    expect(ledger.get("caption", sha)!.attemptCount).toBe(1);
  });

  test("부모 이미지가 철회되면 주기 시작 때 줄을 지운다", async () => {
    const { nodeId, sha } = seedImage("2026-10-14 09:00:00");
    seedTerminal(nodeId, sha, fingerprintOf(sha));
    db.query("UPDATE knowledge_nodes SET metadata_json = json_set(metadata_json, '$.sharedMemory', json(?)) WHERE id = ?")
      .run(JSON.stringify({ status: "retracted", revision: 1, assertionKind: "unknown" }), nodeId);
    await cycle(settingsAt(standIn.origin));
    expect(ledger.rows("caption")).toEqual([]);
  });
});
