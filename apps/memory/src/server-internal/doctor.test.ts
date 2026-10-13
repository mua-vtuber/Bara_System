/**
 * server-internal/doctor.test.ts — runDoctor 단위 검증 (T23 / spec E).
 *
 * 실 SQLite + 실 bge-m3(mock 금지·CLAUDE.md). healthy path 는 실 DB 정합 상태를
 * 그대로 진단해 전건 healthy + firstBlockingCause null 을 확인한다. fault
 * injection 은 스크래치 DB 를 일부러 어긋나게 만들어(FTS 행 삭제·vec 행 삭제)
 * 해당 단계만 unhealthy 로 갈리는지 + 의존 순서상 더 앞선 단계가 있으면 그쪽이
 * firstBlockingCause 가 되는지 검증한다.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../embedding/factory.ts";
import { SIGLIP2_DIM } from "../embedding/siglip2.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { makeWalTempDir, cleanupTempDir } from "../db/wal-test-helpers.ts";
import { getConfiguredTimeZone, nowKst, setTimeZone } from "../db/store-internal/helpers.ts";
import { addImageAssetNode } from "../memory/image-asset.ts";
import type { MemoryApiDeps } from "./types.ts";
import { runDoctor } from "./doctor.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) cleanupTempDir(tempDirs.pop()!);
});

let db: Database;
let store: SqliteMemoryStore;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  db.close();
});

/** getSettings 없는 최소 deps — embedder 단계가 default(bge-m3)로 판정하는 경로. */
function baseDeps(overrides: Partial<MemoryApiDeps> = {}): MemoryApiDeps {
  return { store, retriever: {} as never, assembler: {} as never, ...overrides };
}

// ── healthy path ───────────────────────────────────────────────────────────

test("healthy path — 전건 healthy + firstBlockingCause null(backup 미배선은 정직한 비활성)", async () => {
  await store.addNode({ content: "테스트 글", sourceType: "user_explicit" });
  const report = runDoctor(baseDeps());
  for (const s of report.stages) {
    expect(`${s.name}: ${s.healthy}`).toBe(`${s.name}: true`);
  }
  expect(report.firstBlockingCause).toBeNull();
  expect(report.counters.knowledgeNodes).toBe(1);
  expect(report.counters.vecNodes).toBe(1);
  expect(report.counters.ftsRows).toBe(1);
  // 리뷰 Minor — embedder healthy detail 이 "설정 정합만 확인, 실동작 probe 아님"을
  // 명시해야 healthy=true 가 "실동작 확인됨"으로 오독되지 않는다.
  const embedderStage = report.stages.find((s) => s.name === "embedder")!;
  expect(embedderStage.detail).toContain("실동작 probe 아님");
});

test("healthy path — image_asset 노드가 섞여 있어도 vecConsistency healthy(리뷰 High 1 회귀 방지)", () => {
  // image_asset 은 addImageAssetNode 전용 경로로 만들어지고 embedding_text=NULL +
  // vec_nodes(텍스트 벡터) 미삽입이 설계상 정상이다(image-asset.ts). asset_files
  // FK 정합을 위해 dummy row 를 먼저 넣는다(image-asset.test.ts freshDb 선례).
  db.run(
    `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, mime_type, first_imported_at)
     VALUES ('doctorimg', 'image', 'image/do/ctorimg.png', 100, 'image/png', ?)`,
    [Date.now()],
  );
  const embedding = new Float32Array(SIGLIP2_DIM).fill(0.01);
  addImageAssetNode(db, {
    content: "doctor 테스트용 이미지",
    embedding,
    assetSha256: "doctorimg",
  });
  const report = runDoctor(baseDeps());
  const vecStage = report.stages.find((s) => s.name === "vecConsistency")!;
  expect(vecStage.healthy).toBe(true);
  expect(vecStage.detail).toContain("image_asset 1건 별도");
  expect(report.firstBlockingCause).toBeNull();
  // counters.knowledgeNodes 는 image_asset 포함 전체 건수(표시용 — vecConsistency
  // 판정 모집단과는 다른 값이라는 점을 명확히 한다).
  expect(report.counters.knowledgeNodes).toBe(1);
});

