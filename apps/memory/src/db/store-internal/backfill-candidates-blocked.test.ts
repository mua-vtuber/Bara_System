/**
 * 백필 후보 조회 — 막힌 대상 빼기 (2026-10-14 backfill-retry-ledger spec 4.5 3단계). 실제 SQLite + 실제 기록 표.
 * 후보 조회는 임베딩을 쓰지 않아 임베더는 싣지 않는다.
 * 시계: 모든 기록은 고정 NOW_MS 로 남기고 조회 시각도 같은 시계에서 만든다 — 실제 시각에 기대지 않는다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../migrations.ts";
import { SqliteMemoryStore } from "../store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { pastCutoffInZone } from "./helpers.ts";
import type { BackfillAttemptKind } from "./backfill-attempts-sql.ts";
import { BackfillAttemptsLedger, type BackfillRetryPolicy } from "../../memory/backfill-attempts/ledger.ts";

const POLICY: BackfillRetryPolicy = { maxAttempts: 2, retryDelayMin: 30, retryMaxDelayMin: 1440 };
const NOW_MS = Date.UTC(2026, 9, 14, 0, 0, 0);
const MINUTE_MS = 60_000;
/** 첫 실패의 재시도 간격(30분)이 지난 뒤의 시각 */
const AFTER_RETRY_DELAY_MS = NOW_MS + (POLICY.retryDelayMin + 1) * MINUTE_MS;

const at = (ms: number): string => pastCutoffInZone(ms);

let db: Database;
let store: SqliteMemoryStore;
let ledger: BackfillAttemptsLedger;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, new Bgem3Embedder());
  ledger = new BackfillAttemptsLedger(db);
});
afterEach(() => db.close());

function insertMemo(content: string, createdAt: string): number {
  return Number(
    db.query("INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'auto_capture', ?)").run(content, createdAt).lastInsertRowid,
  );
}

function insertImage(sha: string, createdAt: string): number {
  db.query(
    `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, mime_type, original_name, first_imported_at)
     VALUES (?, 'image', ?, 1, 'image/png', NULL, 1)`,
  ).run(sha, `/assets/${sha}.png`);
  db.query(
    `INSERT INTO images (asset_sha256, thumb_sha256, width, height, mime, preserve_mode, is_animated, warnings_json, has_caption_auto, created_at)
     VALUES (?, ?, 1, 1, 'image/png', 'smart', 0, '[]', 0, ?)`,
  ).run(sha, sha, createdAt);
  return Number(
    db.query("INSERT INTO knowledge_nodes (content, source_type, metadata_json, created_at) VALUES (?, 'image_asset', json_object('asset_sha256', ?), ?)")
      .run(`이미지 ${sha.slice(0, 6)}`, sha, createdAt).lastInsertRowid,
  );
}

function fail(kind: BackfillAttemptKind, targetKey: string, nodeId: number, times = 1): void {
  for (let i = 0; i < times; i += 1) {
    ledger.recordCounted({ kind, targetKey, nodeId, fingerprint: "fp", error: "e", policy: POLICY }, NOW_MS);
  }
}

async function extractionIds(limit: number, excludeBlockedAt?: string): Promise<number[]> {
  return (await store.getBackfillCandidates({ limit, ...(excludeBlockedAt !== undefined ? { excludeBlockedAt } : {}) })).map((n) => n.id);
}

describe("추출 후보 — 막힌 대상 빼기", () => {
  test("대기 중·멈춘 대상은 빠지고, 재시도 시각이 지난 대상은 다시 들어온다", async () => {
    const a = insertMemo("가", "2026-10-14 09:00:00");
    const b = insertMemo("나", "2026-10-14 09:01:00");
    const c = insertMemo("다", "2026-10-14 09:02:00");
    fail("extraction", String(a), a);
    fail("extraction", String(b), b, POLICY.maxAttempts);
    expect(await extractionIds(10, at(NOW_MS))).toEqual([c]);
    expect(await extractionIds(10, at(AFTER_RETRY_DELAY_MS))).toEqual([a, c]);
  });

  test("막힌 대상이 있어도 limit 만큼 다른 후보를 고른다", async () => {
    const a = insertMemo("가", "2026-10-14 09:00:00");
    const b = insertMemo("나", "2026-10-14 09:01:00");
    const c = insertMemo("다", "2026-10-14 09:02:00");
    fail("extraction", String(a), a);
    expect(await extractionIds(2, at(NOW_MS))).toEqual([b, c]);
  });

  test("excludeBlockedAt 을 주지 않으면(수동 POST /cleanup) 막힌 대상도 후보다", async () => {
    const a = insertMemo("가", "2026-10-14 09:00:00");
    fail("extraction", String(a), a, POLICY.maxAttempts);
    expect(await extractionIds(10)).toEqual([a]);
  });

  test("캡션 종류의 줄은 추출 후보를 막지 않는다", async () => {
    const a = insertMemo("가", "2026-10-14 09:00:00");
    fail("caption", String(a), a, POLICY.maxAttempts);
    expect(await extractionIds(10, at(NOW_MS))).toEqual([a]);
  });
});

describe("캡션 후보 — 막힌 대상 빼기", () => {
  test("대기·멈춤 이미지는 빠지고 limit 만큼 다른 이미지를 고른다", () => {
    const shaA = "a".repeat(64);
    const shaB = "b".repeat(64);
    const shaC = "c".repeat(64);
    const shaD = "d".repeat(64);
    const a = insertImage(shaA, "2026-10-14 09:00:00");
    const b = insertImage(shaB, "2026-10-14 09:01:00");
    const c = insertImage(shaC, "2026-10-14 09:02:00");
    const d = insertImage(shaD, "2026-10-14 09:03:00");
    fail("caption", shaA, a);
    fail("caption", shaB, b, POLICY.maxAttempts);
    const ids = (ms: number): number[] =>
      store.getUncaptionedImageCandidates({ limit: 2, excludeBlockedAt: at(ms) }).map((r) => r.nodeId);
    expect(ids(NOW_MS)).toEqual([c, d]);
    expect(ids(AFTER_RETRY_DELAY_MS)).toEqual([a, c]);
  });

  test("excludeBlockedAt 이 없으면 막힌 이미지도 후보다", () => {
    const sha = "e".repeat(64);
    const id = insertImage(sha, "2026-10-14 09:00:00");
    fail("caption", sha, id, POLICY.maxAttempts);
    expect(store.getUncaptionedImageCandidates({ limit: 5 }).map((r) => r.nodeId)).toEqual([id]);
  });
});
