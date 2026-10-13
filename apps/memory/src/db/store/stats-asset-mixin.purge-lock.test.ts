/**
 * stats-asset-mixin.purge-lock.test.ts — 휴지통 보관 만료(purgeOldArchive)가 쓰기 잠금 안에서 도는지 고정한다
 * (WP-B1-20U 설계 17.18 설계 6, U10c).
 *
 * purgeOldArchive 의 본체(purgeOldArchiveSync + removeReleasedAssetFiles)는 동기라, 잠금이 없으면 부르는 그 자리에서
 * 보관 행을 지운다. 그래서 두 가지가 결정적으로 갈린다: (1) 다른 쓰기 잠금 보유자가 있는 동안 부른 직후에도 보관 행이
 * 그대로이고 응답이 오지 않는다 — 잠금이 없으면 부른 직후 행이 사라진다. (2) 보유자가 놓은 뒤에야 지우고 응답한다.
 * runTrashManagement(trash cron 의 진입점)를 거쳐도 같다. 잠금 보유자는 memories-explicit-removal.test.ts 의
 * deleteWhileLocked 와 같은 방식(withMemoryMutationLock 으로 게이트를 쥔다)이다.
 *
 * 더해서 /ingest 와 보관 만료가 같은 첨부 파일을 두고 부딪치는 재현 R4(두 순서)·R5(자산 묶음이 커밋된 직후 만료)를
 * 회귀로 둔다: 만료가 지우는 파일은 다시 올린 문서가 쓰기 시작한 파일이 아니어야 한다.
 *
 * 실제 SQLite(:memory:) + 실제 bge-m3 + 임시 디렉터리의 실제 AssetStore + 실제 Hono 라우트. mock 0.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetStore } from "../../assets/asset-store.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { withMemoryMutationLock } from "../../memory/shared-memory-mutation-lock.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { runTrashManagement } from "../../memory/trash-manager.ts";
import { installAssetFileRemover } from "../../server-internal/asset-file-remover-boot.ts";
import { buildMemoryApi } from "../../server.ts";
import { getMemorySettings } from "../../settings/memory-settings.ts";
import { assetContentFiles, assetInvariantViolations } from "../../test-utils/asset-invariant.ts";
import { lineageOrphans } from "../../test-utils/lineage-invariant.ts";
import { openMemoryDatabase } from "../migrations.ts";
import { SqliteMemoryStore } from "../store.ts";

const DIM = 1024;
const LONG_AGO = "2000-01-01 00:00:00";
const LOCK_SETTLE_MS = 500;
const DASHBOARD_SOURCE = "dashboard:manual";
const ATTRIBUTION = { author: "owner", userId: "user-1" };
const NOTE_TXT = "캠핑 준비물\n\n텐트와 침낭은 금요일 저녁까지 차에 싣는다. 버너 가스는 두 통 챙긴다.";
const EXPIRE_NOW = { retentionDays: 0, warningDays: 0 } as const;

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
}, 180_000);

interface Harness { app: Hono; db: Database; store: SqliteMemoryStore; dir: string }
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "bara-purge-lock-"));
  const db = openMemoryDatabase(":memory:", { embeddingDim: DIM });
  const store = new SqliteMemoryStore(db, embedder);
  const assetStore = new AssetStore(dir);
  await installAssetFileRemover(store, assetStore);
  const settings = getMemorySettings("/nonexistent-default-purge-lock-test", "/nonexistent-default-purge-lock-test.secrets.json");
  const app = buildMemoryApi({
    store, retriever: new HybridRetriever(store, embedder), assembler: new ContextAssembler(), assetStore,
    getSettings: () => settings,
  });
  const h = { app, db, store, dir };
  harnesses.push(h);
  return h;
}

type Json = Record<string, unknown>;
async function call(h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await h.app.request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as Json };
}

const count = (db: Database, table: string) => (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

/** 쓰기 잠금을 쥔 보유자. release() 가 게이트를 열고 보유자가 끝나길 기다린다. */
function holdMutationLock(store: SqliteMemoryStore): { release: () => Promise<void> } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const holder = withMemoryMutationLock(store, () => gate);
  return { release: async () => { open(); await holder; } };
}

/** 노드 하나를 휴지통에 넣고 보관 시각을 아주 옛날로 돌려 만료 대상으로 만든다. */
async function archiveExpiredNode(h: Harness, content: string): Promise<number> {
  const embedding = new Float32Array(DIM);
  embedding[0] = 1;
  const id = await h.store.addNode({ content, importance: 0.1, embedding });
  await h.store.trashNodes([id], "cascade");
  h.db.query("UPDATE knowledge_nodes_archive SET archived_at = ? WHERE id = ?").run(LONG_AGO, id);
  return id;
}