test("stages 이름 8종 + 순서(의존 순서) 고정", () => {
  const report = runDoctor(baseDeps());
  expect(report.stages.map((s) => s.name)).toEqual([
    "db",
    "embedder",
    "vecConsistency",
    "ftsConsistency",
    "imageVecConsistency",
    "cleanup",
    "backup",
    "disk",
  ]);
});

test("backup 미주입 시 backup·disk 두 단계는 healthy(정직한 비활성) — assetStore/backup 라우트 관례 정합", () => {
  const report = runDoctor(baseDeps());
  const backupStage = report.stages.find((s) => s.name === "backup")!;
  const diskStage = report.stages.find((s) => s.name === "disk")!;
  expect(backupStage.healthy).toBe(true);
  expect(backupStage.detail).toContain("미배선");
  expect(diskStage.healthy).toBe(true);
  expect(diskStage.detail).toContain(":memory:");
});

// ── fault injection ──────────────────────────────────────────────────────

test("FTS 정합 결함 — knowledge_nodes_fts 행 삭제 시 ftsConsistency unhealthy + firstBlockingCause", async () => {
  await store.addNode({ content: "FTS 결함 유발용 글", sourceType: "user_explicit" });
  // FTS 는 contentless 라 delete 명령('delete', rowid, content)으로 색인만 지운다 —
  // 본 테이블(knowledge_nodes)은 그대로 둬 vec 정합은 안 건드리고 FTS 만 어긋나게 한다.
  db.run(
    "INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, content) VALUES ('delete', 1, ?)",
    ["FTS 결함 유발용 글"],
  );
  const report = runDoctor(baseDeps());
  const ftsStage = report.stages.find((s) => s.name === "ftsConsistency")!;
  expect(ftsStage.healthy).toBe(false);
  expect(ftsStage.detail).toContain("불일치");
  expect(report.firstBlockingCause?.stage).toBe("ftsConsistency");
  expect(report.firstBlockingCause?.fix.length).toBeGreaterThan(0);
});

test("vec 정합 결함 — vec_nodes 행 삭제 시 vecConsistency unhealthy + FTS 는 정상", async () => {
  const id = await store.addNode({ content: "vec 결함 유발용 글", sourceType: "user_explicit" });
  db.run("DELETE FROM vec_nodes WHERE node_id = ?", [id]);
  const report = runDoctor(baseDeps());
  const vecStage = report.stages.find((s) => s.name === "vecConsistency")!;
  const ftsStage = report.stages.find((s) => s.name === "ftsConsistency")!;
  expect(vecStage.healthy).toBe(false);
  expect(ftsStage.healthy).toBe(true);
  expect(report.firstBlockingCause?.stage).toBe("vecConsistency");
});

test("의존 순서 — vec·FTS 동시 결함이면 앞선 vecConsistency 가 firstBlockingCause", async () => {
  const id = await store.addNode({ content: "동시 결함 글", sourceType: "user_explicit" });
  db.run("DELETE FROM vec_nodes WHERE node_id = ?", [id]);
  db.run(
    "INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, content) VALUES ('delete', ?, ?)",
    [id, "동시 결함 글"],
  );
  const report = runDoctor(baseDeps());
  expect(report.stages.find((s) => s.name === "vecConsistency")!.healthy).toBe(false);
  expect(report.stages.find((s) => s.name === "ftsConsistency")!.healthy).toBe(false);
  // 의존 순서상 vecConsistency 가 ftsConsistency 보다 앞이므로 firstBlockingCause 는 vec 쪽 하나.
  expect(report.firstBlockingCause?.stage).toBe("vecConsistency");
});

// ── imageVecConsistency — SigLIP 이미지 채널 전용 판정 ────────────────────