describe("보관 만료는 다른 쓰기 잠금 보유자가 있는 동안 기다린다", () => {
  test("store.purgeOldArchive(0): 부른 직후와 잠금이 풀리기 전까지 보관 행이 그대로, 놓은 뒤에 지운다", async () => {
    const h = await makeHarness();
    await archiveExpiredNode(h, "잠금 뒤에 만료될 보관 노드");
    expect(count(h.db, "knowledge_nodes_archive")).toBe(1);

    const holder = holdMutationLock(h.store);
    let finished = false;
    const purging = h.store.purgeOldArchive(0).then((result) => {
      finished = true;
      return result;
    });
    // 잠금이 없으면 동기 본체가 부르는 즉시 지워 이 줄이 0 을 본다.
    expect(count(h.db, "knowledge_nodes_archive")).toBe(1);
    await Bun.sleep(LOCK_SETTLE_MS);
    expect(finished).toBe(false);
    expect(count(h.db, "knowledge_nodes_archive")).toBe(1);

    await holder.release();
    const result = await purging;
    expect(finished).toBe(true);
    expect(result.nodesPurged).toBe(1);
    expect(count(h.db, "knowledge_nodes_archive")).toBe(0);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 60_000);

  test("runTrashManagement: 같은 검사 — 잠금이 풀리기 전에는 응답도 지우기도 없다", async () => {
    const h = await makeHarness();
    await archiveExpiredNode(h, "trash cron 이 잠금 뒤에 지울 보관 노드");
    expect(count(h.db, "knowledge_nodes_archive")).toBe(1);

    const holder = holdMutationLock(h.store);
    let finished = false;
    const managing = runTrashManagement(h.store, EXPIRE_NOW).then((summary) => {
      finished = true;
      return summary;
    });
    expect(count(h.db, "knowledge_nodes_archive")).toBe(1);
    await Bun.sleep(LOCK_SETTLE_MS);
    expect(finished).toBe(false);
    expect(count(h.db, "knowledge_nodes_archive")).toBe(1);

    await holder.release();
    const summary = await managing;
    expect(summary.nodesPurged).toBe(1);
    expect(summary.assetCleanup.failed).toEqual([]);
    expect(count(h.db, "knowledge_nodes_archive")).toBe(0);
    expect(lineageOrphans(h.db)).toEqual([]);
  }, 60_000);
});

describe("보관 만료와 /ingest 재업로드가 같은 첨부 파일을 두고 부딪친다", () => {
  const upload = (h: Harness) => call(h, "POST", "/ingest", {
    source: DASHBOARD_SOURCE,
    content: { type: "text", data: NOTE_TXT, mimeType: "text/plain", originalName: "camp.txt" },
    attribution: ATTRIBUTION,
  });

  /** 첫 업로드의 문서 노드를 휴지통에 넣고 보관 시각을 옛날로 돌려 만료 대상으로 만든다. 반환: 보관 행 수(문서 노드와 청크). */
  async function uploadAndArchiveExpired(h: Harness): Promise<number> {
    const first = await upload(h);
    expect(first.status).toBe(201);
    expect((await call(h, "POST", `/memories/${(first.body.nodeIds as number[])[0]}/trash`)).status).toBe(200);
    h.db.query("UPDATE knowledge_nodes_archive SET archived_at = ?").run(LONG_AGO);
    const archived = count(h.db, "knowledge_nodes_archive");
    expect(archived).toBeGreaterThan(0);
    return archived;
  }

  for (const order of ["purge-first", "ingest-first"] as const) {
    test(`R4 ${order}: 보관 만료가 파일을 지우는 동안 같은 파일을 다시 /ingest 해도 새 문서가 파일을 잃지 않는다`, async () => {
      const h = await makeHarness();
      const archived = await uploadAndArchiveExpired(h);

      let again;
      let summary;
      if (order === "purge-first") {
        const purging = runTrashManagement(h.store, EXPIRE_NOW);
        const ingesting = upload(h);
        [summary, again] = await Promise.all([purging, ingesting]);
      } else {
        const ingesting = upload(h);
        const purging = runTrashManagement(h.store, EXPIRE_NOW);
        [again, summary] = await Promise.all([ingesting, purging]);
      }

      expect(summary.nodesPurged).toBe(archived);
      expect(again.status).toBe(201);
      const assetSha256 = again.body.assetSha256 as string;
      expect(h.store.getDocument(again.body.documentId as string)).not.toBeNull();
      expect(assetContentFiles(h.dir)).toEqual([`${assetSha256}.txt`]);
      expect(assetInvariantViolations(h.db, h.dir, [])).toEqual([]);
      expect((await h.app.request(`/assets/${assetSha256}`)).status).toBe(200);
      expect(lineageOrphans(h.db)).toEqual([]);
    }, 120_000);
  }

  test("R5: 재업로드의 자산 묶음이 커밋된 직후(문서 노드 저장 전) 보관 만료가 돌아도 그 파일을 지우지 않는다", async () => {
    const h = await makeHarness();
    const archived = await uploadAndArchiveExpired(h);

    let ingestSettled = false;
    const ingesting = upload(h).finally(() => { ingestSettled = true; });
    // 두 번째 문서 기록(documents 행)이 생긴 순간 = 자산 묶음 커밋 직후. 업로드가 먼저 끝나면 그 순간을 놓친 것이다.
    while (count(h.db, "documents") < 2) {
      if (ingestSettled) throw new Error("자산 묶음 커밋 시점을 보기 전에 /ingest 가 끝났다 — documents 행이 2개가 된 적이 없다");
      await Bun.sleep(0);
    }
    const purging = runTrashManagement(h.store, EXPIRE_NOW);
    const [again, summary] = await Promise.all([ingesting, purging]);

    expect(summary.nodesPurged).toBe(archived);
    expect(again.status).toBe(201);
    expect(summary.assetCleanup.removedSha256s).toEqual([]);
    expect(assetContentFiles(h.dir)).toEqual([`${again.body.assetSha256 as string}.txt`]);
    expect(assetInvariantViolations(h.db, h.dir, [])).toEqual([]);
  }, 120_000);
});