/**
 * image_asset 노드를 (임베딩 보유 withVec 건 + 임베딩 없는 withoutVec 건) 만든다.
 * embedding=null 은 addImageAssetNode 의 정식 skip 경로(warn 후 노드만 생성) —
 * SigLIP 미로드 상황을 실 저장 경로 그대로 재현한다. asset_files dummy 선삽입은
 * 위 healthy path image 테스트 선례 정합.
 */
function seedImageNodes(withVec: number, withoutVec: number): void {
  const embedding = new Float32Array(SIGLIP2_DIM).fill(0.01);
  let seq = 0;
  const add = (vec: Float32Array | null) => {
    seq += 1;
    const sha = `imgvec${seq}-${withVec}-${withoutVec}`;
    db.run(
      `INSERT INTO asset_files (sha256, asset_type, asset_path, byte_size, mime_type, first_imported_at)
       VALUES (?, 'image', ?, 100, 'image/png', ?)`,
      [sha, `image/im/${sha}.png`, Date.now()],
    );
    addImageAssetNode(db, {
      content: `imageVec 판정용 이미지 ${seq}`,
      embedding: vec,
      assetSha256: sha,
    });
  };
  for (let i = 0; i < withVec; i += 1) add(embedding);
  for (let i = 0; i < withoutVec; i += 1) add(null);
}

test("imageVecConsistency — image_asset 노드 0건이면 healthy(실제 빈 상태 명시)", () => {
  const report = runDoctor(baseDeps());
  const stage = report.stages.find((s) => s.name === "imageVecConsistency")!;
  expect(stage.healthy).toBe(true);
  expect(stage.detail).toContain("실제 빈 상태");
});

test("imageVecConsistency — 이미지 노드는 있는데 image_vec 0건이면 unhealthy(SigLIP 채널 전멸) + firstBlockingCause", () => {
  seedImageNodes(0, 2);
  const report = runDoctor(baseDeps());
  const stage = report.stages.find((s) => s.name === "imageVecConsistency")!;
  expect(stage.healthy).toBe(false);
  expect(stage.detail).toContain("전멸");
  expect(report.firstBlockingCause?.stage).toBe("imageVecConsistency");
  expect(report.firstBlockingCause?.fix).toContain("re-embed-images");
});

test("imageVecConsistency — 커버리지 절반 미만(1/3)이면 unhealthy(체계적 실패 추정)", () => {
  seedImageNodes(1, 2);
  const report = runDoctor(baseDeps());
  const stage = report.stages.find((s) => s.name === "imageVecConsistency")!;
  expect(stage.healthy).toBe(false);
  expect(stage.detail).toContain("절반 미만");
  expect(report.firstBlockingCause?.stage).toBe("imageVecConsistency");
});

test("imageVecConsistency — 커버리지 절반 이상(1/2)이면 healthy + 결측 건수를 detail 로 정직 노출", () => {
  seedImageNodes(1, 1);
  const report = runDoctor(baseDeps());
  const stage = report.stages.find((s) => s.name === "imageVecConsistency")!;
  expect(stage.healthy).toBe(true);
  expect(stage.detail).toContain("결측 1건");
  expect(report.firstBlockingCause).toBeNull();
});

test("imageVecConsistency — 대응 노드 없는 image_vec 행(고아 벡터)은 unhealthy", () => {
  // 정상 경로로는 못 만드는 방향(insert 는 노드와 한 트랜잭션·delete 는 트리거
  // 동기화)이라 SQL 로 직접 주입해 재현한다.
  db.run("INSERT INTO image_vec (node_id, embedding) VALUES (?, ?)", [
    9999,
    new Float32Array(SIGLIP2_DIM).fill(0.01),
  ]);
  const report = runDoctor(baseDeps());
  const stage = report.stages.find((s) => s.name === "imageVecConsistency")!;
  expect(stage.healthy).toBe(false);
  expect(stage.detail).toContain("고아 벡터");
});

test("의존 순서 — FTS·imageVec 동시 결함이면 앞선 ftsConsistency 가 firstBlockingCause", async () => {
  seedImageNodes(0, 1);
  const id = await store.addNode({ content: "FTS·이미지 동시 결함 글", sourceType: "user_explicit" });
  db.run(
    "INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, content) VALUES ('delete', ?, ?)",
    [id, "FTS·이미지 동시 결함 글"],
  );
  const report = runDoctor(baseDeps());
  expect(report.stages.find((s) => s.name === "ftsConsistency")!.healthy).toBe(false);
  expect(report.stages.find((s) => s.name === "imageVecConsistency")!.healthy).toBe(false);
  expect(report.firstBlockingCause?.stage).toBe("ftsConsistency");
});

test("embedder 차원 불일치 — settings 모델과 실제 로드 임베더가 어긋나면 embedder unhealthy", () => {
  const deps = baseDeps({
    getSettings: () => ({ db: { embeddingModel: "bge-m3" } }) as never,
  });
  // 실제 store.embedder.dimension(1024)과 다른 기대 차원을 만들 수 없으니(모델이
  // bge-m3 하나뿐 — factory.ts EMBEDDING_DIMENSIONS 단일 항목), 임베더 자체를
  // 다른 차원으로 바꿔치기해 불일치를 재현한다(순수 fixture — mock 클래스 아님,
  // dimension 게터만 override).
  const brokenStore = Object.create(store) as SqliteMemoryStore;
  Object.defineProperty(brokenStore, "embedder", {
    value: { ...embedder, dimension: 384 },
  });
  const report = runDoctor({ ...deps, store: brokenStore });
  const embedderStage = report.stages.find((s) => s.name === "embedder")!;
  expect(embedderStage.healthy).toBe(false);
  expect(embedderStage.detail).toContain("차원 불일치");
  expect(report.firstBlockingCause?.stage).toBe("embedder");
  // 빈 DB 재시작을 권하는 조치 문구는 첨부 파일 폴더를 DB 와 함께 옮기라는 안내(짝 표시)를 담는다.
  expect(report.firstBlockingCause?.fix).toContain("빈 DB 재시작이 필요한 모델 전환일 수 있음");
  expect(report.firstBlockingCause?.fix).toContain(
    "옛 기억을 나중에 되살릴 수 있게 남겨 두려면, DB 파일과 첨부 파일 폴더(설정 키 assets.dir(기본 data/assets) 또는 env BARA_ASSET_DIR)를 " +
      "함께 다른 곳으로 옮긴 뒤 다시 시작하세요. 두 곳에는 같은 짝 표시가 있어, 서버는 짝이 맞지 않는 폴더를 만나면 아무 파일도 지우지 않고 멈춥니다 — " +
      "DB 만 옮기고 폴더를 그대로 두면 새 DB 의 시작이 멈춥니다.",
  );
});

// 리뷰 High 2 — started_at 은 nowKst()/nowInZone() 이 쓰는 "설정 시간대 기준"
// 문자열로 저장된다(schema DEFAULT datetime('now','localtime') 는 v40 CREATE
// TABLE 문구일 뿐 실 INSERT 는 cleanup-runs-ledger.ts startRun 이 명시 채운다).
// doctor 의 ageMsSinceZoneString 도 같은 설정 시간대를 기준으로 파싱해야 하므로,
// 테스트도 UTC epoch 를 그대로 문자열화(new Date().toISOString())하지 않고
// nowInZone 과 대칭인 방식으로 "2시간 전"을 설정 시간대 문자열로 만든다.
function pastZoneString(msAgo: number): string {
  // nowInZone 과 같은 포맷("YYYY-MM-DD HH:MM:SS")을 얻기 위해 Date#toLocaleString
  // 을 같은 방식으로 쓴다(helpers.ts nowInZone 구현과 동일 호출 — 여기서는 시각만
  // 과거로 옮긴 Date 객체를 넣는다).
  return new Date(Date.now() - msAgo).toLocaleString("sv-SE", {
    timeZone: getConfiguredTimeZone(),
    hour12: false,
  });
}

test("cleanup — stalled run(1시간 초과 running) 은 unhealthy, 최근 running 은 healthy", () => {
  const oldTs = pastZoneString(2 * 60 * 60 * 1000);
  db.run(
    "INSERT INTO cleanup_runs (run_id, trigger, status, started_at) VALUES (?, 'manual', 'running', ?)",
    ["run-stalled", oldTs],
  );
  const report = runDoctor(baseDeps());
  const cleanupStage = report.stages.find((s) => s.name === "cleanup")!;
  expect(cleanupStage.healthy).toBe(false);
  expect(cleanupStage.detail).toContain("정체된 run");
  expect(report.firstBlockingCause?.stage).toBe("cleanup");
});

test("cleanup — 실제 startRun(nowKst) 이 남긴 running 행은 방금 시작이라 healthy(리뷰 High 2 회귀 방지)", () => {
  // cleanup-runs-ledger.ts startRun 이 실제로 쓰는 nowKst() 그대로 삽입 — 이
  // 값과 doctor 의 ageMsSinceZoneString 파싱이 어긋나면(9시간 오차) age 가
  // 음수 근처가 아니라 크게 튀어 stalled 오판이 난다.
  db.run(
    "INSERT INTO cleanup_runs (run_id, trigger, status, started_at) VALUES (?, 'manual', 'running', ?)",
    ["run-fresh", nowKst()],
  );
  const report = runDoctor(baseDeps());
  const cleanupStage = report.stages.find((s) => s.name === "cleanup")!;
  expect(cleanupStage.healthy).toBe(true);
  expect(cleanupStage.detail).toContain("정상 범위");
});

test("cleanup — 설정 시간대가 UTC 로 바뀌어도 방금 시작한 run 은 healthy(zone 대칭 계산 검증)", () => {
  setTimeZone("UTC");
  try {
    db.run(
      "INSERT INTO cleanup_runs (run_id, trigger, status, started_at) VALUES (?, 'manual', 'running', ?)",
      ["run-utc-fresh", nowKst()],
    );
    const report = runDoctor(baseDeps());
    const cleanupStage = report.stages.find((s) => s.name === "cleanup")!;
    expect(cleanupStage.healthy).toBe(true);
  } finally {
    // 전역 싱글턴이라 다른 테스트 파일로 새지 않게 원복(default Asia/Seoul).
    setTimeZone("Asia/Seoul");
  }
});

test("cleanup — 원장 비어 있으면 healthy(진행 중인 run 없음)", () => {
  const report = runDoctor(baseDeps());
  const cleanupStage = report.stages.find((s) => s.name === "cleanup")!;
  expect(cleanupStage.healthy).toBe(true);
  expect(cleanupStage.detail).toContain("없음");
});

// ── backup·disk — 파일 DB + 실 backupDir 필요 ────────────────────────────

test("backup 배선됨 + 유효 회차 0개 — backup unhealthy(빈 backupDir)", async () => {
  const { dir, file } = makeWalTempDir("bara-doctor-");
  tempDirs.push(dir);
  const fileDb = openMemoryDatabase(file, { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  const fileStore = new SqliteMemoryStore(fileDb, embedder);
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const report = runDoctor({
    ...baseDeps({ store: fileStore }),
    backup: { backupDir, dbPath: file, settingsFilePath: join(dir, "s.json"), appVersion: "0.1.0", schemaVersion: 1 },
  });
  const backupStage = report.stages.find((s) => s.name === "backup")!;
  expect(backupStage.healthy).toBe(false);
  expect(backupStage.detail).toContain("없음");
  fileDb.close();
});

test("backup 배선됨 + 최근 유효 회차 있음 — backup healthy", async () => {
  const { dir, file } = makeWalTempDir("bara-doctor-");
  tempDirs.push(dir);
  const fileDb = openMemoryDatabase(file, { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  const fileStore = new SqliteMemoryStore(fileDb, embedder);
  const backupDir = join(dir, "backups");
  const roundDir = join(backupDir, "round-1");
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(
    join(roundDir, "manifest.json"),
    JSON.stringify({
      timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
      epochMs: Date.now(),
      appVersion: "0.1.0",
      schemaVersion: 1,
      files: [],
      assets: [],
      durationMs: 1,
    }),
  );
  const report = runDoctor({
    ...baseDeps({ store: fileStore }),
    backup: { backupDir, dbPath: file, settingsFilePath: join(dir, "s.json"), appVersion: "0.1.0", schemaVersion: 1 },
  });
  const backupStage = report.stages.find((s) => s.name === "backup")!;
  expect(backupStage.healthy).toBe(true);
  fileDb.close();
});

test("backup — timestamp 문자열이 다른 zone 표기라도 epochMs 가 최근이면 healthy(리뷰 High 2 — 파싱 없는 산술 비교)", async () => {
  // manifest.timestamp 는 사람이 읽는 표시값일 뿐 판정에는 안 쓰인다는 것을 증명하는
  // 케이스 — 일부러 아주 오래된 것처럼 보이는 문자열을 넣고 epochMs 만 지금으로 둔다.
  const { dir, file } = makeWalTempDir("bara-doctor-");
  tempDirs.push(dir);
  const fileDb = openMemoryDatabase(file, { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  const fileStore = new SqliteMemoryStore(fileDb, embedder);
  const backupDir = join(dir, "backups");
  const roundDir = join(backupDir, "round-1");
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(
    join(roundDir, "manifest.json"),
    JSON.stringify({
      timestamp: "1999-01-01 00:00:00", // 일부러 오래된 표시 문자열 — epochMs 만 진실.
      epochMs: Date.now(),
      appVersion: "0.1.0",
      schemaVersion: 1,
      files: [],
      assets: [],
      durationMs: 1,
    }),
  );
  const report = runDoctor({
    ...baseDeps({ store: fileStore }),
    backup: { backupDir, dbPath: file, settingsFilePath: join(dir, "s.json"), appVersion: "0.1.0", schemaVersion: 1 },
  });
  const backupStage = report.stages.find((s) => s.name === "backup")!;
  expect(backupStage.healthy).toBe(true);
  fileDb.close();
});

test("disk — 파일 DB dataDir 이 존재·쓰기 가능하면 healthy", async () => {
  const { dir, file } = makeWalTempDir("bara-doctor-");
  tempDirs.push(dir);
  const fileDb = openMemoryDatabase(file, { embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"] });
  const fileStore = new SqliteMemoryStore(fileDb, embedder);
  const report = runDoctor({
    ...baseDeps({ store: fileStore }),
    backup: { backupDir: join(dir, "backups"), dbPath: file, settingsFilePath: join(dir, "s.json"), appVersion: "0.1.0", schemaVersion: 1 },
  });
  const diskStage = report.stages.find((s) => s.name === "disk")!;
  expect(diskStage.healthy).toBe(true);
  expect(diskStage.detail).toContain("GB");
  fileDb.close();
});

// ── 예외 흡수 — 계약 3 ────────────────────────────────────────────────────

test("한 단계 예외는 그 단계만 unhealthy 로 흡수 — 전체 진단이 죽지 않는다", () => {
  const brokenDb = {
    query: () => {
      throw new Error("DB 강제 예외(테스트)");
    },
  };
  const brokenStore = Object.create(store) as SqliteMemoryStore;
  Object.defineProperty(brokenStore, "getRawDb", {
    value: () => brokenDb,
  });
  const report = runDoctor(baseDeps({ store: brokenStore }));
  expect(report.stages.length).toBe(8);
  expect(report.stages[0]!.name).toBe("db");
  expect(report.stages[0]!.healthy).toBe(false);
  expect(report.stages[0]!.detail).toContain("DB 강제 예외");
  expect(report.firstBlockingCause?.stage).toBe("db");
});
